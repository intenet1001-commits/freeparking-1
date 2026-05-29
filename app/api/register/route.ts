import { NextRequest } from 'next/server';
import { registerCarsHttp } from '@/lib/register-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { cars, settings, selectedJson } = await req.json();

  const url = settings?.url || process.env.NICEPARK_URL || '';
  const adminId = settings?.id || process.env.NICEPARK_ID || '';
  const adminPw = settings?.pw || process.env.NICEPARK_PW || '';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // 프록시/모바일 버퍼링 방지: 연결 즉시 SSE 주석 1회 전송해 스트림을 연다
      controller.enqueue(encoder.encode(': ping\n\n'));
      const errors: string[] = [];
      try {
        const result = await registerCarsHttp(url, adminId, adminPw, cars, selectedJson || {}, (data) => {
          if (data.status === 'failed') errors.push(`${data.plate}: ${data.message}`);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        });
        if (!result.success) errors.push(...result.errors.filter(e => !errors.includes(e)));
      } catch (e) {
        const msg = String(e);
        errors.push(msg);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
        );
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, errors })}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
