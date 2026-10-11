import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { classifyCronRun } from '@/lib/cron-watchdog';
import { kstDate, pushConfigured, sendPushEvent } from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', timeZone: 'Asia/Seoul',
  }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Seoul',
  }).format(now));
  if (weekday !== 'Sun' || hour < 11) {
    return NextResponse.json({ skipped: '일요일 오전 11시 이후에 확인합니다.' });
  }

  try {
    const date = kstDate(now);
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const start = `${date}T00:00:00+09:00`;
    const end = new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db.from('fp_logs').select('status')
      .eq('plate', '__run__')
      .gte('created_at', start)
      .lt('created_at', end)
      .limit(100);
    if (error) throw new Error(`자동등록 실행 기록 조회 실패: ${error.message}`);

    const state = classifyCronRun((data ?? []).map((row) => row.status));
    if (state !== 'ok') {
      if (!pushConfigured()) throw new Error('푸시 서버 설정이 필요합니다.');
      const body = state === 'missing'
        ? '오늘 오전 자동등록 실행 기록이 없습니다. 주차 현황을 확인해주세요.'
        : state === 'failed'
          ? '오늘 자동등록 실패 기록이 있습니다. 주차 현황을 확인해주세요.'
          : '오늘 자동등록이 시작됐지만 완료 기록이 없습니다. 현황을 확인해주세요.';
      await sendPushEvent(`error:registration-watchdog:${date}`, {
        title: '무료주차 자동등록 확인 필요',
        body,
        tag: `registration-watchdog-${date}`,
      });
    }
    return NextResponse.json({ date, state });
  } catch (error) {
    console.error('[watchdog] 자동등록 감시 실패:', error);
    return NextResponse.json({ error: '자동등록 감시에 실패했습니다.' }, { status: 500 });
  }
}
