"""Verify live warnings do not flood or survive a repair lifecycle incorrectly."""

import json
import sys
import unittest
from collections import defaultdict, deque
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live_inference import LiveInference, REARM_SAMPLES


class Publisher:
    def __init__(self):
        self.messages = []

    def publish(self, topic, payload, qos):
        self.messages.append((topic, payload, qos))
        return SimpleNamespace(rc=0)


class LiveAlertLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.service = LiveInference.__new__(LiveInference)
        self.service.client = Publisher()
        self.service.thresholds = {"current_excess": 0.2, "failure": 0.1}
        self.service.limits = {"current_excess": 1.5}
        self.service.disabled = set()
        self.service.active_alerts = set()
        self.service.last_alert_minute = {}
        self.service.rearm_counts = {}
        self.service.buffers = defaultdict(lambda: deque(maxlen=30))
        self.service.ready_machines = set()
        self.values = np.array([70.0, 0.4, 2200.0, 50.0, 8.0])

    def test_score_jitter_does_not_repeat_warning(self):
        for minute, score in [(300, 0.25), (310, 0.19), (320, 0.25)]:
            self.service.update_alert(1, minute, self.values, "current_excess", score)
        self.assertEqual(len(self.service.client.messages), 1)

        for index in range(REARM_SAMPLES):
            self.service.update_alert(
                1, 330 + index * 10, self.values, "current_excess", 0.05
            )
        self.service.update_alert(1, 450, self.values, "current_excess", 0.25)
        self.assertEqual(len(self.service.client.messages), 1)

        self.service.update_alert(1, 1800, self.values, "current_excess", 0.25)
        self.assertEqual(len(self.service.client.messages), 2)

    def test_failure_warns_once_until_new_lifecycle(self):
        self.service.update_alert(1, 300, self.values, "failure", 0.2)
        self.service.reset_machine(1)
        self.service.update_alert(1, 3200, self.values, "failure", 0.2)
        self.assertEqual(len(self.service.client.messages), 1)

        self.service.reset_machine(1, new_lifecycle=True)
        self.service.update_alert(1, 3500, self.values, "failure", 0.2)
        self.assertEqual(len(self.service.client.messages), 2)
        payload = json.loads(self.service.client.messages[-1][1])
        self.assertEqual(payload["simulatedMinute"], 3500)
        self.assertEqual(payload["horizonMinutes"], 48 * 60)

    def test_sensor_warning_carries_24_hour_horizon(self):
        self.service.update_alert(1, 300, self.values, "current_excess", 0.25)
        payload = json.loads(self.service.client.messages[-1][1])
        self.assertEqual(payload["simulatedMinute"], 300)
        self.assertEqual(payload["horizonMinutes"], 24 * 60)
        self.assertTrue(payload["prominent"])

    def test_all_sensor_forecasts_are_prominent(self):
        self.service.thresholds.update(temperature=0.1, vibration=0.1)
        self.service.limits.update(temperature=100.0, vibration=1.5)
        self.service.checkpoint = {"eta_bin_minutes": 360}
        curve = np.array([0.01, 0.04, 0.15, 0.30])
        for machine_id, name in enumerate(("temperature", "vibration", "current_excess"), 1):
            self.service.update_alert(machine_id, 300, self.values, name, 0.30, curve)
            payload = json.loads(self.service.client.messages[-1][1])
            self.assertEqual(payload["eventType"], name)
            self.assertTrue(payload["prominent"])
            self.assertIn("around", payload["title"])

    def test_eta_alert_has_variable_timing_and_stable_event_type(self):
        self.service.checkpoint = {"eta_bin_minutes": 360}
        curve = np.array([0.01, 0.03, 0.08, 0.12, 0.18, 0.24, 0.28, 0.40])
        self.service.update_alert(1, 300, self.values, "failure", 0.4, curve)
        payload = json.loads(self.service.client.messages[-1][1])
        self.assertEqual(payload["eventType"], "failure")
        self.assertIn("around 33h", payload["title"])
        self.assertIn("15–48 simulated hours", payload["message"])
        self.assertEqual(payload["horizonMinutes"], 48 * 60)


if __name__ == "__main__":
    unittest.main()
