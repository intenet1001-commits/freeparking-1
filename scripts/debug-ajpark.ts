/**
 * AJPark 등록 흐름 디버그 - 버튼 클릭 POST 캡처
 */
import { chromium } from 'playwright';

const URL = process.env.NICEPARK_URL ?? '';
const ID = process.env.NICEPARK_ID ?? '';
const PW = process.env.NICEPARK_PW ?? '';
const TEST_LAST4 = process.env.NICEPARK_TEST_LAST4 ?? '';
const APPLY = process.argv.includes('--confirm-apply');

async function main() {
  if (!URL || !ID || !PW || !TEST_LAST4) {
    throw new Error('NICEPARK_URL, NICEPARK_ID, NICEPARK_PW, NICEPARK_TEST_LAST4 환경변수가 필요합니다.');
  }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 모든 요청 캡처 (GET 포함)
  page.on('request', req => {
    const method = req.method();
    const url = req.url();
    if (!url.includes('.css') && !url.includes('.js') && !url.includes('.jpg') && !url.includes('.gif') && !url.includes('.png')) {
      console.log(`\n[${method}] ${url}`);
      if (method === 'POST') {
        const safeBody = (req.postData() ?? '')
          .replace(/(j_password(?:_form)?=)[^&]*/gi, '$1[REDACTED]')
          .replace(/(password=)[^&]*/gi, '$1[REDACTED]');
        console.log('  Body:', safeBody.slice(0, 500));
      }
    }
  });
  page.on('response', async resp => {
    const url = resp.url();
    if (!url.includes('.css') && !url.includes('.js') && !url.includes('.jpg') && !url.includes('.gif') && !url.includes('.png')) {
      console.log(`  → ${resp.status()} ${url}`);
    }
  });
  page.on('dialog', d => { d.accept(); });

  // 로그인
  await page.goto(URL, { timeout: 15000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await page.fill("input[name='j_username_form']", ID);
  await page.fill("input[name='j_password_form']", PW);
  console.log('\n=== 로그인 ===');
  await page.click("a:has-text('로그인')");
  await page.waitForURL('**/carSearch**', { timeout: 15000 }).catch(() => {});
  console.log('carSearch URL:', page.url());

  // 차량 조회
  console.log('\n=== 차량 조회:', TEST_LAST4, '===');
  await page.fill('#carNumber', TEST_LAST4);
  await Promise.all([
    page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('input[type=submit]'),
  ]);
  const discountApplyUrl = page.url();
  console.log('\ndiscountApply URL:', discountApplyUrl);

  // MultipleDiscountApply JS 함수 소스 추출
  console.log('\n=== MultipleDiscountApply 함수 소스 ===');
  const fnSource = await page.evaluate(() => {
    const typedWindow = window as Window & { MultipleDiscountApply?: () => unknown };
    const src = typedWindow.MultipleDiscountApply?.toString() ?? 'NOT FOUND';
    return src;
  });
  console.log(fnSource.slice(0, 1000));

  // 버튼 onclick 추출
  console.log('\n=== 버튼 onclick ===');
  const btns = await page.$$("input[type=button]");
  for (const btn of btns) {
    const val = await btn.getAttribute('value') ?? '';
    if (val.includes('종일')) {
      const onclick = await btn.getAttribute('onclick') ?? '';
      const disabled = await btn.isDisabled();
      console.log(`value="${val}" disabled=${disabled}`);
      console.log(`onclick=${onclick}`);
    }
  }

  // 기본은 dry-run. 실제 주차권 차감은 --confirm-apply를 명시한 경우에만 수행.
  console.log(`\n=== 등록 단계 (${APPLY ? 'CONFIRMED APPLY' : 'DRY RUN'}) ===`);
  const dayBtn = await page.$("input[type=button][id*='BTN_종일']") ?? await page.$("input[type=button][value*='종일']");
  if (!APPLY) {
    console.log('DRY RUN: 버튼을 클릭하지 않았습니다. 실제 적용은 --confirm-apply가 필요합니다.');
  } else if (dayBtn && !(await dayBtn.isDisabled())) {
    await Promise.all([
      page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {}),
      dayBtn.click(),
    ]);
    console.log('\nFinal URL:', page.url());
  } else {
    console.log('클릭 가능한 버튼 없음 (이미 처리됨)');
  }

  await browser.close();
}

main().catch(console.error);
