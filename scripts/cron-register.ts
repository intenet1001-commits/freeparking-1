import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { checkCarStatuses } from '../lib/check-status';
import { registerCarsHttp } from '../lib/register-http';
import type { CarInput } from '../lib/register';

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

  if (carRows.length === 0) {
    console.log('[cron] 등록된 차량 없음 — 종료');
    return;
  }

  const plates = carRows.map((r) => r.plate);
  const runId = randomUUID();

  // 분산 뮤텍스 — 하루 1회 실행 보장
  const { error: lockErr } = await supabase.from('fp_logs').insert({
    run_id: runId, plate: '__cron_lock__', status: 'running', message: 'cron lock',
  });
  if (lockErr) {
    console.log('[cron] 중복 실행 방지 — 이미 실행 중:', lockErr.code);
    return;
  }

  try {
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
      return;
    }

    // 예산 점검
    if (Date.now() - START_MS > BUDGET_MS - 30_000) {
      console.error('[cron] 예산 초과 — 등록 생략');
      process.exit(1);
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
      if (insertErr) console.error('[cron] fp_logs 저장 실패:', insertErr.message);
    }

    const failed = logEntries.filter((l) => l.status === 'error' || l.status === 'failed');
    const ok = logEntries.filter((l) => l.status === 'success');
    console.log(`[cron] 완료 [${elapsed()}] — 성공 ${ok.length}건, 실패 ${failed.length}건`);
    if (failed.length > 0) process.exitCode = 1;

  } finally {
    await supabase.from('fp_logs')
      .update({ status: 'done' })
      .eq('run_id', runId)
      .eq('plate', '__cron_lock__');
  }
}

main().catch((e) => { console.error('[cron] 치명적 오류:', e); process.exit(1); });
