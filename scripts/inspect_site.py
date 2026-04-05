#!/usr/bin/env python3
"""AJ파크 HI PARKING - 차량 검색 → 종일권 등록 흐름 분석"""
from playwright.sync_api import sync_playwright
import time

URL = "http://ajacecg.ajpark.kr/login_m.cs"
ID = "ACEA0204"
PW = "1111"
TEST_PLATE_LAST4 = "9913"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, slow_mo=700)
    page = browser.new_page()

    # 1. 로그인
    page.goto(URL, timeout=15000)
    page.wait_for_load_state("networkidle")
    page.fill("input[name='j_username_form']", ID)
    page.fill("input[name='j_password_form']", PW)
    page.click("a:has-text('로그인')")
    page.wait_for_load_state("networkidle", timeout=10000)
    print(f"로그인 성공: {page.url}")

    # 2. 차량번호 입력 후 검색
    print(f"\n=== '{TEST_PLATE_LAST4}' 검색 ===")
    page.fill("#carNumber", TEST_PLATE_LAST4)

    # submit 버튼 클릭
    page.click("input[type=submit]")
    page.wait_for_timeout(2000)
    page.screenshot(path="/tmp/search_result.png")
    print("검색 결과: /tmp/search_result.png")

    # 결과 분석
    print("\n=== 검색 결과 전체 텍스트 ===")
    body_text = page.inner_text("body")
    print(body_text[:2000])

    print("\n=== 이미지 태그 ===")
    imgs = page.query_selector_all("img")
    for img in imgs:
        src = img.get_attribute("src") or ""
        alt = img.get_attribute("alt") or ""
        print(f"  img src={src[:60]} alt={alt}")

    print("\n=== 클릭 가능한 요소 (결과 목록) ===")
    clickables = page.query_selector_all("a, button, input[type=button], tr[onclick], td[onclick]")
    for el in clickables:
        txt = el.inner_text().strip()
        onclick = el.get_attribute("onclick") or el.get_attribute("href") or ""
        if txt or onclick:
            print(f"  [{txt[:40]}] action={onclick[:60]}")

    # HTML 저장
    html = page.content()
    with open("/tmp/search_result.html", "w") as f:
        f.write(html)
    print("\nHTML 저장: /tmp/search_result.html")

    # 3. 차량 선택 및 종일권 버튼 탐색
    print("\n=== 종일권/할인 관련 요소 ===")
    for keyword in ["종일", "할인", "등록", "선택", "적용"]:
        els = page.query_selector_all(f"*:has-text('{keyword}')")
        for el in els[:3]:
            tag = el.evaluate("e=>e.tagName")
            if tag in ["A", "BUTTON", "INPUT", "TD", "LI"]:
                print(f"  [{keyword}] <{tag}> {el.inner_text()[:40]}")

    time.sleep(6)
    browser.close()
    print("\n완료")
