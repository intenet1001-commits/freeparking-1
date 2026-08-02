/**
 * register-http.ts 통합 테스트 (실제 등록 없이 pKey 추출까지만 검증)
 */
import { ajparkLogin, searchCar } from '../lib/ajpark-http.js';

const URL = 'http://ajacecg.ajpark.kr/login_m.cs';
const ID = 'ACEA0204';
const PW = '1111';

async function main() {
  console.log('=== 로그인 ===');
  const login = await ajparkLogin(URL, ID, PW);
  if (!login.ok) { console.error('로그인 실패:', login.message); return; }
  console.log('carSearchUrl:', login.carSearchUrl);

  console.log('\n=== 차량 조회 (9962) ===');
  const result = await searchCar(login.carSearchUrl, login.cookieJar, '9962');
  console.log('finalUrl:', result.finalUrl);

  const pKeyMatch = result.finalUrl.match(/[?&]pKey=([^&]+)/);
  const pKey = pKeyMatch ? decodeURIComponent(pKeyMatch[1]) : 'NOT FOUND';
  console.log('pKey:', pKey);

  const bodyText = result.html.replace(/<[^>]+>/g, ' ');
  console.log('입차 확인:', bodyText.includes('차량번호:'));

  // 버튼 onclick 파싱
  const btnRe = /input[^>]+type=["']?button["']?[^>]+(?:id=['"][^'"]*BTN_종일[^'"]*['"]|value=['"][^'"]*종일[^'"]*['"])[^>]*/gi;
  const btnMatches = [...result.html.matchAll(btnRe)];
  if (btnMatches.length > 0) {
    const btnTag = btnMatches[0][0];
    const btnValue = btnTag.match(/value=['"]([^'"]+)['"]/i)?.[1] ?? '';
    const onclickM = btnTag.match(/MultipleDiscountApply\((.+?)\)\s*;/i);
    console.log('btnValue:', btnValue);
    console.log('onclick args raw:', onclickM?.[1]?.slice(0, 100));
    const disabled = /disabled/i.test(btnTag);
    console.log('disabled:', disabled);
  } else {
    console.log('버튼 없음 (입차 안됨 또는 이미 처리)');
  }
}

main().catch(console.error);
