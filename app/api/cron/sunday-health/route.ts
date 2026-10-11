import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { classifyCronRun } from '@/lib/cron-watchdog';
import { kstDate, sendPushEvent } from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret ?? ''}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  if (value('weekday') !== 'Sun' || minutes < 10 * 60 + 30) {
    return NextResponse.json({ skipped: '일요일 10:30 이후에 확인합니다.' });
  }
  try {
    const date = kstDate(now);
    const start = `${date}T00:00:00+09:00`;
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await db.from('fp_logs').select('status')
      .eq('plate', '__run__').gte('created_at', start).lt('created_at', end).limit(100);
    if (error) throw new Error(`자동등록 실행 기록 조회 실패: ${error.message}`);
    const state = classifyCronRun((data ?? []).map((row) => row.status));
    const body = state === 'ok'
      ? '오늘 자동등록 프로그램이 정상 실행됐습니다. 정오에 처리 결과를 다시 알려드립니다.'
      : state === 'missing'
        ? '오늘 자동등록 실행 기록이 아직 없습니다. 보조 감시가 복구를 확인합니다.'
        : state === 'unfinished'
          ? '자동등록이 시작됐지만 아직 완료되지 않았습니다. 보조 감시가 확인합니다.'
          : '자동등록 실패 기록이 있습니다. 보조 감시가 확인합니다.';
    await sendPushEvent(`health:${date}`, {
      title: state === 'ok' ? '무료주차 자동등록 정상' : '무료주차 자동등록 확인 필요',
      body, tag: `health-${date}`,
    });
    return NextResponse.json({ date, state });
  } catch (error) {
    console.error('[health] 상태 알림 실패:', error);
    return NextResponse.json({ error: '상태 알림에 실패했습니다.' }, { status: 500 });
  }
}
