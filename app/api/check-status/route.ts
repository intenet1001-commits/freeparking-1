import { NextRequest, NextResponse } from 'next/server';
import { checkCarStatuses } from '@/lib/check-status';
import { isAppAuthorized } from '@/lib/api-auth';
import { kstHour, sendPushEvent } from '@/lib/push';
import {
  parseParkingSettings,
  parsePlates,
  RequestValidationError,
} from '@/lib/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!isAppAuthorized(req)) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  let plates;
  let settings;
  try {
    plates = parsePlates(body.plates);
    settings = parseParkingSettings(body.settings);
  } catch (error) {
    const message = error instanceof RequestValidationError ? error.message : '요청값을 확인해주세요.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      req.signal.addEventListener('abort', () => { closed = true; }, { once: true });
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // 프록시/모바일 버퍼링 방지: 연결 즉시 SSE 주석 1회 전송
      if (!closed) controller.enqueue(encoder.encode(': ping\n\n'));
      let errors = 0;
      try {
        await checkCarStatuses(settings.url, settings.id, settings.pw, plates, (data) => {
          if (data.status === 'error') errors += 1;
          send(data);
        });
      } catch {
        errors += 1;
        send({ error: '현황 조회 중 서버 오류가 발생했습니다.' });
      }
      if (errors) {
        try {
          await sendPushEvent(`error:status:${kstHour()}`, {
            title: '주차 현황 조회 오류',
            body: `${errors}건의 조회 오류가 발생했습니다. 앱에서 현황을 확인해주세요.`,
            tag: 'parking-status-error',
          });
        } catch (error) { console.error('[status] 오류 알림 실패:', error); }
      }
      send({ done: true });
      if (!closed) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
