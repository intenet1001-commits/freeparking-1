import { getLast4, normalizePlate, extractCandidates } from './register';

export type CarStatusResult = {
  plate: string;
  status: 'not_entered' | 'entered' | 'registered' | 'no_quota' | 'multi_car' | 'error';
  message: string;
};

export type EmitStatusFn = (data: CarStatusResult) => void;

function extractCookies(headers: Headers): string {
  const cookies: string[] = [];
  headers.forEach((val, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(val.split(';')[0]);
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
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return url; }
}

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
    const loginPageResp = await fetch(url, { redirect: 'follow' });
    cookieJar = mergeCookies(cookieJar, extractCookies(loginPageResp.headers));

    const loginResp = await fetch(loginPageResp.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieJar,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: new URLSearchParams({ j_username_form: adminId, j_password_form: adminPw }).toString(),
      redirect: 'follow',
    });
    cookieJar = mergeCookies(cookieJar, extractCookies(loginResp.headers));

    const loginHtml = await loginResp.text();
    if (!loginResp.url.includes('carSearch') && !loginHtml.includes('carSearch')) {
      for (const plate of plates) emit({ plate, status: 'error', message: '로그인 실패' });
      return;
    }

    const carSearchUrl = loginResp.url.includes('carSearch')
      ? loginResp.url : `${baseUrl}/carSearch`;

    for (const plate of plates) {
      const last4 = getLast4(plate);
      const normPlate = normalizePlate(plate);
      try {
        const resp = await fetch(carSearchUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieJar,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          body: new URLSearchParams({ carNumber: last4 }).toString(),
          redirect: 'follow',
        });
        cookieJar = mergeCookies(cookieJar, extractCookies(resp.headers));
        const html = await resp.text();
        const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        if (!bodyText.includes('입차된 차량') && !bodyText.includes('차량번호:')) {
          emit({ plate, status: 'not_entered', message: '입차 없음 (미입차 또는 출차완료)' });
          continue;
        }

        const candidates = extractCandidates(html);
        const btnRe = /input[^>]+type=["']?button["']?[^>]+(?:id=['"][^'"]*BTN_종일[^'"]*['"]|value=['"][^'"]*종일[^'"]*['"])[^>]*>/gi;
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
