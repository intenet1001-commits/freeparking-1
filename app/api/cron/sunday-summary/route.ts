import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { checkCarStatuses, type CarStatusResult } from '@/lib/check-status';
import { kstDate, sendPushEvent } from '@/lib/push';
import { buildSundaySummary, type SummaryLog } from '@/lib/sunday-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const actual = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const now = new Date();
  if (new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Seoul' }).format(now) !== 'Sun') {
    return NextResponse.json({ skipped: '일요일이 아닙니다.' });
  }

  try {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const date = kstDate(now);
    const nextMidnight = new Date(Date.parse(`${date}T00:00:00+09:00`) + 24 * 60 * 60 * 1000).toISOString();
    const [carsResult, logsResult] = await Promise.all([
      db.from('fp_cars').select('plate, label').order('created_at'),
      db.from('fp_logs').select('plate, status')
        .gte('created_at', `${date}T00:00:00+09:00`)
        .lt('created_at', nextMidnight)
        .order('created_at', { ascending: false })
        .limit(1000),
    ]);
    if (carsResult.error || logsResult.error) {
      throw new Error(carsResult.error?.message || logsResult.error?.message || 'DB 조회 실패');
    }
    const allRows = carsResult.data ?? [];
    const cars = allRows.filter((row) => row.plate !== '__settings__' && row.plate !== '__ticketchoices__');
    const settingsRow = allRows.find((row) => row.plate === '__settings__');
    let saved: { url?: string; id?: string; pw?: string } = {};
    try { saved = JSON.parse(settingsRow?.label ?? '{}'); } catch { /* use environment */ }
    const url = process.env.NICEPARK_URL || saved.url || '';
    const id = process.env.NICEPARK_ID || saved.id || '';
    const pw = process.env.NICEPARK_PW || saved.pw || '';
    const plates = cars.map((car) => car.plate);
    const statuses: CarStatusResult[] = [];
    if (plates.length && url && id && pw) {
      try {
        await checkCarStatuses(url, id, pw, plates, (status) => statuses.push(status));
      } catch (error) {
        console.error('[summary] 현황 조회 실패:', error);
      }
    }
    // 운영 환경 설정 조회가 모두 실패하면, GitHub 자동등록에 쓰인 서버 저장 설정으로 재확인한다.
    if (plates.length && (statuses.length === 0 || statuses.every((status) => status.status === 'error')) &&
        saved.url && saved.id && saved.pw &&
        (saved.url !== url || saved.id !== id || saved.pw !== pw)) {
      statuses.length = 0;
      try {
        await checkCarStatuses(saved.url, saved.id, saved.pw, plates, (status) => statuses.push(status));
      } catch (error) {
        console.error('[summary] 보조 설정 현황 조회 실패:', error);
      }
    }
    const summary = buildSundaySummary(plates, statuses, (logsResult.data ?? []) as SummaryLog[]);
    const body = plates.length ? summary.body : '등록된 차량이 없습니다.';
    await sendPushEvent(`summary:${date}`, {
      title: '일요일 12시 주차 등록 현황', body, tag: `summary-${date}`,
    });
    return NextResponse.json({ date, body, checked: statuses.length, total: plates.length });
  } catch (error) {
    console.error('[summary] 알림 실패:', error);
    return NextResponse.json({ error: '일요일 현황 알림을 보내지 못했습니다.' }, { status: 500 });
  }
}
