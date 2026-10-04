import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import webpush, { type PushSubscription } from 'web-push';

export type PushMessage = { title: string; body: string; tag: string };

type StoredSubscription = {
  endpoint_hash: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export function kstDate(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function kstHour(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 13);
}

export function pushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export function publicPushKey(): string | null {
  return pushConfigured() ? process.env.VAPID_PUBLIC_KEY! : null;
}

function adminClient() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('푸시 저장소 설정이 없습니다.');
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function subscriptionHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

export function parsePushSubscription(value: unknown): PushSubscription {
  if (!value || typeof value !== 'object') throw new Error('알림 구독 정보가 올바르지 않습니다.');
  const input = value as Record<string, unknown>;
  const keys = input.keys as Record<string, unknown> | undefined;
  const endpoint = input.endpoint;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 ||
      typeof p256dh !== 'string' || typeof auth !== 'string' ||
      !/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(auth)) {
    throw new Error('알림 구독 정보가 올바르지 않습니다.');
  }
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('알림 주소가 올바르지 않습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !url.hostname.includes('.') ||
      /(^|\.)(localhost|local|internal)$/.test(url.hostname) ||
      /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.includes(':')) {
    throw new Error('알림 주소가 올바르지 않습니다.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

export async function savePushSubscription(subscription: PushSubscription): Promise<void> {
  const { error } = await adminClient().from('fp_push_subscriptions').upsert({
    endpoint_hash: subscriptionHash(subscription.endpoint),
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'endpoint_hash' });
  if (error) throw new Error(`알림 구독 저장 실패: ${error.message}`);
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  const { error } = await adminClient().from('fp_push_subscriptions')
    .delete().eq('endpoint_hash', subscriptionHash(endpoint));
  if (error) throw new Error(`알림 구독 해제 실패: ${error.message}`);
}

async function deliver(row: StoredSubscription, message: PushMessage): Promise<void> {
  const payload = JSON.stringify({ ...message, url: '/' });
  await webpush.sendNotification(
    { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
    payload,
    {
      vapidDetails: {
        subject: process.env.VAPID_SUBJECT!,
        publicKey: process.env.VAPID_PUBLIC_KEY!,
        privateKey: process.env.VAPID_PRIVATE_KEY!,
      },
      TTL: 3600,
      timeout: 6000,
      urgency: 'high',
    }
  );
}

export async function sendTestPush(endpoint: string): Promise<void> {
  if (!pushConfigured()) throw new Error('푸시 서버 설정이 필요합니다.');
  const db = adminClient();
  const { data, error } = await db.from('fp_push_subscriptions')
    .select('endpoint_hash, endpoint, p256dh, auth')
    .eq('endpoint_hash', subscriptionHash(endpoint)).maybeSingle();
  if (error || !data) throw new Error('이 기기의 알림 구독을 찾을 수 없습니다.');
  await deliver(data as StoredSubscription, {
    title: '주차 알림 테스트',
    body: '아이폰 푸시 연결이 정상입니다.',
    tag: 'parking-test',
  });
}

// The event key is unique in Postgres, so overlapping cron runs send only once.
export async function sendPushEvent(eventKey: string, message: PushMessage): Promise<void> {
  if (!pushConfigured()) {
    console.warn('[push] VAPID 또는 DB 설정이 없어 알림을 보내지 못했습니다.');
    return;
  }
  const db = adminClient();
  const { data: subscriptions, error: listError } = await db.from('fp_push_subscriptions')
    .select('endpoint_hash, endpoint, p256dh, auth');
  if (listError) throw new Error(`알림 구독 조회 실패: ${listError.message}`);
  if (!subscriptions?.length) return;

  const { error: claimError } = await db.from('fp_push_events').insert({
    event_key: eventKey,
    title: message.title,
    body: message.body,
  });
  if (claimError?.code === '23505') return;
  if (claimError) throw new Error(`알림 중복 방지 기록 실패: ${claimError.message}`);

  const results = await Promise.allSettled(
    (subscriptions as StoredSubscription[]).map(async (row) => {
      try {
        await deliver(row, message);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.from('fp_push_subscriptions').delete().eq('endpoint_hash', row.endpoint_hash);
        }
        throw error;
      }
    })
  );
  const sent = results.filter((result) => result.status === 'fulfilled').length;
  const failed = results.length - sent;
  if (sent === 0) {
    // A later scheduler invocation can retry when every provider rejected this attempt.
    const { error: releaseError } = await db.from('fp_push_events')
      .delete().eq('event_key', eventKey);
    if (releaseError) console.error('[push] 알림 재시도 준비 실패:', releaseError.message);
    console.error(`[push] ${eventKey}: 모든 구독 전송 실패`);
    return;
  }
  const { error: updateError } = await db.from('fp_push_events').update({
    sent_at: new Date().toISOString(), sent_count: sent, failed_count: failed,
  }).eq('event_key', eventKey);
  if (updateError) console.error('[push] 알림 결과 기록 실패:', updateError.message);
  if (failed) console.error(`[push] ${eventKey}: ${failed}개 구독 전송 실패`);
}
