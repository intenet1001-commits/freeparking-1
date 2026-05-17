import { CarInput, EmitFn, getLast4, normalizePlate, extractCandidates } from './register';
import { ajparkLogin, searchCar, mergeCookies, extractSetCookies, buildBaseUrl, UA } from './ajpark-http';

// onclick="javascript:MultipleDiscountApply('0','pKey','dCode','dName','carNum','dKind','count',remark)"
// 인자를 배열로 파싱 (따옴표 제거, 비문자열 항목은 그대로 반환)
function parseOnclickArgs(btnTag: string): string[] {
  const m = btnTag.match(/MultipleDiscountApply\((.+?)\)\s*;/i);
  if (!m) return [];
  const raw = m[1];
  const args: string[] = [];
  let cur = '';
  let inQ = false;
  let qCh = '';
  for (const ch of raw) {
    if (!inQ && (ch === "'" || ch === '"')) { inQ = true; qCh = ch; }
    else if (inQ && ch === qCh) { inQ = false; }
    else if (!inQ && ch === ',') { args.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  args.push(cur.trim());
  return args;
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
      const finalUrl = result.finalUrl; // discountApply.cs?pKey=...
      const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

      if (!bodyText.includes('입차된 차량') && !bodyText.includes('차량번호:')) {
        emit({ plate, status: 'not_entered', message: '입차 없음' });
        continue;
      }

      const candidates = extractCandidates(html);
      const btnRe = /input[^>]+type=["']?button["']?[^>]+(?:id=['"][^'"]*BTN_종일[^'"]*['"]|value=['"][^'"]*종일[^'"]*['"])[^>]*/gi;
      const btnMatches = [...html.matchAll(btnRe)];

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
      const btnValue = (btnTag.match(/value=['"]([^'"]+)['"]/i)?.[1] ?? '종일권').replace(/&nbsp;/gi, ' ');
      const btnLabel = btnValue.replace(/\s*\(\d+\)\s*$/, '').trim(); // "종일권(주말) (20)" → "종일권(주말)"
      const isDisabled = /disabled/i.test(btnTag);

      if (isDisabled) {
        // register.ts와 동일: 버튼 value의 잔여 매수로 판단
        const quotaMatch = btnValue.match(/\((\d+)\)\s*$/);
        const quota = quotaMatch ? parseInt(quotaMatch[1]) : null;
        if (quota === 0) {
          emit({ plate, status: 'failed', message: `${btnLabel} 잔여 매수 없음` });
        } else {
          emit({ plate, status: 'skipped', message: `이미 오늘 ${btnLabel} 처리됨` });
        }
        continue;
      }

      // dCode, dKind, pKey: 버튼 onclick MultipleDiscountApply() 인자에서 추출
      // onclick: MultipleDiscountApply('0','pKey','dCode','dName','carNum','dKind','count',remark)
      const onclickArgs = parseOnclickArgs(btnTag);
      const pKeyFromOnclick = onclickArgs[1] ?? '';
      const dCode = onclickArgs[2] ?? '';
      const dKind = onclickArgs[5] ?? '매수차감';

      // pKey: finalUrl(discountApply.cs?pKey=...)에서 추출, 실패 시 onclick 인자에서 추출
      // POST 200 응답(동일 last4 다중 차량) 시 finalUrl에 pKey 없음 → onclick 인자 사용
      const pKeyFromUrl = finalUrl.match(/[?&]pKey=([^&]+)/);
      const pKey = pKeyFromUrl ? decodeURIComponent(pKeyFromUrl[1]) : pKeyFromOnclick;
      if (!pKey) {
        emit({ plate, status: 'failed', message: `pKey 추출 실패 (finalUrl: ${finalUrl.slice(0, 80)})` });
        continue;
      }

      const display = candidates.length > 0 && chosenIdx < candidates.length ? candidates[chosenIdx].plate : plate;

      // 실제 등록: discountApplyProcRepeat.cs (GET 방식)
      const base = buildBaseUrl(finalUrl);
      const applyUrl = `${base}/discount/discountApplyProcRepeat.cs?pKey=${encodeURIComponent(pKey)}&dCode=${encodeURIComponent(dCode)}&dKind=${encodeURIComponent(dKind)}&fDays=&remark=&repeat=1`;

      const clickResp = await fetch(applyUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Cookie: cookieJar,
          Referer: finalUrl,
          'User-Agent': UA,
        },
      });
      cookieJar = mergeCookies(cookieJar, extractSetCookies(clickResp.headers));
      const afterText = (await clickResp.text()).replace(/<[^>]+>/g, ' ');

      // 성공: 리다이렉트 후 URL에 month= 포함 (정상 처리 결과 페이지)
      if (clickResp.url.includes('month=') || afterText.includes('승인') || afterText.includes('완료')) {
        emit({ plate, status: 'success', message: `${display} ${btnLabel} 등록 완료` });
      } else {
        emit({ plate, status: 'failed', message: `${btnLabel} 등록 실패 (응답: ${afterText.slice(0, 60).trim()})` });
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
