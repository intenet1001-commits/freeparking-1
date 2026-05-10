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

  // 2. POST login — redirect: 'manual' so we can forward cookies on each hop
  // fetch's redirect:'follow' drops the Cookie header on redirects, breaking session
  const p2 = await fetch(loginAction, {
    method: 'POST',
    redirect: 'manual',
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

  if (p2.status !== 302 && p2.status !== 301 && p2.status !== 303) {
    const body = await p2.text();
    if (body.includes('아이디') || body.includes('비밀번호') || body.includes('login')) {
      return { ok: false, message: '로그인 실패 (URL/아이디/비밀번호 확인)' };
    }
  }

  // 3. Follow redirects manually, forwarding cookies on each hop
  // Actual chain: POST /login → 302 /main/index → 302 /discount/carSearch.cs?userID=...
  let currentUrl = loginAction;
  let currentResp: Response = p2;
  let carSearchUrl = '';

  for (let hop = 0; hop < 6; hop++) {
    const status = currentResp.status;
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      const rawLocation = currentResp.headers.get('location') ?? '';
      if (!rawLocation) break;
      const nextUrl = new URL(resolveUrl(currentUrl, rawLocation)).href;

      if (nextUrl.includes('carSearch')) {
        carSearchUrl = nextUrl;
        break;
      }

      currentUrl = nextUrl;
      currentResp = await fetch(nextUrl, {
        redirect: 'manual',
        headers: { Cookie: cookieJar, 'User-Agent': UA, Referer: currentUrl },
      });
      cookieJar = mergeCookies(cookieJar, extractSetCookies(currentResp.headers));
    } else if (status === 200) {
      if (currentUrl.includes('carSearch')) {
        carSearchUrl = currentUrl;
      } else {
        const html = await currentResp.text();
        const m = html.match(/href=['"]([^'"]*carSearch[^'"]*)['"]/i);
        carSearchUrl = m
          ? resolveUrl(baseUrl, m[1])
          : `${baseUrl}/discount/carSearch.cs?userID=${adminId}&contextPath=`;
      }
      break;
    } else {
      break;
    }
  }

  if (!carSearchUrl) {
    return { ok: false, message: '로그인 실패 (URL/아이디/비밀번호 확인)' };
  }

  return { ok: true, cookieJar, carSearchUrl };
}

export async function searchCar(
  carSearchUrl: string,
  cookieJar: string,
  last4: string
): Promise<{ html: string; cookieJar: string; finalUrl: string }> {
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
  const today = new Date().toISOString().slice(0, 10);

  // redirect:'manual' to capture cookies from the 302 response
  const postResp = await fetch(searchAction, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieJar,
      Referer: carSearchUrl,
      'User-Agent': UA,
    },
    body: new URLSearchParams({ ...csHidden, carNumber: last4, from: today, fromHH: '00' }).toString(),
  });
  cookieJar = mergeCookies(cookieJar, extractSetCookies(postResp.headers));

  // Follow 302 → discountApply.cs?pKey=...
  let html = '';
  let finalUrl = carSearchUrl;

  if (postResp.status >= 300 && postResp.status < 400) {
    const location = postResp.headers.get('location') ?? '';
    if (location) {
      finalUrl = new URL(resolveUrl(searchAction, location)).href;
      const getResp = await fetch(finalUrl, {
        redirect: 'follow',
        headers: { Cookie: cookieJar, 'User-Agent': UA, Referer: searchAction },
      });
      cookieJar = mergeCookies(cookieJar, extractSetCookies(getResp.headers));
      html = await getResp.text();
      finalUrl = getResp.url;
    }
  } else {
    html = await postResp.text();
  }

  return { html, cookieJar, finalUrl };
}
