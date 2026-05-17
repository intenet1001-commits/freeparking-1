import { CarInput, EmitFn, getLast4, normalizePlate, extractCandidates } from './register';
import { ajparkLogin, searchCar, mergeCookies, extractSetCookies, buildBaseUrl, UA } from './ajpark-http';

// onclick="javascript:MultipleDiscountApply('0','pKey','dCode','dName','carNum','dKind','count',remark)"
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

// 다중 차량 목록 페이지(carSearch POST 200 응답)에서 특정 차량의 pKey 추출
// 전략: onclick_Car('pKey')와 이미지 경로를 각각 단순 추출 후 순서로 매칭
function extractPKeyFromCarList(html: string, targetPlate: string, selectedIdx?: number): string {
  // 1) pKey 목록: onclick_Car('...') 순서대로 추출
  const pKeys = [...html.matchAll(/onclick_Car\('([^']+)'\)/gi)].map(m => m[1]);
  if (!pKeys.length) return '';

  // 2) 사용자 선택 인덱스 우선
  if (selectedIdx !== undefined && selectedIdx < pKeys.length) return pKeys[selectedIdx];

  // 3) 이미지 경로 번호판 순서 매칭: /Images/CH_DATE_PLATE.JPG
  const norm = targetPlate.replace(/[\s\-]/g, '').toUpperCase();
  if (norm) {
    const imgPlates = [...html.matchAll(/\/Images\/([^"'\s<>]+\.(?:JPG|jpg|png))/gi)]
      .map(m => (m[1].replace(/\.[^.]+$/, '').split('_').pop() ?? '').replace(/[\s\-]/g, '').toUpperCase())
      .filter(p => /[가-힣]/.test(p));
    for (let i = 0; i < imgPlates.length && i < pKeys.length; i++) {
      if (imgPlates[i] === norm) return pKeys[i];
    }
  }

  // 4) 단일 항목이면 자동 선택
  return pKeys.length === 1 ? pKeys[0] : '';
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
      let html = result.html;
      let finalUrl = result.finalUrl;
      const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

      if (!bodyText.includes('입차된 차량') && !bodyText.includes('차량번호:')) {
        emit({ plate, status: 'not_entered', message: '입차 없음' });
        continue;
      }

      // 다중 차량 목록 페이지 처리
      // carSearch POST가 200을 반환하면(동일 last4 복수 차량) finalUrl에 pKey가 없고 onclick_Car가 존재
      if (!finalUrl.includes('pKey') && html.includes('onclick_Car')) {
        const listCandidates = extractCandidates(html);

        // 선택 인덱스 결정 (selectedJson → 번호판 자동 매칭 순)
        let selectedIdx: number | undefined;
        if (plate in selectedJson) {
          selectedIdx = Number(selectedJson[plate]);
        } else if (normPlate) {
          for (let i = 0; i < listCandidates.length; i++) {
            if (normalizePlate(listCandidates[i].plate) === normPlate) { selectedIdx = i; break; }
          }
        }

        const listPKey = extractPKeyFromCarList(html, plate, selectedIdx);
        if (!listPKey) {
          // 자동 선택 불가 — 사용자에게 선택 요청
          emit({ plate, status: 'needs_selection', message: '여러 차량 발견 — 선택 필요', candidates: listCandidates.slice(0, 4) });
          continue;
        }

        // 선택된 차량의 discountApply 페이지로 이동
        const discountUrl = `${buildBaseUrl(finalUrl)}/discount/discountApply.cs?pKey=${encodeURIComponent(listPKey)}`;
        const discResp = await fetch(discountUrl, {
          redirect: 'follow',
          headers: { Cookie: cookieJar, 'User-Agent': UA, Referer: finalUrl },
        });
        cookieJar = mergeCookies(cookieJar, extractSetCookies(discResp.headers));
        html = await discResp.text();
        finalUrl = discResp.url;
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
      const btnLabel = btnValue.replace(/\s*\(\d+\)\s*$/, '').trim();
      const isDisabled = /disabled/i.test(btnTag);

      if (isDisabled) {
        const quotaMatch = btnValue.match(/\((\d+)\)\s*$/);
        const quota = quotaMatch ? parseInt(quotaMatch[1]) : null;
        if (quota === 0) {
          emit({ plate, status: 'failed', message: `${btnLabel} 잔여 매수 없음` });
        } else {
          emit({ plate, status: 'skipped', message: `이미 오늘 ${btnLabel} 처리됨` });
        }
        continue;
      }

      // pKey: finalUrl(discountApply.cs?pKey=...)에서 추출, 실패 시 onclick 인자(index 1)에서 추출
      const onclickArgs = parseOnclickArgs(btnTag);
      const dCode = onclickArgs[2] ?? '';
      const dKind = onclickArgs[5] ?? '매수차감';

      const pKeyFromUrl = finalUrl.match(/[?&]pKey=([^&]+)/);
      const pKey = pKeyFromUrl ? decodeURIComponent(pKeyFromUrl[1]) : (onclickArgs[1] ?? '');
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

      // 성공: 리다이렉트 후 URL에 month= 포함 또는 응답 텍스트에 승인/완료
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
