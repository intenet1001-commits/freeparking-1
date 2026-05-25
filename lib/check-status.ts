import { getLast4, normalizePlate, extractCandidates } from './register';
import { ajparkLogin, searchCar } from './ajpark-http';

export type TicketKind = 'allDay' | 'hourly';

export type CarStatusResult = {
  plate: string;
  status: 'not_entered' | 'entered' | 'registered' | 'no_quota' | 'multi_car' | 'error';
  message: string;
  entryTime?: string;       // "HH:MM" — 입차일시 시각 부분
  appliedName?: string;     // "종일권(주말)" — registered 시 적용된 할인명
  appliedKind?: TicketKind; // registered 시 'allDay'/'hourly' 구분
  quotaAllDay?: number;     // 종일권 잔여 매수
  quotaHourly?: number;     // 시간권(기본) 잔여 매수
};

export type EmitStatusFn = (data: CarStatusResult) => void;

export function parseEntryTime(html: string): string | undefined {
  const text = html.replace(/&nbsp;/gi, ' ');
  const m = text.match(/입차일시:\s*\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})/);
  return m?.[1];
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
};

export function parseDiscountButtons(html: string): DiscountButton[] {
  const result: DiscountButton[] = [];
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
    result.push({ id, name, quota, kind, disabled });
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

  let { cookieJar, carSearchUrl } = login;

  for (const plate of plates) {
    const last4 = getLast4(plate);
    const normPlate = normalizePlate(plate);
    try {
      const result = await searchCar(carSearchUrl, cookieJar, last4);
      cookieJar = result.cookieJar;
      const html = result.html;
      const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

      if (!bodyText.includes('입차된 차량') && !bodyText.includes('차량번호:')) {
        emit({ plate, status: 'not_entered', message: '입차 없음 (미입차 또는 출차완료)' });
        continue;
      }

      const candidates = extractCandidates(html);
      const buttons = parseDiscountButtons(html);
      const entryTime = parseEntryTime(html);
      const applied = parseAppliedDiscount(html);
      const { allDay: quotaAllDay, hourly: quotaHourly } = pickQuotas(buttons);

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

      const baseFields = { entryTime, quotaAllDay, quotaHourly };

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
