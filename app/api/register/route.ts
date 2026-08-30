import { NextRequest, NextResponse } from 'next/server';
import { registerCarsHttp } from '@/lib/register-http';
import { isAppAuthorized } from '@/lib/api-auth';
import {
  parseCars,
  parseParkingSettings,
  parseSelectedJson,
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

  let cars;
  let settings;
  let selectedJson;
  try {
    cars = parseCars(body.cars);
    settings = parseParkingSettings(body.settings);
    selectedJson = parseSelectedJson(body.selectedJson, cars);
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
      // 프록시/모바일 버퍼링 방지: 연결 즉시 SSE 주석 1회 전송해 스트림을 연다
      if (!closed) controller.enqueue(encoder.encode(': ping\n\n'));
      const errors: string[] = [];
      try {
        const result = await registerCarsHttp(settings.url, settings.id, settings.pw, cars, selectedJson, (data) => {
          if (data.status === 'failed') errors.push(`${data.plate}: ${data.message}`);
          send(data);
        });
        if (!result.success) errors.push(...result.errors.filter(e => !errors.includes(e)));
      } catch {
        const msg = '등록 처리 중 서버 오류가 발생했습니다.';
        errors.push(msg);
        send({ error: msg });
      }
      send({ done: true, errors });
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
