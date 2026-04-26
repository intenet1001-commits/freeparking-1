/**
 * HTTP fetch-based parking registration (no Playwright).
 * AJPark: parses login form action + hidden fields from HTML.
 */

import { CarInput, EmitFn, getLast4, normalizePlate, extractCandidates } from './register';

function extractSetCookies(headers: Headers): string[] {
  const cookies: string[] = [];
  headers.forEach((val, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(val.split(';')[0]);
  });
  return cookies;
}

function mergeCookies(existing: string, incoming: string[]): string {
  const map: Record<string, string> = {};
  for (const part of existing.split(';').map(s => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) map[part.slice(0, eq).trim()] = part.slice(eq + 1);
  }
  for (const c of incoming) {
    const eq = c.indexOf('=');
    if (eq > 0) map[c.slice(0, eq).trim()] = c.slice(eq + 1);
  }
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

function buildBaseUrl(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return url; }
}

function resolveUrl(base: string, href: string): string {
  if (!href) return base;
  if (href.startsWith('http')) return href;
  const b = buildBaseUrl(base);
  return `${b}${href.startsWith('/') ? '' : '/'}${href}`;
}

function parseFormAction(html: string, baseUrl: string): string {
  const m = html.match(/<form[^>]+action=['"]([^'"]+)['"]/i);
  return m ? resolveUrl(baseUrl, m[1]) : baseUrl;
}

function parseHiddenInputs(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Both orderings: type before name, name before type
  const re = /input[^>]+type=['"]hidden['"][^>]*/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    const name = tag.match(/name=['"]([^'"]+)['"]/i)?.[1];
    const value = tag.match(/value=['"]([^'"]*)['"]/i)?.[1] ?? '';
    if (name) fields[name] = value;
  }
  return fields;
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export async function registerCarsHttp(
  url: string,
  adminId: string,
  adminPw: string,
  cars: CarInput[],
  selectedJson: Record<string, number>,
  emit: EmitFn
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];
  const baseUrl = buildBaseUrl(url);
  let cookieJar = '';

  try {
    // 1. GET login page
    const p1 = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
    cookieJar = mergeCookies(cookieJar, extractSetCookies(p1.headers));
    const loginHtml = await p1.text();
    const loginAction = parseFormAction(loginHtml, p1.url || url);
    const hiddenFields = parseHiddenInputs(loginHtml);

    // 2. POST login
    const p2 = await fetch(loginAction, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieJar,
        Referer: p1.url || url,
        'User-Agent': UA,
        Origin: baseUrl,
      },
      body: new URLSearchParams({
        ...hiddenFields,
        j_username_form: adminId,
        j_password_form: adminPw,
      }).toString(),
    });
    cookieJar = mergeCookies(cookieJar, extractSetCookies(p2.headers));
    const p2Html = await p2.text();
    const p2Url = p2.url || loginAction;

    if (!p2Url.includes('carSearch') && !p2Html.includes('carSearch')) {
      const msg = '로그인 실패 (URL/아이디/비밀번호 확인)';
      errors.push(msg);
      for (const car of cars) emit({ plate: car.plate, status: 'failed', message: msg });
      return { success: false, errors };
    }

    // carSearch URL 확정
    const carSearchUrl = p2Url.includes('carSearch')
      ? p2Url
      : (() => { const m = p2Html.match(/href=['"]([^'"]*carSearch[^'"]*)['"]/i); return m ? resolveUrl(baseUrl, m[1]) : `${baseUrl}/carSearch.cs`; })();

    // 3. 차량별 처리
    for (const car of cars) {
      const plate = car.plate.trim();
      const last4 = getLast4(plate);
      const normPlate = normalizePlate(plate);
      emit({ plate, status: 'running', message: `'${last4}' 조회 중...` });

      try {
        // GET carSearch page to get form structure
        const csPage = await fetch(carSearchUrl, {
          headers: { Cookie: cookieJar, 'User-Agent': UA, Referer: carSearchUrl },
          redirect: 'follow',
        });
        cookieJar = mergeCookies(cookieJar, extractSetCookies(csPage.headers));
        const csHtml = await csPage.text();
        const searchAction = parseFormAction(csHtml, carSearchUrl);
        const csHidden = parseHiddenInputs(csHtml);

        // POST car search
        const searchResp = await fetch(searchAction, {
          method: 'POST',
          redirect: 'follow',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieJar,
            Referer: carSearchUrl,
            'User-Agent': UA,
          },
          body: new URLSearchParams({ ...csHidden, carNumber: last4 }).toString(),
        });
        cookieJar = mergeCookies(cookieJar, extractSetCookies(searchResp.headers));
        const html = await searchResp.text();
        const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        if (!bodyText.includes('입차된 차량') && !bodyText.includes('차량번호:')) {
          emit({ plate, status: 'not_entered', message: '입차 없음' });
          continue;
        }

        const candidates = extractCandidates(html);
        const btnRe = /input[^>]+type=["']?button["']?[^>]+(?:id=['"][^'"]*BTN_종일[^'"]*['"]|value=['"][^'"]*종일[^'"]*['"])[^>]*/gi;
        const btnMatches = [...html.matchAll(btnRe)];
        const isDisabled = btnMatches.some(m => /disabled/i.test(m[0]));

        if (candidates.length === 0 && btnMatches.length === 0) {
          emit({ plate, status: 'not_entered', message: '입차 없음' });
          continue;
        }

        let chosenIdx: number | null = null;
        if (plate in selectedJson) chosenIdx = Number(selectedJson[plate]);
        if (chosenIdx === null && normPlate && candidates.length > 0) {
          for (let i = 0; i < candidates.length; i++) {
            if (normalizePlate(candidates[i].plate) === normPlate) { chosenIdx = i; break; }
          }
        }
        if (chosenIdx === null && Math.max(candidates.length, btnMatches.length) <= 1) chosenIdx = 0;
        if (chosenIdx === null) {
          emit({ plate, status: 'needs_selection', message: '여러 차량 발견 — 선택 필요', candidates: candidates.slice(0, 4) });
          continue;
        }

        const btnTag = btnMatches[chosenIdx < btnMatches.length ? chosenIdx : 0]?.[0] ?? '';
        const btnValue = btnTag.match(/value=['"]([^'"]+)['"]/i)?.[1] ?? '종일권';
        const btnLabel = btnValue.split('(')[0].trim();

        if (isDisabled) {
          if (bodyText.includes('적용내역') || bodyText.includes('승인')) {
            emit({ plate, status: 'skipped', message: `이미 오늘 ${btnLabel} 처리됨` });
          } else {
            emit({ plate, status: 'failed', message: `${btnLabel} 잔여 매수 없음` });
          }
          continue;
        }

        const btnName = btnTag.match(/name=['"]([^'"]+)['"]/i)?.[1];
        const submitAction = parseFormAction(html, carSearchUrl);
        const formData = new URLSearchParams({ ...parseHiddenInputs(html), carNumber: last4 });
        if (btnName) formData.set(btnName, btnValue);

        const clickResp = await fetch(submitAction, {
          method: 'POST',
          redirect: 'follow',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieJar,
            Referer: carSearchUrl,
            'User-Agent': UA,
          },
          body: formData.toString(),
        });
        cookieJar = mergeCookies(cookieJar, extractSetCookies(clickResp.headers));
        const afterText = (await clickResp.text()).replace(/<[^>]+>/g, ' ');
        const display = candidates.length > 0 && chosenIdx < candidates.length ? candidates[chosenIdx].plate : plate;

        if (afterText.includes('승인') || afterText.includes('적용')) {
          emit({ plate, status: 'success', message: `${display} ${btnLabel} 등록 완료` });
        } else {
          emit({ plate, status: 'success', message: `${btnLabel} 처리 완료 (결과 확인 필요)` });
        }
      } catch (e) {
        const msg = `HTTP 오류: ${String(e).slice(0, 80)}`;
        errors.push(`${plate}: ${msg}`);
        emit({ plate, status: 'failed', message: msg });
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) {
    const msg = `연결 오류: ${String(e).slice(0, 120)}`;
    errors.push(msg);
    for (const car of cars) emit({ plate: car.plate, status: 'failed', message: msg });
    return { success: false, errors };
  }

  return { success: errors.length === 0, errors };
}
