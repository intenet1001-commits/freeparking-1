import { CarInput, EmitFn, getLast4, normalizePlate, platesMatch, extractCandidates } from './register';
import { ajparkLogin, searchCar, mergeCookies, extractSetCookies, buildBaseUrl, UA } from './ajpark-http';
import {
  parseEntryTime,
  parseEntryDateTime,
  parseDiscountButtons,
  parseMatchedPlate,
  isEntered,
  type DiscountButton,
} from './check-status';

const FETCH_TIMEOUT = 15000;
const ALLDAY_DCODE = '00005'; // 종일권 dCode (실측). 권종 미지정 시 기본값.

// 다중 차량 목록 페이지(carSearch POST 200 응답)에서 특정 차량의 pKey 추출
// 전략: onclick_Car('pKey')와 이미지 경로를 각각 단순 추출 후 순서로 매칭
function extractPKeyFromCarList(html: string, targetPlate: string, selectedIdx?: number): string {
  // 1) pKey 목록: onclick_Car('...') 리터럴 호출만 추출 (function onclick_Car(myPick) 정의는 제외)
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

// 차량별 선호 권종(ticketChoice=dCode)에 맞는 버튼 선택.
// 명시 선택이 있으면 그 dCode 버튼만(없으면 미선택 → 호출측에서 실패 처리),
// 미지정이면 종일권(00005) → kind allDay 순으로 기본 선택.
function selectButton(
  buttons: DiscountButton[],
  choice?: string
): { btn?: DiscountButton; requested: boolean } {
  if (choice) {
    // 명시 선택: 정확 dCode 우선. 종일권(00005) 선택인데 사이트가 종일권 변형(다른 dCode)을
    // 쓰는 경우 kind='allDay'로 폴백 — 미지정 기본 경로와 동일 동작 보장(UI는 둘 다 '종일권').
    const exact = buttons.find(b => b.dCode === choice);
    const btn = exact ?? (choice === ALLDAY_DCODE ? buttons.find(b => b.kind === 'allDay') : undefined);
    return { btn, requested: true };
  }
  const allDay = buttons.find(b => b.dCode === ALLDAY_DCODE) ?? buttons.find(b => b.kind === 'allDay');
  return { btn: allDay, requested: false };
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

  let cookieJar = login.cookieJar;
  let carSearchUrl = login.carSearchUrl;

  // 세션 만료(JSESSIONID 타임아웃) 시 1회 재로그인 후 재조회.
  async function searchWithRetry(last4: string) {
    let r = await searchCar(carSearchUrl, cookieJar, last4);
    cookieJar = r.cookieJar;
    if (r.sessionExpired) {
      const relogin = await ajparkLogin(url, adminId, adminPw);
      if (relogin.ok) {
        cookieJar = relogin.cookieJar;
        carSearchUrl = relogin.carSearchUrl;
        r = await searchCar(carSearchUrl, cookieJar, last4);
        cookieJar = r.cookieJar;
      }
    }
    return r;
  }

  for (const car of cars) {
    const plate = car.plate.trim();
    const last4 = getLast4(plate);
    const normPlate = normalizePlate(plate);
    emit({ plate, status: 'running', message: `'${last4}' 조회 중...` });

    try {
      const result = await searchWithRetry(last4);
      let html = result.html;
      let finalUrl = result.finalUrl;

      // 세션 만료 후 재로그인까지 실패하면 '미입차'와 구분해 명확히 실패 표기
      if (result.sessionExpired) {
        emit({ plate, status: 'failed', message: '세션 만료 — 재로그인 실패 (설정/계정 확인)' });
        continue;
      }

      // 입차 여부: pKey URL / BTN_ 버튼 / onclick_Car 리터럴 호출 (구 '차량번호:' 텍스트 가드 폐기)
      if (!isEntered(html, finalUrl)) {
        emit({ plate, status: 'not_entered', message: '입차 없음' });
        continue;
      }

      // 다중 차량 목록 페이지: pKey 없는 200 응답 + onclick_Car('리터럴') 호출 존재(함수 정의는 제외)
      if (!finalUrl.includes('pKey') && /onclick_Car\('[^']+'\)/.test(html)) {
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
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        });
        cookieJar = mergeCookies(cookieJar, extractSetCookies(discResp.headers));
        html = await discResp.text();
        finalUrl = discResp.url;
      }

      // 단일 차량의 discountApply 페이지 — 할인 버튼 전체 파싱
      const buttons = parseDiscountButtons(html);
      if (buttons.length === 0) {
        emit({ plate, status: 'not_entered', message: '입차 없음 (할인 버튼 없음)' });
        continue;
      }

      const entryTime = parseEntryTime(html);
      const entryAt = parseEntryDateTime(html);
      const entrySuffix = entryTime ? ` · 입차 ${entryTime}` : '';

      // 끝 4자리로 매칭된 실제 차량 번호판. 등록 번호판과 다르면(4자리만 일치)
      // 차단하지 않고 실제 입차 차량에 그대로 등록하되, 어떤 차에 적용됐는지 메시지에 명시.
      const sysPlate = parseMatchedPlate(html) ?? extractCandidates(html)[0]?.plate;
      const display = sysPlate ?? plate;
      const matchNote = sysPlate && !platesMatch(sysPlate, plate) ? ` (끝4자리 일치)` : '';

      // 차량별 권종 선택 (ticketChoice=dCode). 미지정이면 종일권 기본.
      const { btn: target, requested } = selectButton(buttons, car.ticketChoice);
      if (!target) {
        const avail = buttons.map(b => `${b.name}(${b.quota})`).join(', ');
        if (requested) {
          emit({ plate, status: 'failed', message: `${display} 선택 권종 없음 — 가능: ${avail}${matchNote}${entrySuffix}`, entryTime, entryAt });
        } else {
          emit({ plate, status: 'failed', message: `${display} 종일권 없음 — 권종 선택 필요 (가능: ${avail})${matchNote}${entrySuffix}`, entryTime, entryAt });
        }
        continue;
      }

      const btnLabel = target.name;
      const appliedKind: 'allDay' | 'hourly' = target.kind;

      // disabled: 잔여 0이면 소진(실패), 0 아니면 이미 처리됨(패스)
      if (target.disabled) {
        if (target.quota === 0) {
          emit({ plate, status: 'failed', message: `${display} ${btnLabel} 잔여 매수 없음${matchNote}${entrySuffix}`, entryTime, entryAt });
        } else {
          emit({
            plate, status: 'skipped',
            message: `${display} 이미 오늘 ${btnLabel} 처리됨${matchNote}${entrySuffix}`,
            entryTime, entryAt, appliedName: btnLabel, appliedKind,
          });
        }
        continue;
      }

      // 차감방식: 실측 4개 버튼 전부 '매수차감'. 그 외(숙박 등)는 다른 엔드포인트라 수동 처리 안내.
      const dKind = target.dKind || '매수차감';
      if (!dKind.includes('매수차감')) {
        emit({ plate, status: 'failed', message: `${display} ${btnLabel} 권종 종류(${dKind}) 자동등록 미지원 — 수동 등록 필요${matchNote}${entrySuffix}`, entryTime, entryAt });
        continue;
      }

      // pKey: finalUrl(discountApply.cs?pKey=...) 우선, 실패 시 버튼 onclick 인자
      const pKeyFromUrl = finalUrl.match(/[?&]pKey=([^&]+)/);
      const pKey = pKeyFromUrl ? decodeURIComponent(pKeyFromUrl[1]) : target.pKey;
      if (!pKey || !target.dCode) {
        emit({ plate, status: 'failed', message: `${display} 등록 정보 추출 실패 (pKey/dCode)${matchNote}${entrySuffix}`, entryTime, entryAt });
        continue;
      }

      // 실제 등록: discountApplyProcRepeat.cs (GET). repeat=1(1매), remark 빈값.
      const base = buildBaseUrl(finalUrl);
      const applyUrl = `${base}/discount/discountApplyProcRepeat.cs?pKey=${encodeURIComponent(pKey)}&dCode=${encodeURIComponent(target.dCode)}&dKind=${encodeURIComponent(dKind)}&fDays=&remark=&repeat=1`;

      const clickResp = await fetch(applyUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: { Cookie: cookieJar, Referer: finalUrl, 'User-Agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      cookieJar = mergeCookies(cookieJar, extractSetCookies(clickResp.headers));
      const afterText = (await clickResp.text()).replace(/<[^>]+>/g, ' ');

      // 성공판정: 등록 성공 시 discountApplyProcRepeat → discountApply.cs?month=...(달력) 리다이렉트 (역공학 확인).
      // ⚠ '승인'/'완료' 텍스트 폴백은 제거 — discountApply 페이지에 '승인 내역/승인 시각' 등 정적
      //   헤더가 상시 존재해 실패를 성공으로 오판함. month= 가 실측 확인된 유일한 신뢰 신호.
      if (clickResp.url.includes('month=')) {
        emit({
          plate, status: 'success',
          message: `${display} ${btnLabel} 등록 완료${matchNote}${entrySuffix}`,
          entryTime, entryAt, appliedName: btnLabel, appliedKind,
        });
      } else {
        emit({ plate, status: 'failed', message: `${display} ${btnLabel} 등록 실패 (응답: ${afterText.slice(0, 60).trim()})`, entryTime, entryAt });
      }
    } catch (e) {
      const isTimeout = String(e).includes('timeout') || String(e).includes('aborted') || (e as Error)?.name === 'TimeoutError';
      const msg = isTimeout ? '응답 시간 초과 (사이트 무응답)' : `HTTP 오류: ${String(e).slice(0, 80)}`;
      errors.push(`${plate}: ${msg}`);
      emit({ plate, status: 'failed', message: msg });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return { success: errors.length === 0, errors };
}
