#!/usr/bin/env python3
"""단일 차량 종일권 등록 테스트 (9913)"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from register import register_cars

URL = "http://ajacecg.ajpark.kr/login_m.cs"
ID = "ACEA0204"
PW = "1111"

cars = [{"plate": "9913", "label": "테스트차량"}]

print("=== HI PARKING 종일권 등록 테스트 ===")
register_cars(URL, ID, PW, cars)
print("=== 완료 ===")
