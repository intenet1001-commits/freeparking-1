/**
 * AJPark HTTP session helper.
 * Login: j_username=Base64(id), j_password=plain_pw
 * Form action: login;jsessionid=<token>
 */

export function extractSetCookies(headers: Headers): string[] {
  const cookies: string[] = [];
  headers.forEach((val, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(val.split(';')[0]);
  });
  return cookies;
}

export function mergeCookies(existing: string, incoming: string[]): string {
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

export function buildBaseUrl(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return url; }
}

export function resolveUrl(base: string, href: string): string {
  if (!href) return base;
  if (href.startsWith('http')) return href;
  const b = buildBaseUrl(base);
  return `${b}${href.startsWith('/') ? '' : '/'}${href}`;
}

export function parseHiddenInputs(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/input[^>]+type=['"]hidden['"][^>]*/gi)) {
    const tag = m[0];
    const name = tag.match(/name=['"]([^'"]+)['"]/i)?.[1];
    const value = tag.match(/value=['"]([^'"]*)['"]/i)?.[1] ?? '';
    if (name) fields[name] = value;
  }
  return fields;
}

export const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export type LoginResult =
  | { ok: true; cookieJar: string; carSearchUrl: string }
  | { ok: false; message: string };

export async function ajparkLogin(
  url: string,
  adminId: string,
  adminPw: string
): Promise<LoginResult> {
  let cookieJar = '';
  const baseUrl = buildBaseUrl(url);

  // 1. GET login page → session cookie + form action
  const p1 = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
  cookieJar = mergeCookies(cookieJar, extractSetCookies(p1.headers));
  const loginHtml = await p1.text();

  // Parse form action (e.g. "login;jsessionid=XXX")
  const formActionRaw = loginHtml.match(/<form[^>]+action=['"]([^'"]+)['"]/i)?.[1] ?? 'login';
  const loginAction = resolveUrl(p1.url || url, formActionRaw);

  // AJPark: j_username = Base64(id), j_password = plain
  const j_username = Buffer.from(adminId).toString('base64');

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
      j_username,
      j_password: adminPw,
    }).toString(),
  });
  cookieJar = mergeCookies(cookieJar, extractSetCookies(p2.headers));
  const p2Html = await p2.text();
  const p2Url = p2.url || loginAction;

  if (!p2Url.includes('carSearch') && !p2Html.includes('carSearch')) {
    return { ok: false, message: '로그인 실패 (URL/아이디/비밀번호 확인)' };
  }

  const carSearchUrl = p2Url.includes('carSearch')
    ? p2Url
    : (() => {
        const m = p2Html.match(/href=['"]([^'"]*carSearch[^'"]*)['"]/i);
        return m ? resolveUrl(baseUrl, m[1]) : `${baseUrl}/carSearch.cs`;
      })();

  return { ok: true, cookieJar, carSearchUrl };
}

export async function searchCar(
  carSearchUrl: string,
  cookieJar: string,
  last4: string
): Promise<{ html: string; cookieJar: string }> {
  // GET carSearch page for form structure
  const csPage = await fetch(carSearchUrl, {
    headers: { Cookie: cookieJar, 'User-Agent': UA },
    redirect: 'follow',
  });
  cookieJar = mergeCookies(cookieJar, extractSetCookies(csPage.headers));
  const csHtml = await csPage.text();

  const formActionRaw = csHtml.match(/<form[^>]+action=['"]([^'"]+)['"]/i)?.[1] ?? '';
  const searchAction = formActionRaw
    ? resolveUrl(carSearchUrl, formActionRaw)
    : carSearchUrl;
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
  return { html, cookieJar };
}
