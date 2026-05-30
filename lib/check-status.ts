import { getLast4, normalizePlate, platesMatch, extractCandidates } from './register';
import { ajparkLogin, searchCar } from './ajpark-http';

export type TicketKind = 'allDay' | 'hourly';

export type CarStatusResult = {
  plate: string;
  status: 'not_entered' | 'entered' | 'registered' | 'no_quota' | 'multi_car' | 'error';
  message: string;
  entryTime?: string;       // "HH:MM" — 입차일시 시각 부분 (표시용)
  entryAt?: string;         // ISO+09:00 — 입차일시 전체 (경과시간 계산용)
  appliedName?: string;     // "종일권(주말)" — registered 시 적용된 할인명
  appliedKind?: TicketKind; // registered 시 'allDay'/'hourly' 구분
  quotaAllDay?: number;     // 종일권 잔여 매수
  quotaHourly?: number;     // 시간권(기본) 잔여 매수
  matchedPlate?: string;    // 시스템이 4자리로 매칭한 실제 전체 번호판이 등록 번호판과 다를 때만 채움 (충돌 경고)
};

export type EmitStatusFn = (data: CarStatusResult) => void;

// 주차 시스템은 끝 4자리로만 검색 → 4자리가 같은 다른 차가 잡힐 수 있음.
// discountApply 페이지의 "차량번호:" 또는 이미지 경로에서 실제 전체 번호판을 추출.
export function parseMatchedPlate(html: string): string | undefined {
  const text = html.replace(/&nbsp;/gi, ' ');
  for (const m of text.matchAll(/차량번호:\s*([가-힣0-9]{5,12})/g)) {
    const v = m[1].trim();
    if (/[가-힣]/.test(v)) return v; // 한글 포함 = 실제 번호판 (빈 폼라벨 제외)
  }
  // fallback: /Images/CH_DATE_번호판.JPG
  return [...html.matchAll(/\/Images\/[^"'<>\s]*_([가-힣0-9]+)\.(?:JPG|jpg|png)/gi)]
    .map(m => m[1]).find(p => /[가-힣]/.test(p));
}

// onclick="javascript:MultipleDiscountApply('dValue','pKey','dCode','dName','carNum','dKind','count',remark)"
// 따옴표로 감싼 인자를 순서대로 추출. 멀티라인 태그라도 onclick 한 줄에 인자가 모두 있음.
export function parseOnclickArgs(btnTag: string): string[] {
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

export function parseEntryTime(html: string): string | undefined {
  const text = html.replace(/&nbsp;/gi, ' ');
  const m = text.match(/입차일시:\s*\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})/);
  return m?.[1];
}

// 입차일시 전체를 KST(+09:00) ISO 문자열로 반환 → 경과시간 계산용.
// 사이트 시각은 KST. Vercel 서버는 UTC라 +09:00 오프셋을 명시해야 절대시각이 어긋나지 않음.
export function parseEntryDateTime(html: string): string | undefined {
  const text = html.replace(/&nbsp;/gi, ' ');
  const m = text.match(/입차일시:\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

export function parseAppliedDiscount(html: string): { name: string; kind: TicketKind } | undefined {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
  const m = text.match(/적용내역\s+([^:]+?)\s*:\s*\d/);
  if (!m) return undefined;
  const name = m[1].trim();
  if (!name || name.length > 30) return undefined;
  return { name, kind: name.includes('종일') ? 'allDay' : 'hourly' };
}

export type DiscountButton = {
  id: string;
  name: string;     // 라벨 (예: "1시간30분할인(기본)")
  quota: number;    // 잔여 매수
  kind: TicketKind;
  disabled: boolean;
  dCode: string;    // 할인코드 (예: "00005" 종일권) — 등록 API의 1차 키
  dKind: string;    // 차감방식 (예: "매수차감"). '매수차감'만 Repeat 엔드포인트 사용
  pKey: string;     // 입차 식별자 (차량 공통). 등록 요청에 필요
};

export function parseDiscountButtons(html: string): DiscountButton[] {
  const result: DiscountButton[] = [];
  // 멀티라인 input 태그: <input ... type="button" ... id="BTN_..." value="...(N)" onclick="...MultipleDiscountApply(...)" [disabled] ...>
  for (const m of html.matchAll(/<input[^>]+type=["']?button["']?[^>]*>/gi)) {
    const tag = m[0];
    const id = tag.match(/id=['"]([^'"]+)['"]/i)?.[1] ?? '';
    if (!id.startsWith('BTN_')) continue;
    const value = (tag.match(/value=['"]([^'"]+)['"]/i)?.[1] ?? '').replace(/&nbsp;/gi, ' ');
    const qm = value.match(/\((\d+)\)\s*$/);
    const quota = qm ? parseInt(qm[1], 10) : 0;
    const name = value.replace(/\s*\(\d+\)\s*$/, '').trim();
    const kind: TicketKind = id.includes('종일') || name.includes('종일') ? 'allDay' : 'hourly';
    const disabled = /disabled/i.test(tag);
    // onclick: MultipleDiscountApply(dValue, pKey, dCode, dName, carNum, dKind, count, remark)
    const args = parseOnclickArgs(tag);
    const pKey = args[1] ?? '';
    const dCode = args[2] ?? '';
    const dKind = args[5] ?? '';
    result.push({ id, name, quota, kind, disabled, dCode, dKind, pKey });
  }
  return result;
}

// 종일권/시간권 각각 대표 잔여매수 추출
// 시간권은 "기본" 라벨 우선, 없으면 첫 시간권 버튼
export function pickQuotas(buttons: DiscountButton[]): { allDay?: number; hourly?: number } {
  const allDayBtns = buttons.filter(b => b.kind === 'allDay');
  const hourlyBtns = buttons.filter(b => b.kind === 'hourly');
  const allDay = allDayBtns[0]?.quota;
  const hourlyBasic = hourlyBtns.find(b => b.name.includes('기본'));
  const hourlyPick = hourlyBasic ?? hourlyBtns[0];
  return { allDay, hourly: hourlyPick?.quota };
}

// 입차 여부를 신뢰 가능한 신호로 판정.
// (구버전은 '입차된 차량'/'차량번호:' 텍스트에 의존했으나 '차량번호:'는 미입차 폼에도 상존하는 라벨이라 오판)
// 신호: (a) finalUrl에 pKey 포함(단일입차→discountApply 리다이렉트),
//      (b) discountApply 페이지의 BTN_ 할인버튼 존재,
//      (c) carSearch 목록 페이지의 onclick_Car('pKey') 리터럴 호출 존재(복수입차).
//      ※ onclick_Car는 'function onclick_Car(myPick)' 정의가 모든 페이지에 상존하므로
//        '(' 뒤에 따옴표 리터럴이 오는 실제 호출만 매치해야 함.
export function isEntered(html: string, finalUrl: string): boolean {
  if (/[?&]pKey=/.test(finalUrl)) return true;
  if (parseDiscountButtons(html).length > 0) return true;
  if (/onclick_Car\('[^']+'\)/.test(html)) return true;
  return false;
}

export async function checkCarStatuses(
  url: string,
  adminId: string,
  adminPw: string,
  plates: string[],
  emit: EmitStatusFn
): Promise<void> {
  const login = await ajparkLogin(url, adminId, adminPw);
  if (!login.ok) {
    for (const plate of plates) emit({ plate, status: 'error', message: login.message });
    return;
  }

  let cookieJar = login.cookieJar;
  let carSearchUrl = login.carSearchUrl;

  // 세션 만료(JSESSIONID 타임아웃) 시 1회 재로그인 후 재조회 (register-http와 동일 정책).
  // register-http에만 있고 여기 없으면 배치 도중 만료 시 입차 차량을 일괄 '미입차'로 오판함.
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

  for (const plate of plates) {
    const last4 = getLast4(plate);
    const normPlate = normalizePlate(plate);
    try {
      const result = await searchWithRetry(last4);
      const html = result.html;

      // 세션 만료 후 재로그인까지 실패하면 '미입차'와 구분해 명확히 오류 표기
      if (result.sessionExpired) {
        emit({ plate, status: 'error', message: '세션 만료 — 재로그인 실패 (설정/계정 확인)' });
        continue;
      }

      if (!isEntered(html, result.finalUrl)) {
        emit({ plate, status: 'not_entered', message: '입차 없음 (미입차 또는 출차완료)' });
        continue;
      }

      const candidates = extractCandidates(html);
      const buttons = parseDiscountButtons(html);
      const entryTime = parseEntryTime(html);
      const entryAt = parseEntryDateTime(html);
      const applied = parseAppliedDiscount(html);
      const { allDay: quotaAllDay, hourly: quotaHourly } = pickQuotas(buttons);

      // isEntered는 통과했지만 후보·버튼이 모두 없으면(예외적 빈 페이지) 미입차로 안전 처리
      if (candidates.length === 0 && buttons.length === 0) {
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

      // 4자리 충돌 감지: 시스템이 매칭한 실제 번호판이 등록 번호판과 다르면 경고용으로 노출
      const sysPlate = parseMatchedPlate(html) ?? candidates[0]?.plate;
      const matchedPlate = sysPlate && !platesMatch(sysPlate, plate) ? sysPlate : undefined;

      const baseFields = { entryTime, entryAt, quotaAllDay, quotaHourly, matchedPlate };

      if (applied) {
        emit({
          plate,
          status: 'registered',
          message: `등록완료 · ${applied.name}`,
          appliedName: applied.name,
          appliedKind: applied.kind,
          ...baseFields,
        });
        continue;
      }

      if (buttons.length === 0) {
        emit({ plate, status: 'entered', message: '입차중 (할인 버튼 없음)', ...baseFields });
        continue;
      }

      const usable = buttons.some(b => !b.disabled && b.quota > 0);
      if (usable) {
        emit({ plate, status: 'entered', message: '입차중 (등록 전)', ...baseFields });
      } else {
        emit({ plate, status: 'no_quota', message: '입차중 (잔여 매수 없음)', ...baseFields });
      }
    } catch (e) {
      emit({ plate, status: 'error', message: `조회 오류: ${String(e).slice(0, 80)}` });
    }
    await new Promise(r => setTimeout(r, 500));
  }
}
