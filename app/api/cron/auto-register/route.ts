import { timingSafeEqual, randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkCarStatuses } from '@/lib/check-status';
import { registerCarsHttp } from '@/lib/register-http';
import type { CarInput } from '@/lib/register';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const incoming = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (incoming.length !== expected.length) return false;
  return timingSafeEqual(incoming, expected);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const START_MS = Date.now();
  const BUDGET_MS = 45_000; // maxDuration(60s) - 15s 마진

  // 서버 전용 route — anon key 대신 service role key 사용 (RLS 우회)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: rows, error: dbErr } = await supabase
    .from('fp_cars')
    .select('*')
    .order('created_at');

  if (dbErr || !rows) {
    return NextResponse.json({ error: `DB 조회 실패: ${dbErr?.message}` }, { status: 500 });
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
  url = url || process.env.NICEPARK_URL || '';
  adminId = adminId || process.env.NICEPARK_ID || '';
  adminPw = adminPw || process.env.NICEPARK_PW || '';

  if (!url || !adminId || !adminPw) {
    return NextResponse.json({ error: '주차 시스템 설정 없음 (url/id/pw)' }, { status: 500 });
  }

  const tcRow = rows.find((r) => r.plate === '__ticketchoices__');
  let choiceMap: Record<string, string> = {};
  if (tcRow?.label) { try { choiceMap = JSON.parse(tcRow.label); } catch {} }

  const SPECIAL = new Set(['__settings__', '__ticketchoices__']);
  const carRows = rows.filter((r) => !SPECIAL.has(r.plate));
  if (carRows.length === 0) {
    return NextResponse.json({ message: '등록된 차량 없음', registered: [] });
  }

  const plates = carRows.map((r) => r.plate);
  const runId = randomUUID();

  // 하루 1회 실행 보장 — fp_logs unique index로 분산 뮤텍스
  // DDL (Supabase SQL Editor에서 1회 실행):
  //   CREATE UNIQUE INDEX fp_logs_cron_lock_date
  //     ON fp_logs (plate, (created_at::date))
  //     WHERE plate = '__cron_lock__';
  const { error: lockErr } = await supabase.from('fp_logs').insert({
    run_id: runId,
    plate: '__cron_lock__',
    status: 'running',
    message: 'cron lock',
  });
  if (lockErr) {
    return NextResponse.json(
      { error: '중복 실행 방지 — 이미 실행 중인 cron이 있습니다', code: lockErr.code },
      { status: 409 }
    );
  }

  try {
    // ── 1단계: 현황 조회 ──────────────────────────────────────────────
    const statusMap: Record<string, { status: string; message: string }> = {};

    try {
      await checkCarStatuses(url, adminId, adminPw, plates, (data) => {
        statusMap[data.plate] = { status: data.status, message: data.message };
      });
    } catch (e) {
      for (const plate of plates) {
        statusMap[plate] = { status: 'error', message: `checkCarStatuses threw: ${String(e).slice(0, 120)}` };
      }
      return NextResponse.json({ error: '현황 조회 중 예외 발생', statusMap }, { status: 500 });
    }

    // 조회 오류 차량 fp_logs 기록
    const checkErrors = Object.entries(statusMap)
      .filter(([, v]) => v.status === 'error')
      .map(([plate, v]) => ({
        run_id: runId,
        plate,
        status: 'check_error',
        message: v.message,
      }));
    if (checkErrors.length > 0) {
      const { error: ceErr } = await supabase.from('fp_logs').insert(checkErrors);
      if (ceErr) console.error('[cron] check_error 로그 저장 실패:', ceErr.message);
    }

    // no_quota 차량 로그 기록 (운영자 가시성)
    const noQuotaEntries = carRows
      .filter((r) => statusMap[r.plate]?.status === 'no_quota')
      .map((r) => ({
        run_id: runId,
        plate: r.plate,
        status: 'no_quota',
        message: statusMap[r.plate].message,
      }));
    if (noQuotaEntries.length > 0) {
      const { error: nqErr } = await supabase.from('fp_logs').insert(noQuotaEntries);
      if (nqErr) console.error('[cron] no_quota 로그 저장 실패:', nqErr.message);
    }

    const toRegister: CarInput[] = carRows
      .filter((r) => statusMap[r.plate]?.status === 'entered')
      .map((r) => ({
        plate: r.plate,
        label: r.label ?? r.plate,
        ticketChoice: choiceMap[r.id] ?? '00005',
      }));

    if (toRegister.length === 0) {
      return NextResponse.json({
        message: checkErrors.length > 0
          ? `입차 차량 없음 — 등록 생략 (조회 오류 ${checkErrors.length}건)`
          : '입차 차량 없음 — 등록 생략',
        statusMap,
        statusErrors: checkErrors.length,
        registered: [],
      });
    }

    // 예산 점검 — 등록 단계 진입 전
    if (Date.now() - START_MS > BUDGET_MS - 15_000) {
      return NextResponse.json({
        message: '예산 초과 — 현황 조회 후 등록 생략',
        statusMap,
        statusErrors: checkErrors.length,
        registered: [],
        elapsedMs: Date.now() - START_MS,
      });
    }

    // ── 2단계: 무료주차 등록 ──────────────────────────────────────────
    const logEntries: { plate: string; status: string; message: string }[] = [];

    try {
      await registerCarsHttp(url, adminId, adminPw, toRegister, {}, (data) => {
        if (!['pending', 'running'].includes(data.status)) {
          logEntries.push({ plate: data.plate, status: data.status, message: data.message });
        }
      });
    } catch (e) {
      for (const car of toRegister) {
        if (!logEntries.find((l) => l.plate === car.plate)) {
          logEntries.push({
            plate: car.plate,
            status: 'error',
            message: `registerCarsHttp threw: ${String(e).slice(0, 120)}`,
          });
        }
      }
      if (logEntries.length > 0) {
        await supabase.from('fp_logs').insert(
          logEntries.map((l) => ({ run_id: runId, plate: l.plate, status: l.status, message: l.message }))
        );
      }
      return NextResponse.json({ error: '등록 중 예외 발생', runId, logEntries }, { status: 500 });
    }

    // ── 3단계: fp_logs 저장 ───────────────────────────────────────────
    let logInsertError: string | null = null;
    if (logEntries.length > 0) {
      const { error: insertErr } = await supabase.from('fp_logs').insert(
        logEntries.map((l) => ({
          run_id: runId,
          plate: l.plate,
          status: l.status,
          message: l.message,
        }))
      );
      if (insertErr) {
        console.error('[cron] fp_logs 저장 실패:', insertErr.message);
        logInsertError = insertErr.message;
      }
    }

    return NextResponse.json({
      runId,
      statusMap,
      statusErrors: checkErrors.length,
      registered: logEntries,
      elapsedMs: Date.now() - START_MS,
      ...(logInsertError ? { logInsertError } : {}),
    });

  } finally {
    // 뮤텍스 해제
    await supabase
      .from('fp_logs')
      .update({ status: 'done' })
      .eq('run_id', runId)
      .eq('plate', '__cron_lock__');
  }
}
