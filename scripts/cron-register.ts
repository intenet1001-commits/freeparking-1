import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { checkCarStatuses } from '../lib/check-status';
import { registerCarsHttp } from '../lib/register-http';
import type { CarInput } from '../lib/register';
import { kstHour, sendPushEvent } from '../lib/push';

const BUDGET_MS = 240_000; // 4분 (GitHub Actions timeout-minutes: 5)
const START_MS = Date.now();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function elapsed() {
  return `${Math.round((Date.now() - START_MS) / 1000)}s`;
}

async function main() {
  console.log('[cron] 자동등록 시작');

  const { data: rows, error: dbErr } = await supabase
    .from('fp_cars')
    .select('*')
    .order('created_at');

  if (dbErr || !rows) {
    console.error('[cron] DB 조회 실패:', dbErr?.message);
    process.exit(1);
  }

  const settingsRow = rows.find((r) => r.plate === '__settings__');
  let url = '', adminId = '', adminPw = '';
  if (settingsRow?.label) {
    try {
      const s = JSON.parse(settingsRow.label);
      url = s.url ?? '';
      adminId = s.id ?? '';
      adminPw = s.pw ?? '';
    } catch {}
  }

  if (!url || !adminId || !adminPw) {
    console.error('[cron] 설정 없음 (url/id/pw)');
    process.exit(1);
  }

  const tcRow = rows.find((r) => r.plate === '__ticketchoices__');
  let choiceMap: Record<string, string> = {};
  if (tcRow?.label) { try { choiceMap = JSON.parse(tcRow.label); } catch {} }

  const SPECIAL = new Set(['__settings__', '__ticketchoices__']);
  const carRows = rows.filter((r) => !SPECIAL.has(r.plate));
  const runId = randomUUID();
  const { error: startError } = await supabase.from('fp_logs').insert({
    run_id: runId, plate: '__run__', status: 'running', message: '자동 실행 시작',
  });
  if (startError) console.error('[cron] 실행 시작 기록 실패:', startError.message);

  async function finish(message: string, hasError: boolean) {
    const { error: finishError } = await supabase.from('fp_logs')
      .update({ status: hasError ? 'failed' : 'done', message })
      .eq('run_id', runId).eq('plate', '__run__');
    if (finishError) console.error('[cron] 실행 종료 기록 실패:', finishError.message);
    if (hasError) {
      try {
        await sendPushEvent(`error:cron:${kstHour()}`, {
          title: '무료주차 자동등록 오류',
          body: `${message}. 앱에서 현황을 확인해주세요.`,
          tag: 'parking-cron-error',
        });
      } catch (error) { console.error('[cron] 오류 알림 실패:', error); }
    }
  }

  if (carRows.length === 0) {
    console.log('[cron] 등록된 차량 없음 — 종료');
    await finish('등록된 차량 없음', false);
    return;
  }

  const plates = carRows.map((r) => r.plate);

  // 겹침 실행 방지는 workflow의 concurrency(group: weekly-parking)가 담당.
  // 하루 여러 차례 폴링하므로 하루 1회 제한 뮤텍스는 두지 않는다 — 등록은
  // 멱등(이미 처리된 차량은 'skipped')이라 재실행 자체는 안전하다.

  // ── 1단계: 현황 조회
  console.log(`[cron] 현황 조회 시작 (${plates.length}대)`);
  const statusMap: Record<string, { status: string; message: string }> = {};

  try {
    await checkCarStatuses(url, adminId, adminPw, plates, (data) => {
      statusMap[data.plate] = { status: data.status, message: data.message };
      console.log(`  ${data.plate}: ${data.status} — ${data.message}`);
    });
  } catch (e) {
    console.error('[cron] 현황 조회 예외:', e);
    for (const plate of plates) {
      statusMap[plate] = { status: 'error', message: String(e).slice(0, 120) };
    }
  }

  // check_error / no_quota 로그
  const errorEntries = Object.entries(statusMap)
    .filter(([, v]) => v.status === 'error' || v.status === 'no_quota')
    .map(([plate, v]) => ({ run_id: `${runId}-status`, plate, status: v.status, message: v.message }));
  if (errorEntries.length > 0) {
    await supabase.from('fp_logs').insert(errorEntries);
  }

  const toRegister: CarInput[] = carRows
    .filter((r) => statusMap[r.plate]?.status === 'entered')
    .map((r) => ({
      plate: r.plate,
      label: r.label ?? r.plate,
      ticketChoice: choiceMap[r.id] ?? '00005',
    }));

  if (toRegister.length === 0) {
    console.log('[cron] 입차 차량 없음 — 등록 생략');
    await finish(errorEntries.some((entry) => entry.status === 'error')
      ? `현황 조회 오류 ${errorEntries.filter((entry) => entry.status === 'error').length}건`
      : '입차 차량 없음', errorEntries.some((entry) => entry.status === 'error'));
    return;
  }

  // 예산 점검
  if (Date.now() - START_MS > BUDGET_MS - 30_000) {
    console.error('[cron] 예산 초과 — 등록 생략');
    await finish('시간 한도로 등록 생략', true);
    process.exitCode = 1;
    return;
  }

  // ── 2단계: 무료주차 등록
  console.log(`[cron] 등록 시작 (${toRegister.length}대) [${elapsed()}]`);
  const logEntries: { plate: string; status: string; message: string }[] = [];

  try {
    await registerCarsHttp(url, adminId, adminPw, toRegister, {}, (data) => {
      if (!['pending', 'running'].includes(data.status)) {
        logEntries.push({ plate: data.plate, status: data.status, message: data.message });
        console.log(`  ${data.plate}: ${data.status} — ${data.message}`);
      }
    });
  } catch (e) {
    console.error('[cron] 등록 예외:', e);
    for (const car of toRegister) {
      if (!logEntries.find((l) => l.plate === car.plate)) {
        logEntries.push({ plate: car.plate, status: 'error', message: String(e).slice(0, 120) });
      }
    }
    process.exitCode = 1;
  }

  if (logEntries.length > 0) {
    const { error: insertErr } = await supabase.from('fp_logs').insert(
      logEntries.map((l) => ({ run_id: runId, plate: l.plate, status: l.status, message: l.message }))
    );
    if (insertErr) {
      console.error('[cron] fp_logs 저장 실패:', insertErr.message);
      await finish('등록 결과 저장 실패', true);
      process.exitCode = 1;
      return;
    }
  }

  const failed = logEntries.filter((l) => l.status === 'error' || l.status === 'failed');
  const ok = logEntries.filter((l) => l.status === 'success');
  console.log(`[cron] 완료 [${elapsed()}] — 성공 ${ok.length}건, 실패 ${failed.length}건`);
  const statusErrors = errorEntries.filter((entry) => entry.status === 'error').length;
  const hasError = failed.length > 0 || statusErrors > 0;
  await finish(hasError ? `등록 실패 ${failed.length}건 · 조회 오류 ${statusErrors}건`
    : `등록 성공 ${ok.length}건`, hasError);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('[cron] 치명적 오류:', e);
  try {
    await sendPushEvent(`error:cron:${kstHour()}`, {
      title: '무료주차 자동등록 오류',
      body: '자동 실행 중 오류가 발생했습니다. 앱에서 현황을 확인해주세요.',
      tag: 'parking-cron-error',
    });
  } catch (error) { console.error('[cron] 오류 알림 실패:', error); }
  process.exitCode = 1;
});
