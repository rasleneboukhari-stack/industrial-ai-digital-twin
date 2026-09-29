"""Check live health estimates use the trained model and clear on a stop."""

import json
import sys
import unittest
from collections import defaultdict, deque
from pathlib import Path
from types import SimpleNamespace

import torch

AI_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_DIR))

from evaluate import load_model as load_health_model
from evaluate_events import load_model as load_event_model
from live_inference import HEALTH_FORECAST_TOPIC, LiveInference


class Publisher:
    def __init__(self):
        self.messages = []

    def publish(self, topic, payload, qos=0, retain=False):
        self.messages.append((topic, payload, qos, retain))
        return SimpleNamespace(rc=0)


class LiveHealthForecastTests(unittest.TestCase):
    def test_forecast_uses_complete_window_and_clears_on_stop(self):
        service = LiveInference.__new__(LiveInference)
        service.device = torch.device("cpu")
        service.checkpoint, service.model = load_event_model(
            AI_DIR / "models/simulator_event_eta.pt", service.device
        )
        (service.health_checkpoint, service.health_model,
         service.health_mean, service.health_std) = load_health_model(
            AI_DIR / "models/simulator_health_scratch.pt", service.device
        )
        service.sequence_length = 30
        service.output_names = tuple(service.checkpoint["output_names"])
        service.thresholds = service.checkpoint["alert_thresholds"]
        service.limits = service.checkpoint["limits"]
        service.disabled = set(service.output_names)
        service.buffers = defaultdict(lambda: deque(maxlen=30))
        service.last_minute = {}
        service.last_health = {}
        service.active_alerts = set()
        service.last_alert_minute = {}
        service.rearm_counts = {}
        service.ready_machines = set()
        service.client = Publisher()

        sample = {
            "id": 1, "temperature": 57.0, "vibration": 0.3,
            "rpm": 2200.0, "load": 50.0, "current": 8.0,
            "health": 90.0, "running": True, "state": "RUNNING",
        }
        for minute in range(10, 300, 10):
            service.process({**sample, "simulatedMinute": minute})
        topic = f"{HEALTH_FORECAST_TOPIC}/1"
        self.assertFalse(any(message[0] == topic and message[1] for message in service.client.messages))

        service.process({**sample, "simulatedMinute": 300})
        forecasts = [
            message for message in service.client.messages
            if message[0] == topic and message[1]
        ]
        self.assertEqual(len(forecasts), 1)
        self.assertTrue(forecasts[0][3])
        payload = json.loads(forecasts[0][1])
        self.assertEqual(payload["simulatedMinute"], 300)
        self.assertEqual(payload["horizonMinutes"], 300)
        self.assertGreaterEqual(payload["predictedHealth"], 0)
        self.assertLessEqual(payload["predictedHealth"], 100)

        service.process({**sample, "running": False, "simulatedMinute": 310})
        self.assertEqual(service.client.messages[-1], (topic, b"", 1, True))


if __name__ == "__main__":
    unittest.main()
