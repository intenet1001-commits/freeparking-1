import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCarStatuses, parseAppliedDiscount, type CarStatusResult } from '../lib/check-status';
import { registerCarsHttp } from '../lib/register-http';
import type { EmitFn } from '../lib/register';

const origin = 'https://parking.example.com';
const plate = '12가3456';
const button = (disabled = false) => `<input type="button" id="BTN_종일" value="종일권(10)" onclick="MultipleDiscountApply('1','entry-key','00005','종일권','12가3456','매수차감','1','');" ${disabled ? 'disabled' : ''}>`;
const entry = '차량번호: 12가3456 입차일시: 2026-09-06 10:00:00';

function response(body: string, path: string, init?: ResponseInit) {
  const result = new Response(body, init);
  Object.defineProperty(result, 'url', { value: `${origin}${path}` });
  return result;
}

test('zero applications are not a completed registration', () => {
  assert.equal(parseAppliedDiscount('<div>적용내역 종일권 : 0</div>'), undefined);
  assert.equal(parseAppliedDiscount('적용내역 없음'), undefined);
  assert.deepEqual(parseAppliedDiscount('<div>적용내역 종일권 : 1</div>'), { name: '종일권', kind: 'allDay' });
});

const cases = [
  { name: 'no entry with static form labels', html: '차량번호: 입차일시: <script>function onclick_Car(myPick) {}</script>', status: 'not_entered', registration: 'not_entered' },
  { name: 'common discount form without vehicle identity', html: `${button(true)} 적용내역 종일권 : 1`, status: 'error', registration: 'failed' },
  { name: 'vehicle without entry time', html: `차량번호: ${plate} ${button(true)} 적용내역 종일권 : 1`, status: 'error', registration: 'failed' },
  { name: 'different vehicle sharing last four digits', html: `${entry.replace(plate, '99나3456')} ${button(true)} 적용내역 종일권 : 1`, status: 'not_entered', registration: 'not_entered' },
  { name: 'disabled button without applied discount', html: `${entry} ${button(true)} 적용내역 종일권 : 0`, status: 'no_quota', registration: 'failed' },
  { name: 'confirmed entry and applied discount', html: `${entry} ${button(true)} 적용내역 종일권 : 1`, status: 'registered', registration: 'skipped' },
];

for (const scenario of cases) {
  test(scenario.name, async (t) => {
    // Exercise the complete login/search/status and registration flows without a real parking mutation.
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/login') && init?.method === 'POST') {
        return response('', '/login', { status: 302, headers: { location: '/discount/carSearch.cs' } });
      }
      if (url.endsWith('/login')) return response('<form action="/login"></form>', '/login');
      if (url.endsWith('/discount/carSearch.cs')) {
        return response(init?.method === 'POST' ? scenario.html : '<form action="/discount/carSearch.cs"></form>', '/discount/carSearch.cs');
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const statuses: CarStatusResult[] = [];
    await checkCarStatuses(`${origin}/login`, 'test', 'test', [plate], (result) => statuses.push(result));
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, scenario.status);
    const logs: Parameters<EmitFn>[0][] = [];
    await registerCarsHttp(`${origin}/login`, 'test', 'test', [{ plate, label: '' }], {}, (result) => logs.push(result));
    assert.equal(logs.at(-1)?.status, scenario.registration);
    assert.equal(logs.some((log) => log.status === 'success'), false);
  });
}
