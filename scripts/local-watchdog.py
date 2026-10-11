#!/usr/bin/env python3
"""Mac backup for the Sunday GitHub Actions parking run (Korea time)."""

import json
import subprocess
import sys
from datetime import datetime, time, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
WORKFLOW = "weekly-parking.yml"
REPO = Path(__file__).resolve().parent.parent


def decision(runs, now):
    if now.astimezone(KST).weekday() != 6:
        return "skip"
    morning = datetime.combine(now.astimezone(KST).date(), time(9), KST)
    today = [r for r in runs if datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")) >= morning]
    if any(r.get("conclusion") == "success" for r in today):
        return "ok"
    if any(r.get("status") in ("queued", "in_progress", "waiting", "pending", "requested") for r in today):
        return "active"
    return "dispatch"


def gh(*args):
    result = subprocess.run(["/opt/homebrew/bin/gh", *args], cwd=REPO,
                            text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"gh {' '.join(args[:2])} failed: {result.stderr.strip()}")
    return result.stdout


def main():
    now = datetime.now(timezone.utc)
    if now.astimezone(KST).weekday() != 6:
        print("[local-watchdog] Sunday KST only")
        return
    local_time = now.astimezone(KST).strftime("%H:%M")
    if local_time in ("10:30", "12:00"):
        kind = "health" if local_time == "10:30" else "summary"
        gh("workflow", "run", "sunday-notifications.yml", "--ref", "main", "-f", f"kind={kind}")
        print(f"[local-watchdog] {kind} notification requested")
    runs = json.loads(gh("run", "list", "--workflow", WORKFLOW, "--limit", "100",
                         "--json", "createdAt,status,conclusion"))
    state = decision(runs, now)
    print(f"[local-watchdog] {now.astimezone(KST).isoformat()} state={state}")
    if state != "dispatch":
        return
    gh("workflow", "run", WORKFLOW, "--ref", "main")
    print("[local-watchdog] dispatched weekly-parking.yml")
    date = now.astimezone(KST).date().isoformat()
    try:
        gh("workflow", "run", "manual-test-push.yml", "--ref", "main",
           "-f", f"event_key=manual:local-watchdog:{date}",
           "-f", "title=무료주차 자동등록 지연",
           "-f", "body=예약 실행을 확인하지 못해 Mac에서 복구 실행을 요청했습니다. 앱에서 결과를 확인해주세요.")
        print("[local-watchdog] alert requested")
    except RuntimeError as error:
        print(f"[local-watchdog] alert request failed: {error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
