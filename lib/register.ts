/**
 * TypeScript port of scripts/register.py
 * HI PARKING (AJ파크) 종일권 자동 등록 로직
 */

export type CarInput = { plate: string; label: string };
export type EmitFn = (data: {
  plate: string;
  status: "pending" | "running" | "success" | "failed" | "duplicate" | "skipped" | "needs_selection" | "not_entered";
  message: string;
  candidates?: { plate: string; imageUrl?: string }[];
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

export async function registerCars(
  url: string,
  adminId: string,
  adminPw: string,
  cars: CarInput[],
  selectedJson: Record<string, number>,
  emit: EmitFn
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;

  try {
    if (process.env.VERCEL) {
      const chromiumBin = (await import('@sparticuz/chromium')).default;
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({
        args: chromiumBin.args,
        executablePath: await chromiumBin.executablePath(),
        headless: true,
      });
    } else {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
    }
  } catch (e) {
    for (const car of cars) {
      emit({ plate: car.plate, status: 'failed', message: `브라우저 실행 실패: ${String(e).slice(0, 80)}` });
    }
    return;
  }

  const page = await browser.newPage();

  // confirm/alert 자동 수락
  page.on('dialog', (dialog: { accept: () => Promise<void> }) => dialog.accept());

  // ── 로그인 ────────────────────────────────────────────────────────
  try {
    await page.goto(url, { timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await page.fill("input[name='j_username_form']", adminId);
    await page.fill("input[name='j_password_form']", adminPw);
    await page.click("a:has-text('로그인')");
    await page.waitForTimeout(3000);

    if (!page.url().includes('carSearch')) {
      for (const car of cars) {
        emit({ plate: car.plate, status: 'failed', message: '로그인 실패 (아이디/비밀번호 확인)' });
      }
      await browser.close();
      return;
    }
  } catch (e) {
    for (const car of cars) {
      emit({ plate: car.plate, status: 'failed', message: `로그인 오류: ${String(e).slice(0, 120)}` });
    }
    await browser.close();
    return;
  }

  // ── 차량별 처리 ───────────────────────────────────────────────────
  for (const car of cars) {
    const plate = car.plate.trim();
    const last4 = getLast4(plate);
    const normPlate = normalizePlate(plate);
    emit({ plate, status: 'running', message: `'${last4}' 조회 중...` });

    try {
      await page.fill('#carNumber', last4);
      await page.click('input[type=submit]');
      await page.waitForTimeout(2000);

      const bodyText: string = await page.innerText('body');
      const content: string = await page.content();

      if (!bodyText.includes('입차된 차량') && !bodyText.includes('차량번호:')) {
        emit({ plate, status: 'not_entered', message: '입차 없음' });
        continue;
      }

      const candidates = extractCandidates(content);

      // 종일권 버튼 조회
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let btns: any[] = await page.$$("input[type=button][id*='BTN_종일']");
      if (btns.length === 0) {
        btns = await page.$$("input[type=button][value*='종일']");
      }

      // 후보도 버튼도 없으면 실제로 입차되지 않은 것으로 판단
      if (candidates.length === 0 && btns.length === 0) {
        emit({ plate, status: 'not_entered', message: '입차 없음' });
        continue;
      }

      // ── 선택 인덱스 결정 ──────────────────────────────────────────
      let chosenIdx: number | null = null;

      // 1) selectedJson에 사용자가 직접 선택한 인덱스
      if (plate in selectedJson) {
        chosenIdx = Number(selectedJson[plate]);
      }

      // 2) 전체 번호판으로 자동 매칭
      if (chosenIdx === null && normPlate && candidates.length > 0) {
        for (let i = 0; i < candidates.length; i++) {
          if (normalizePlate(candidates[i].plate) === normPlate) {
            chosenIdx = i;
            break;
          }
        }
      }

      // 3) 후보/버튼이 1개 이하면 자동 선택
      if (chosenIdx === null) {
        const n = Math.max(candidates.length, btns.length);
        if (n <= 1) chosenIdx = 0;
      }

      // 4) 여전히 결정 못 하면 프론트에 선택 요청
      if (chosenIdx === null) {
        emit({
          plate,
          status: 'needs_selection',
          message: '여러 차량 발견 — 선택 필요',
          candidates: candidates.slice(0, 4),
        });
        continue;
      }

      // ── 버튼 클릭 ─────────────────────────────────────────────────
      const btn = chosenIdx < btns.length ? btns[chosenIdx] : (btns[0] ?? null);

      if (!btn) {
        // 디버그: 페이지의 모든 버튼 value 수집
        const allBtns: any[] = await page.$$("input[type=button]");
        const btnValues: string[] = [];
        for (const b of allBtns.slice(0, 10)) {
          const v = await b.getAttribute('value') ?? '';
          if (v) btnValues.push(v);
        }
        const hint = btnValues.length > 0 ? `[버튼목록: ${btnValues.join(', ')}]` : '[버튼 없음]';
        emit({ plate, status: 'failed', message: `종일권 버튼 없음 ${hint}` });
        continue;
      }

      const btnValue: string = (await btn.getAttribute('value')) ?? '종일권';
      const btnLabel = btnValue.split('(')[0].trim();

      const isDisabled: boolean =
        (await btn.isDisabled()) || (await btn.getAttribute('disabled')) !== null;

      if (isDisabled) {
        if (bodyText.includes('적용내역') || bodyText.includes('승인')) {
          emit({ plate, status: 'skipped', message: `이미 오늘 ${btnLabel} 처리됨` });
        } else {
          emit({ plate, status: 'failed', message: `${btnLabel} 잔여 매수 없음` });
        }
        continue;
      }

      await btn.click();
      await page.waitForTimeout(1500);

      const bodyAfter: string = await page.innerText('body');
      const display =
        candidates.length > 0 && chosenIdx < candidates.length
          ? candidates[chosenIdx].plate
          : plate;

      if (bodyAfter.includes('승인') || bodyAfter.includes('적용')) {
        emit({ plate, status: 'success', message: `${display} ${btnLabel} 등록 완료` });
      } else {
        emit({ plate, status: 'success', message: `${btnLabel} 처리 완료 (결과 확인 필요)` });
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes('Timeout') || msg.includes('timeout')) {
        emit({ plate, status: 'failed', message: '응답 시간 초과' });
      } else {
        emit({ plate, status: 'failed', message: `오류: ${msg.slice(0, 80)}` });
      }
    }

    // 서버 부하 방지
    await new Promise((r) => setTimeout(r, 800));
  }

  await browser.close();
}
