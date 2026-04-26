import { NextRequest } from 'next/server';
import { checkCarStatuses } from '@/lib/check-status';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { plates, settings } = await req.json();

  const url = settings?.url || process.env.NICEPARK_URL || '';
  const adminId = settings?.id || process.env.NICEPARK_ID || '';
  const adminPw = settings?.pw || process.env.NICEPARK_PW || '';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await checkCarStatuses(url, adminId, adminPw, plates, (data) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        });
      } catch (e) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`)
        );
      }
      controller.enqueue(encoder.encode('data: {"done":true}\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
