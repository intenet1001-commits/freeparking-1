import { CarInput, EmitFn, getLast4, normalizePlate, extractCandidates } from './register';
import { ajparkLogin, searchCar, mergeCookies, extractSetCookies, resolveUrl, parseHiddenInputs, UA } from './ajpark-http';

export async function registerCarsHttp(
  url: string,
  adminId: string,
  adminPw: string,
  cars: CarInput[],
  selectedJson: Record<string, number>,
  emit: EmitFn
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  const login = await ajparkLogin(url, adminId, adminPw);
  if (!login.ok) {
    for (const car of cars) emit({ plate: car.plate, status: 'failed', message: login.message });
    return { success: false, errors: [login.message] };
  }

  let { cookieJar, carSearchUrl } = login;

  for (const car of cars) {
    const plate = car.plate.trim();
    const last4 = getLast4(plate);
    const normPlate = normalizePlate(plate);
    emit({ plate, status: 'running', message: `'${last4}' 조회 중...` });

    try {
      const result = await searchCar(carSearchUrl, cookieJar, last4);
      cookieJar = result.cookieJar;
      const html = result.html;
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
      const formActionRaw = html.match(/<form[^>]+action=['"]([^'"]+)['"]/i)?.[1] ?? '';
      const submitAction = formActionRaw ? resolveUrl(carSearchUrl, formActionRaw) : carSearchUrl;
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

  return { success: errors.length === 0, errors };
}
