/**
 * AJPark 로그인 흐름 디버그 스크립트
 * 실행: NICEPARK_URL=... NICEPARK_ID=... NICEPARK_PW=... npx tsx scripts/debug-login.ts
 */

import { chromium } from 'playwright';

const url = process.env.NICEPARK_URL ?? '';
const id = process.env.NICEPARK_ID ?? '';
const pw = process.env.NICEPARK_PW ?? '';

if (!url) {
  console.error('NICEPARK_URL 환경변수가 필요합니다.');
  console.error('사용법: NICEPARK_URL=... NICEPARK_ID=... NICEPARK_PW=... npx tsx scripts/debug-login.ts');
  process.exit(1);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });

  type ReqLog = { url: string; method: string; body?: string };
  type RespLog = { url: string; status: number; location?: string; cookies: string[] };
  const reqs: ReqLog[] = [];
  const resps: RespLog[] = [];

  context.on('request', req => {
    reqs.push({ url: req.url(), method: req.method(), body: req.postData() ?? undefined });
  });
  context.on('response', resp => {
    const loc = resp.headers()['location'];
    const setCookie = resp.headers()['set-cookie'];
    resps.push({ url: resp.url(), status: resp.status(), location: loc, cookies: setCookie ? [setCookie] : [] });
  });

  const page = await context.newPage();

  console.log('\n========================================');
  console.log(' AJPark 로그인 디버그');
  console.log('========================================\n');

  console.log('[1] 로그인 페이지 로드:', url);
  await page.goto(url, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const loginHtml = await page.content();

  // 폼 구조 분석
  console.log('\n--- 로그인 폼 분석 ---');
  const forms = [...loginHtml.matchAll(/<form[^>]*>/gi)];
  console.log(`폼 개수: ${forms.length}`);
  forms.forEach((m, i) => {
    const action = m[0].match(/action=['"]([^'"]+)['"]/i)?.[1] ?? '(없음)';
    const method = m[0].match(/method=['"]([^'"]+)['"]/i)?.[1] ?? 'GET';
    console.log(`  폼 ${i + 1}: method=${method}, action=${action}`);
  });

  const hidden = [...loginHtml.matchAll(/input[^>]+type=['"]hidden['"][^>]*/gi)];
  if (hidden.length) {
    console.log(`\n히든 필드 (${hidden.length}개):`);
    hidden.forEach(m => {
      const name = m[0].match(/name=['"]([^'"]+)['"]/i)?.[1] ?? '?';
      const val = m[0].match(/value=['"]([^'"]*)['"]/i)?.[1] ?? '';
      console.log(`  ${name} = "${val.slice(0, 60)}"`);
    });
  }

  const namedInputs = [...loginHtml.matchAll(/name=['"]([^'"]+)['"]/gi)].map(m => m[1]);
  console.log('\n모든 name 속성:', namedInputs.join(', '));

  if (!id || !pw) {
    console.log('\n⚠️  NICEPARK_ID / NICEPARK_PW 미설정 — 로그인 단계 건너뜀');
    await browser.close();
    return;
  }

  // 요청 로그 초기화 (로그인 POST만 캡처)
  reqs.length = 0;
  resps.length = 0;

  console.log('\n[2] 로그인 폼 채우기...');
  const userField = await page.$("input[name='j_username_form']");
  const pwField = await page.$("input[name='j_password_form']");

  if (!userField || !pwField) {
    console.log('⚠️  j_username_form / j_password_form 필드를 찾을 수 없음');
    const inputs = await page.$$('input');
    for (const inp of inputs) {
      const name = await inp.getAttribute('name');
      const type = await inp.getAttribute('type');
      if (name) console.log(`  input: type=${type}, name=${name}`);
    }
  } else {
    await userField.fill(id);
    await pwField.fill(pw);
    console.log('폼 채우기 완료');
  }

  console.log('\n[3] 로그인 버튼 클릭...');
  const loginBtn = await page.$("a:has-text('로그인')");
  if (loginBtn) {
    await loginBtn.click();
  } else {
    console.log('  로그인 링크 없음 → Enter 키 시도');
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(4000);

  // POST 요청 분석
  console.log('\n--- POST 요청 내역 ---');
  const posts = reqs.filter(r => r.method === 'POST');
  if (posts.length === 0) {
    console.log('(POST 요청 없음)');
  }
  for (const req of posts) {
    console.log(`POST ${req.url}`);
    if (req.body) {
      const params = new URLSearchParams(req.body);
      console.log('전송 파라미터:');
      for (const [k, v] of params) {
        const display = k.toLowerCase().includes('pass') ? '***' : v.slice(0, 80);
        console.log(`  ${k} = "${display}"`);
      }
    }
  }

  // 리다이렉트 체인
  const redirects = resps.filter(r => r.status >= 300 && r.status < 400);
  if (redirects.length) {
    console.log('\n--- 리다이렉트 체인 ---');
    redirects.forEach(r => console.log(`  ${r.status} ${r.url} → ${r.location ?? '?'}`));
  }

  // Set-Cookie 요약
  const cookieResps = resps.filter(r => r.cookies.length > 0);
  if (cookieResps.length) {
    console.log('\n--- Set-Cookie ---');
    cookieResps.forEach(r => console.log(`  [${r.status}] ${r.url}\n    ${r.cookies.join('\n    ')}`));
  }

  // 최종 결과
  console.log('\n--- 최종 결과 ---');
  console.log('URL:', page.url());
  const finalHtml = await page.content();
  const hasCarSearch = finalHtml.includes('carSearch');
  console.log('carSearch 포함:', hasCarSearch ? '✅ 예' : '❌ 아니오');

  if (hasCarSearch) {
    const csMatch = finalHtml.match(/href=['"]([^'"]*carSearch[^'"]*)['"]/i);
    if (csMatch) console.log('carSearch 링크:', csMatch[1]);
    console.log('\n✅ 로그인 성공');
  } else {
    const title = finalHtml.match(/<title>([^<]+)<\/title>/i)?.[1];
    console.log('페이지 제목:', title);
    const hasLoginForm = finalHtml.includes('j_username') || finalHtml.includes('j_password');
    if (hasLoginForm) console.log('⚠️  로그인 폼이 다시 표시됨 (자격증명 오류 가능성)');
    console.log('\n❌ 로그인 실패 또는 예상치 못한 리다이렉트');
  }

  await browser.close();
  console.log('\n========================================\n');
}

main().catch(console.error);
