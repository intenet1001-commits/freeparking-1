import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSundaySummary } from '../lib/sunday-summary';
import { kstDate, parsePushSubscription, subscriptionHash } from '../lib/push';

test('Sunday summary distinguishes live confirmation, past processing, and unknown states', () => {
  const summary = buildSundaySummary(
    ['12가3456', '34나5678', '56다7890', '78라9012'],
    [
      { plate: '12가3456', status: 'registered', message: '등록완료' },
      { plate: '34나5678', status: 'not_entered', message: '출차' },
      { plate: '56다7890', status: 'entered', message: '등록 전' },
      { plate: '78라9012', status: 'error', message: '조회 오류' },
    ],
    [
      { plate: '34나5678', status: 'success' },
      { plate: '__run__', status: 'done' },
    ]
  );
  assert.match(summary.body, /등록 확인 1대/);
  assert.match(summary.body, /오늘 처리 기록 1대/);
  assert.match(summary.body, /등록 전 1대/);
  assert.match(summary.body, /조회 불가 1대/);
  assert.equal(summary.unresolved, 1);
});

test('missing live check never turns a success log into current registration confirmation', () => {
  const summary = buildSundaySummary(
    ['12가3456'], [], [{ plate: '12가3456', status: 'success' }]
  );
  assert.match(summary.body, /등록 확인 0대/);
  assert.match(summary.body, /조회 불가 1대/);
  assert.match(summary.body, /자동 실행 기록 없음/);
});

test('push subscription rejects insecure and local endpoints', () => {
  const keys = { p256dh: 'A'.repeat(80), auth: 'B'.repeat(24) };
  assert.throws(() => parsePushSubscription({ endpoint: 'http://push.example.com/x', keys }));
  assert.throws(() => parsePushSubscription({ endpoint: 'https://127.0.0.1/x', keys }));
  assert.equal(
    parsePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys }).endpoint,
    'https://web.push.apple.com/x'
  );
});

test('event dates use Korea time at the UTC boundary', () => {
  assert.equal(kstDate(new Date('2026-10-03T15:00:00Z')), '2026-10-04');
  assert.equal(subscriptionHash('https://example.com/push').length, 64);
});
