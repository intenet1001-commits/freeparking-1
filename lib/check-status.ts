import { getLast4, normalizePlate, extractCandidates } from './register';
import { ajparkLogin, searchCar } from './ajpark-http';

export type CarStatusResult = {
  plate: string;
  status: 'not_entered' | 'entered' | 'registered' | 'no_quota' | 'multi_car' | 'error';
  message: string;
};

export type EmitStatusFn = (data: CarStatusResult) => void;

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
}
