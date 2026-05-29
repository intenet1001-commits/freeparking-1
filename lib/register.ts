/**
 * HI PARKING (AJ파크) 무료주차 공용 유틸 + 타입.
 * 등록 실로직은 lib/register-http.ts(registerCarsHttp). 과거 Playwright 구현(registerCars)은
 * API route 미사용 데드코드라 제거됨 — 공용 유틸/타입만 보존.
 */

export type CarInput = {
  plate: string;
  label: string;
  // 차량별 선호 권종 dCode (예: '00005' 종일권, '00004' 1시간30분).
  // 미지정/없음이면 종일권 기본 (하위호환).
  ticketChoice?: string;
};

export type EmitFn = (data: {
  plate: string;
  status: "pending" | "running" | "success" | "failed" | "duplicate" | "skipped" | "needs_selection" | "not_entered";
  message: string;
  candidates?: { plate: string; imageUrl?: string }[];
  entryTime?: string;
  entryAt?: string;
  appliedName?: string;
  appliedKind?: 'allDay' | 'hourly';
}) => void;

export function normalizePlate(plate: string): string {
  return plate.replace(/[\s\-]/g, '').toUpperCase();
}

export function getLast4(plate: string): string {
  const digits = plate.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : plate.trim();
}

export function extractCandidates(
  content: string
): { plate: string; imageUrl?: string }[] {
  const candidates: { plate: string; imageUrl?: string }[] = [];
  const seen = new Set<string>();

  // /Images/CHANNEL_DATE_번호판.JPG 패턴
  const imgRe = /\/Images\/([^"'<>\s]+\.(?:JPG|jpg|png))/g;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(content)) !== null) {
    const imgPath = m[1];
    const fname = imgPath.replace(/\.[^.]+$/, '');
    const lastSeg = fname.split('_').pop() ?? '';
    if (lastSeg && !seen.has(lastSeg) && /[가-힣]/.test(lastSeg)) {
      seen.add(lastSeg);
      candidates.push({ plate: lastSeg, imageUrl: `/Images/${imgPath}` });
    }
  }

  // 이미지가 없으면 텍스트에서 번호판 패턴 추출
  if (candidates.length === 0) {
    const plateRe = /\b(\d{2,3}[가-힣]\d{4}|[가-힣]{2}\d{2}[가-힣]\d{4})\b/g;
    while ((m = plateRe.exec(content)) !== null) {
      const p = m[1];
      if (!seen.has(p)) {
        seen.add(p);
        candidates.push({ plate: p });
      }
    }
  }

  return candidates;
}
