import { NextRequest, NextResponse } from 'next/server';
import { isAppAuthorized } from '@/lib/api-auth';
import {
  deletePushSubscription,
  parsePushSubscription,
  publicPushKey,
  savePushSubscription,
} from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

function authorized(req: NextRequest): boolean {
  return isAppAuthorized(req) && req.headers.get('origin') === req.nextUrl.origin;
}

export async function GET(req: NextRequest) {
  if (!isAppAuthorized(req)) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401, headers: noStore });
  }
  return NextResponse.json({ publicKey: publicPushKey() }, { headers: noStore });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: '허용되지 않은 요청입니다.' }, { status: 403, headers: noStore });
  }
  if (!publicPushKey()) {
    return NextResponse.json({ error: '푸시 서버 설정이 필요합니다.' }, { status: 503, headers: noStore });
  }
  try {
    const subscription = parsePushSubscription(await req.json());
    await savePushSubscription(subscription);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) {
    const message = error instanceof SyntaxError ? '요청 형식이 올바르지 않습니다.'
      : error instanceof Error ? error.message : '알림 구독 저장에 실패했습니다.';
    const status = message.startsWith('알림 구독 저장 실패') ? 500 : 400;
    return NextResponse.json({ error: message }, { status, headers: noStore });
  }
}

export async function DELETE(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: '허용되지 않은 요청입니다.' }, { status: 403, headers: noStore });
  }
  try {
    const body = await req.json();
    const endpoint = body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || !endpoint.startsWith('https://')) {
      return NextResponse.json({ error: '알림 주소가 올바르지 않습니다.' }, { status: 400, headers: noStore });
    }
    await deletePushSubscription(endpoint);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) {
    const message = error instanceof Error ? error.message : '알림 구독 해제에 실패했습니다.';
    return NextResponse.json({ error: message }, { status: 500, headers: noStore });
  }
}
