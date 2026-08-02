/**
 * AJPark 등록 흐름 디버그 - 버튼 클릭 POST 캡처
 */
import { chromium } from 'playwright';

const URL = 'http://ajacecg.ajpark.kr/login_m.cs';
const ID = 'ACEA0204';
const PW = '1111';
const TEST_LAST4 = '5137'; // 36루5137

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 모든 요청 캡처 (GET 포함)
  page.on('request', req => {
    const method = req.method();
    const url = req.url();
    if (!url.includes('.css') && !url.includes('.js') && !url.includes('.jpg') && !url.includes('.gif') && !url.includes('.png')) {
      console.log(`\n[${method}] ${url}`);
      if (method === 'POST') console.log('  Body:', req.postData()?.slice(0, 500));
    }
  });
  page.on('response', async resp => {
    const method = resp.request().method();
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
    const src = (window as any).MultipleDiscountApply?.toString() ?? 'NOT FOUND';
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

  // 버튼 클릭 + 네트워크 캡처
  console.log('\n=== 버튼 클릭 (네트워크 캡처) ===');
  const dayBtn = await page.$("input[type=button][id*='BTN_종일']") ?? await page.$("input[type=button][value*='종일']");
  if (dayBtn && !(await dayBtn.isDisabled())) {
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
