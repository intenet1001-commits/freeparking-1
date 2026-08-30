#!/usr/bin/env python3
"""단일 차량 종일권 등록 테스트. --confirm-apply 없이는 실행하지 않음."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from register import register_cars

URL = os.environ.get("NICEPARK_URL", "")
ID = os.environ.get("NICEPARK_ID", "")
PW = os.environ.get("NICEPARK_PW", "")
TEST_PLATE_LAST4 = os.environ.get("NICEPARK_TEST_LAST4", "")

if "--confirm-apply" not in sys.argv:
    raise SystemExit("DRY RUN: 실제 등록은 --confirm-apply 플래그가 필요합니다.")
if not all((URL, ID, PW, TEST_PLATE_LAST4)):
    raise SystemExit("NICEPARK_URL, NICEPARK_ID, NICEPARK_PW, NICEPARK_TEST_LAST4 환경변수가 필요합니다.")

cars = [{"plate": TEST_PLATE_LAST4, "label": "테스트차량"}]

print("=== HI PARKING 종일권 등록 테스트 ===")
register_cars(URL, ID, PW, cars)
print("=== 완료 ===")
