import { NextRequest, NextResponse } from 'next/server';
import { isAppAuthorized } from '@/lib/api-auth';
import { sendTestPush } from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isAppAuthorized(req) || req.headers.get('origin') !== req.nextUrl.origin) {
    return NextResponse.json({ error: '허용되지 않은 요청입니다.' }, { status: 403 });
  }
  try {
    const body = await req.json();
    const endpoint = body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || !endpoint.startsWith('https://')) {
      return NextResponse.json({ error: '알림 주소가 올바르지 않습니다.' }, { status: 400 });
    }
    await sendTestPush(endpoint);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[push] 테스트 알림 실패:', error);
    return NextResponse.json({ error: '테스트 알림을 보내지 못했습니다.' }, { status: 502 });
  }
}
