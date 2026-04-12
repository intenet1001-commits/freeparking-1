#!/usr/bin/env python3
"""
HI PARKING (AJ파크) 종일권 자동 등록 스크립트
URL: ajacecg.ajpark.kr

플로우:
  로그인 → 차량번호 뒷 4자리 검색 → (중복 시 자동/수동 선택) → 종일권 버튼 클릭 → confirm OK
"""

import os
import sys
import json
import time
import re


def emit(plate: str, status: str, message: str, **extra):
    """SSE 이벤트 출력 (Next.js 스트림 수신용)"""
    data = {"plate": plate, "status": status, "message": message}
    data.update(extra)
    print(json.dumps(data, ensure_ascii=False), flush=True)


def normalize_plate(plate: str) -> str:
    """공백·특수문자 제거 후 대문자 (비교용)"""
    return re.sub(r"[\s\-]", "", plate).upper()


def get_last4(plate: str) -> str:
    """차량번호에서 마지막 4자리 숫자 추출"""
    digits = re.findall(r"\d", plate)
    return "".join(digits[-4:]) if len(digits) >= 4 else plate.strip()


def extract_candidates(content: str) -> list:
    """HTML에서 입차 차량 후보 목록 추출 (이미지 파일명 기반)"""
    candidates = []
    seen = set()

    # /Images/CHANNEL_DATE_번호판.JPG 패턴
    img_paths = re.findall(r'/Images/([^"\'<>\s]+\.(?:JPG|jpg|png))', content)
    for img_path in img_paths:
        fname = img_path.rsplit(".", 1)[0]      # 확장자 제거
        last_seg = fname.split("_")[-1]          # 마지막 _ 이후 = 번호판
        if last_seg and last_seg not in seen and re.search(r"[가-힣]", last_seg):
            seen.add(last_seg)
            candidates.append({
                "plate": last_seg,
                "imageUrl": f"/Images/{img_path}",
            })

    # 이미지가 없으면 body 텍스트에서 번호판 패턴 추출
    if not candidates:
        for m in re.finditer(r"\b(\d{2,3}[가-힣]\d{4}|[가-힣]{2}\d{2}[가-힣]\d{4})\b", content):
            p = m.group(1)
            if p not in seen:
                seen.add(p)
                candidates.append({"plate": p})

    return candidates


def register_cars(url: str, admin_id: str, admin_pw: str, cars: list, selected_json: dict):
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    except ImportError:
        for car in cars:
            emit(car["plate"], "failed",
                 "playwright 미설치: pip install playwright && playwright install chromium")
        return

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # confirm/alert 다이얼로그 자동 수락
        page.on("dialog", lambda d: d.accept())

        # ── 로그인 ─────────────────────────────────────────────────────
        try:
            page.goto(url, timeout=15000)
            page.wait_for_load_state("networkidle", timeout=10000)
            page.fill("input[name='j_username_form']", admin_id)
            page.fill("input[name='j_password_form']", admin_pw)
            page.click("a:has-text('로그인')")
            page.wait_for_timeout(3000)

            if "carSearch" not in page.url:
                for car in cars:
                    emit(car["plate"], "failed", "로그인 실패 (아이디/비밀번호 확인)")
                browser.close()
                return

        except Exception as e:
            for car in cars:
                emit(car["plate"], "failed", f"로그인 오류: {str(e)[:120]}")
            browser.close()
            return

        # ── 차량별 처리 ────────────────────────────────────────────────
        for car in cars:
            plate = car["plate"].strip()
            last4 = get_last4(plate)
            norm_plate = normalize_plate(plate)
            emit(plate, "running", f"'{last4}' 조회 중...")

            try:
                page.fill("#carNumber", last4)
                page.click("input[type=submit]")
                page.wait_for_timeout(2000)

                body_text = page.inner_text("body")
                content = page.content()

                if "입차된 차량" not in body_text and "차량번호:" not in body_text:
                    emit(plate, "skipped", "입차 없음")
                    continue

                candidates = extract_candidates(content)

                # 종일권 버튼 전체 조회
                btns = page.query_selector_all("input[type=button][id*='BTN_종일']")
                if not btns:
                    btns = page.query_selector_all("input[type=button][value*='종일']")

                # ── 선택 인덱스 결정 ───────────────────────────────────
                chosen_idx = None

                # 1) selected_json에 사용자가 직접 선택한 인덱스
                if plate in selected_json:
                    chosen_idx = int(selected_json[plate])

                # 2) 전체 번호판으로 자동 매칭 (예: "325무9913" → 이미지 파일명 비교)
                if chosen_idx is None and norm_plate and candidates:
                    for i, c in enumerate(candidates):
                        if normalize_plate(c["plate"]) == norm_plate:
                            chosen_idx = i
                            break

                # 3) 후보/버튼이 1개 이하면 자동 선택
                if chosen_idx is None:
                    n = max(len(candidates), len(btns))
                    if n <= 1:
                        chosen_idx = 0

                # 4) 여전히 결정 못 하면 프론트에 선택 요청
                if chosen_idx is None:
                    emit(plate, "needs_selection",
                         "여러 차량 발견 — 선택 필요",
                         candidates=candidates[:4])
                    continue

                # ── 버튼 클릭 ─────────────────────────────────────────
                btn = (btns[chosen_idx] if chosen_idx < len(btns)
                       else (btns[0] if btns else None))

                if not btn:
                    emit(plate, "failed", "종일권 버튼 없음 (메뉴 구조 확인 필요)")
                    continue

                btn_value = btn.get_attribute("value") or "종일권"
                btn_label = btn_value.split("(")[0].strip()

                is_disabled = btn.is_disabled() or btn.get_attribute("disabled") is not None
                if is_disabled:
                    if "적용내역" in body_text or "승인" in body_text:
                        emit(plate, "skipped", f"이미 오늘 {btn_label} 처리됨")
                    else:
                        emit(plate, "failed", f"{btn_label} 잔여 매수 없음")
                    continue

                btn.click()
                page.wait_for_timeout(1500)

                body_after = page.inner_text("body")
                display = (candidates[chosen_idx]["plate"]
                           if candidates and chosen_idx < len(candidates)
                           else plate)

                if "승인" in body_after or "적용" in body_after:
                    emit(plate, "success", f"{display} {btn_label} 등록 완료")
                else:
                    emit(plate, "success", f"{btn_label} 처리 완료 (결과 확인 필요)")

            except PWTimeout:
                emit(plate, "failed", "응답 시간 초과")
            except Exception as e:
                emit(plate, "failed", f"오류: {str(e)[:80]}")

            time.sleep(0.8)  # 서버 부하 방지

        browser.close()


if __name__ == "__main__":
    url = os.environ.get("NICEPARK_URL", "")
    admin_id = os.environ.get("NICEPARK_ID", "")
    admin_pw = os.environ.get("NICEPARK_PW", "")
    cars_json = os.environ.get("CARS_JSON", "[]")
    selected_raw = os.environ.get("SELECTED_JSON", "{}")

    if not all([url, admin_id, admin_pw]):
        print(json.dumps({"error": "환경변수 누락 (URL/ID/PW)"}), flush=True)
        sys.exit(1)

    try:
        cars = json.loads(cars_json)
        selected_json = json.loads(selected_raw)
    except Exception:
        print(json.dumps({"error": "JSON 파싱 실패"}), flush=True)
        sys.exit(1)

    register_cars(url, admin_id, admin_pw, cars, selected_json)
