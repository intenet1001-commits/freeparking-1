/**
 * Playwright-free HTTP implementation of parking registration.
 * Uses cookie-based session management with plain fetch.
 * Falls back to Playwright when needed (local only).
 */

import { CarInput, EmitFn, getLast4, normalizePlate, extractCandidates } from './register';

// Simple cookie jar: extract and pass Set-Cookie headers
function extractCookies(headers: Headers): string {
  const cookies: string[] = [];
  headers.forEach((val, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      cookies.push(val.split(';')[0]);
    }
  });
  return cookies.join('; ');
}

function mergeCookies(existing: string, incoming: string): string {
  const map: Record<string, string> = {};
  for (const part of (existing + '; ' + incoming).split(';').map(s => s.trim()).filter(Boolean)) {
    const [k, ...rest] = part.split('=');
    if (k) map[k.trim()] = rest.join('=');
  }
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

function buildBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

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

  // ── 로그인 ────────────────────────────────────────────────────────
  let cookieJar = '';
  let loginPageUrl = url;

  try {
    // GET login page to capture initial session cookie
    const loginPageResp = await fetch(loginPageUrl, { redirect: 'follow' });
    cookieJar = mergeCookies(cookieJar, extractCookies(loginPageResp.headers));
    loginPageUrl = loginPageResp.url;

    // POST login credentials
    const loginResp = await fetch(loginPageUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieJar,
        Referer: loginPageUrl,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: new URLSearchParams({
        j_username_form: adminId,
        j_password_form: adminPw,
      }).toString(),
      redirect: 'follow',
    });
    cookieJar = mergeCookies(cookieJar, extractCookies(loginResp.headers));

    const loginHtml = await loginResp.text();
    const loginFinalUrl = loginResp.url;

    if (!loginFinalUrl.includes('carSearch') && !loginHtml.includes('carSearch')) {
      const msg = '로그인 실패 (아이디/비밀번호 확인)';
      errors.push(msg);
      for (const car of cars) emit({ plate: car.plate, status: 'failed', message: msg });
      return { success: false, errors };
    }

    const carSearchUrl = loginFinalUrl.includes('carSearch')
      ? loginFinalUrl
      : `${baseUrl}/carSearch`;

    // ── 차량별 처리 ───────────────────────────────────────────────────
    for (const car of cars) {
      const plate = car.plate.trim();
      const last4 = getLast4(plate);
      const normPlate = normalizePlate(plate);
      emit({ plate, status: 'running', message: `'${last4}' 조회 중...` });

      try {
        // POST car search
        const searchResp = await fetch(carSearchUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieJar,
            Referer: carSearchUrl,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          body: new URLSearchParams({ carNumber: last4 }).toString(),
          redirect: 'follow',
        });
        cookieJar = mergeCookies(cookieJar, extractCookies(searchResp.headers));
        const html = await searchResp.text();

        // Strip tags for text content check
        const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        if (!bodyText.includes('입차된 차량') && !bodyText.includes('차량번호:')) {
          emit({ plate, status: 'not_entered', message: '입차 없음' });
          continue;
        }

        const candidates = extractCandidates(html);

        // Find 종일권 button
        const btnRe = /input[^>]+type=["']?button["']?[^>]+(?:id=['"][^'"]*BTN_종일[^'"]*['"]|value=['"][^'"]*종일[^'"]*['"])[^>]*>/gi;
        const btnMatches = [...html.matchAll(btnRe)];

        // Check disabled
        const isDisabled = btnMatches.some(m => /disabled/i.test(m[0]));
        const btnValue = btnMatches[0]?.[0].match(/value=['"]([^'"]+)['"]/i)?.[1] ?? '종일권';
        const btnLabel = btnValue.split('(')[0].trim();

        // Extract form action for button submission
        const formActionMatch = html.match(/<form[^>]+action=['"]([^'"]+)['"]/i);
        const formAction = formActionMatch ? formActionMatch[1] : carSearchUrl;
        const submitUrl = formAction.startsWith('http') ? formAction : `${baseUrl}${formAction.startsWith('/') ? '' : '/'}${formAction}`;

        // Extract hidden inputs
        const hiddenRe = /input[^>]+type=['"]hidden['"][^>]+name=['"]([^'"]+)['"][^>]+value=['"]([^'"]*)['"]/gi;
        const hiddenInputs: Record<string, string> = {};
        for (const m of html.matchAll(hiddenRe)) {
          hiddenInputs[m[1]] = m[2];
        }

        if (candidates.length === 0 && btnMatches.length === 0) {
          emit({ plate, status: 'not_entered', message: '입차 없음' });
          continue;
        }

        // Determine chosen index
        let chosenIdx: number | null = null;
        if (plate in selectedJson) chosenIdx = Number(selectedJson[plate]);
        if (chosenIdx === null && normPlate && candidates.length > 0) {
          for (let i = 0; i < candidates.length; i++) {
            if (normalizePlate(candidates[i].plate) === normPlate) { chosenIdx = i; break; }
          }
        }
        if (chosenIdx === null) {
          const n = Math.max(candidates.length, btnMatches.length);
          if (n <= 1) chosenIdx = 0;
        }
        if (chosenIdx === null) {
          emit({ plate, status: 'needs_selection', message: '여러 차량 발견 — 선택 필요', candidates: candidates.slice(0, 4) });
          continue;
        }

        if (isDisabled) {
          if (bodyText.includes('적용내역') || bodyText.includes('승인')) {
            emit({ plate, status: 'skipped', message: `이미 오늘 ${btnLabel} 처리됨` });
          } else {
            emit({ plate, status: 'failed', message: `${btnLabel} 잔여 매수 없음` });
          }
          continue;
        }

        // Extract button name for submission
        const btnNameMatch = btnMatches[chosenIdx < btnMatches.length ? chosenIdx : 0]?.[0].match(/name=['"]([^'"]+)['"]/i);
        const btnName = btnNameMatch?.[1];

        // POST button click
        const formData = new URLSearchParams({ ...hiddenInputs, carNumber: last4 });
        if (btnName) formData.set(btnName, btnValue);

        const clickResp = await fetch(submitUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieJar,
            Referer: carSearchUrl,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          body: formData.toString(),
          redirect: 'follow',
        });
        cookieJar = mergeCookies(cookieJar, extractCookies(clickResp.headers));
        const afterHtml = await clickResp.text();
        const afterText = afterHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        const display = candidates.length > 0 && chosenIdx < candidates.length
          ? candidates[chosenIdx].plate : plate;

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
    const msg = `로그인 오류: ${String(e).slice(0, 120)}`;
    errors.push(msg);
    for (const car of cars) emit({ plate: car.plate, status: 'failed', message: msg });
    return { success: false, errors };
  }

  return { success: errors.length === 0, errors };
}
