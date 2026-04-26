import { getLast4, normalizePlate, extractCandidates } from './register';

export type CarStatusResult = {
  plate: string;
  status: 'not_entered' | 'entered' | 'registered' | 'no_quota' | 'multi_car' | 'error';
  message: string;
};

export type EmitStatusFn = (data: CarStatusResult) => void;

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

function parseFormAction(html: string, base: string): string {
  const m = html.match(/<form[^>]+action=['"]([^'"]+)['"]/i);
  return m ? resolveUrl(base, m[1]) : base;
}

function parseHiddenInputs(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/input[^>]+type=['"]hidden['"][^>]*/gi)) {
    const tag = m[0];
    const name = tag.match(/name=['"]([^'"]+)['"]/i)?.[1];
    const value = tag.match(/value=['"]([^'"]*)['"]/i)?.[1] ?? '';
    if (name) fields[name] = value;
  }
  return fields;
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export async function checkCarStatuses(
  url: string,
  adminId: string,
  adminPw: string,
  plates: string[],
  emit: EmitStatusFn
): Promise<void> {
  let cookieJar = '';
  const baseUrl = buildBaseUrl(url);

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
      for (const plate of plates) emit({ plate, status: 'error', message: '로그인 실패 (URL/아이디/비밀번호 확인)' });
      return;
    }

    const carSearchUrl = p2Url.includes('carSearch')
      ? p2Url
      : (() => { const m = p2Html.match(/href=['"]([^'"]*carSearch[^'"]*)['"]/i); return m ? resolveUrl(baseUrl, m[1]) : `${baseUrl}/carSearch.cs`; })();

    for (const plate of plates) {
      const last4 = getLast4(plate);
      const normPlate = normalizePlate(plate);
      try {
        // GET carSearch to get form
        const csPage = await fetch(carSearchUrl, {
          headers: { Cookie: cookieJar, 'User-Agent': UA },
          redirect: 'follow',
        });
        cookieJar = mergeCookies(cookieJar, extractSetCookies(csPage.headers));
        const csHtml = await csPage.text();
        const searchAction = parseFormAction(csHtml, carSearchUrl);
        const csHidden = parseHiddenInputs(csHtml);

        const resp = await fetch(searchAction, {
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
        cookieJar = mergeCookies(cookieJar, extractSetCookies(resp.headers));
        const html = await resp.text();
        const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        if (!bodyText.includes('입차된 차량') && !bodyText.includes('차량번호:')) {
          emit({ plate, status: 'not_entered', message: '입차 없음 (미입차 또는 출차완료)' });
          continue;
        }

        const candidates = extractCandidates(html);
        const btnRe = /input[^>]+type=["']?button["']?[^>]+(?:id=['"][^'"]*BTN_종일[^'"]*['"]|value=['"][^'"]*종일[^'"]*['"])[^>]*/gi;
        const btnMatches = [...html.matchAll(btnRe)];
        const isDisabled = btnMatches.some(m => /disabled/i.test(m[0]));

        if (candidates.length === 0 && btnMatches.length === 0) {
          emit({ plate, status: 'not_entered', message: '입차 없음 (미입차 또는 출차완료)' });
          continue;
        }

        if (candidates.length > 1) {
          const matched = candidates.find(c => normalizePlate(c.plate) === normPlate);
          if (!matched) {
            emit({ plate, status: 'multi_car', message: `복수 차량 (${candidates.map(c => c.plate).join(', ')})` });
            continue;
          }
        }

        if (!btnMatches.length) {
          emit({ plate, status: 'entered', message: '입차중 (종일권 버튼 없음)' });
          continue;
        }

        if (isDisabled) {
          if (bodyText.includes('적용내역') || bodyText.includes('승인')) {
            emit({ plate, status: 'registered', message: '무료주차 등록완료' });
          } else {
            emit({ plate, status: 'no_quota', message: '입차중 (잔여 매수 없음)' });
          }
        } else {
          emit({ plate, status: 'entered', message: '입차중 (등록 전)' });
        }
      } catch (e) {
        emit({ plate, status: 'error', message: `조회 오류: ${String(e).slice(0, 80)}` });
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) {
    for (const plate of plates) emit({ plate, status: 'error', message: `연결 오류: ${String(e).slice(0, 80)}` });
  }
}
