import unittest
from datetime import datetime, timezone
from importlib.machinery import SourceFileLoader

watchdog = SourceFileLoader("local_watchdog", "scripts/local-watchdog.py").load_module()


class LocalWatchdogTest(unittest.TestCase):
    def test_dispatch_only_when_no_successful_or_active_sunday_run(self):
        now = datetime(2026, 10, 11, 2, 20, tzinfo=timezone.utc)
        self.assertEqual(watchdog.decision([], now), "dispatch")
        run = {"createdAt": "2026-10-11T00:07:00Z", "status": "completed", "conclusion": "failure"}
        self.assertEqual(watchdog.decision([run], now), "dispatch")
        self.assertEqual(watchdog.decision([{**run, "status": "in_progress"}], now), "active")
        self.assertEqual(watchdog.decision([{**run, "conclusion": "success"}], now), "ok")


if __name__ == "__main__":
    unittest.main()
