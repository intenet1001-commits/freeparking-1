import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkCarStatuses } from '@/lib/check-status';
import { registerCarsHttp } from '@/lib/register-http';
import type { CarInput } from '@/lib/register';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Vercel Cron은 Authorization: Bearer <CRON_SECRET> 헤더를 자동으로 주입한다.
// CRON_SECRET 환경 변수가 없거나 불일치하면 401 반환.
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Supabase admin 클라이언트 (서버 전용)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // fp_cars 전체 로드 (설정 + 권종맵 + 차량 목록)
  const { data: rows, error: dbErr } = await supabase
    .from('fp_cars')
    .select('*')
    .order('created_at');

  if (dbErr || !rows) {
    return NextResponse.json({ error: `DB 조회 실패: ${dbErr?.message}` }, { status: 500 });
  }

  // 설정 파싱
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
  // 환경 변수 폴백
  url = url || process.env.NICEPARK_URL || '';
  adminId = adminId || process.env.NICEPARK_ID || '';
  adminPw = adminPw || process.env.NICEPARK_PW || '';

  if (!url || !adminId || !adminPw) {
    return NextResponse.json({ error: '주차 시스템 설정 없음 (url/id/pw)' }, { status: 500 });
  }

  // 권종 선택 맵 파싱 ({ carId: dCode })
  const tcRow = rows.find((r) => r.plate === '__ticketchoices__');
  let choiceMap: Record<string, string> = {};
  if (tcRow?.label) { try { choiceMap = JSON.parse(tcRow.label); } catch {} }

  // 실제 차량 목록 (특수 행 제외)
  const SPECIAL = new Set(['__settings__', '__ticketchoices__']);
  const carRows = rows.filter((r) => !SPECIAL.has(r.plate));
  if (carRows.length === 0) {
    return NextResponse.json({ message: '등록된 차량 없음', registered: [] });
  }

  const plates = carRows.map((r) => r.plate);

  // ── 1단계: 현황 조회 ──────────────────────────────────────────────
  const statusMap: Record<string, { status: string; message: string }> = {};
  await checkCarStatuses(url, adminId, adminPw, plates, (data) => {
    statusMap[data.plate] = { status: data.status, message: data.message };
  });

  // 입차 중(등록 전) 차량만 등록 대상
  const toRegister: CarInput[] = carRows
    .filter((r) => statusMap[r.plate]?.status === 'entered')
    .map((r) => ({
      plate: r.plate,
      label: r.label ?? r.plate,
      ticketChoice: choiceMap[r.id] ?? '00005', // 종일권 기본
    }));

  if (toRegister.length === 0) {
    return NextResponse.json({
      message: '입차 차량 없음 — 등록 생략',
      statusMap,
      registered: [],
    });
  }

  // ── 2단계: 무료주차 등록 ──────────────────────────────────────────
  const runId = `cron-${Date.now()}`;
  const logEntries: { plate: string; status: string; message: string }[] = [];

  await registerCarsHttp(url, adminId, adminPw, toRegister, {}, (data) => {
    if (!['pending', 'running'].includes(data.status)) {
      logEntries.push({ plate: data.plate, status: data.status, message: data.message });
    }
  });

  // ── 3단계: fp_logs 저장 ───────────────────────────────────────────
  if (logEntries.length > 0) {
    const { error: insertErr } = await supabase.from('fp_logs').insert(
      logEntries.map((l) => ({
        run_id: runId,
        plate: l.plate,
        status: l.status,
        message: l.message,
      }))
    );
    if (insertErr) console.error('[cron] fp_logs 저장 실패:', insertErr.message);
  }

  return NextResponse.json({
    runId,
    statusMap,
    registered: logEntries,
  });
}
