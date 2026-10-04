import { createClient } from '@supabase/supabase-js';
import { sendPushEvent } from '../lib/push';

async function main() {
  const eventKey = process.env.TEST_PUSH_EVENT_KEY ?? '';
  const title = process.env.TEST_PUSH_TITLE ?? '';
  const body = process.env.TEST_PUSH_BODY ?? '';
  if (!/^manual:[A-Za-z0-9:_-]{1,100}$/.test(eventKey) ||
      !title || title.length > 80 || !body || body.length > 300) {
    throw new Error('테스트 푸시 입력이 올바르지 않습니다.');
  }

  await sendPushEvent(eventKey, { title, body, tag: eventKey });

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { data, error } = await db.from('fp_push_events')
    .select('sent_count, failed_count')
    .eq('event_key', eventKey)
    .maybeSingle();
  if (error || !data || data.sent_count < 1) {
    throw new Error(`테스트 푸시 전송 확인 실패: ${error?.message ?? '수신 서버가 수락한 구독 없음'}`);
  }
  console.log(`[push] 공급자 수락 ${data.sent_count}건, 실패 ${data.failed_count}건`);
}

main().catch((error) => {
  console.error('[push] 수동 테스트 실패:', error);
  process.exitCode = 1;
});
