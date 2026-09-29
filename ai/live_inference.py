"""Run the trained simulator event model against live MQTT telemetry.

This service publishes advisory AI messages only. It has no machine-command
topic and cannot change simulator or PLC state.
"""

import argparse
from collections import defaultdict, deque
from datetime import datetime, timezone
import json
from pathlib import Path
import uuid

import numpy as np
import paho.mqtt.client as mqtt
import torch

from evaluate import load_model as load_health_model, predict as predict_health
from evaluate_events import eta_band, load_model, predict
from loaders.simulator_loader import FEATURES, SAMPLE_INTERVAL
from prepare_dataset import FAILURE_HORIZON, SENSOR_HORIZON


TELEMETRY_TOPIC = "factory/ai/telemetry"
AI_MESSAGE_TOPIC = "factory/ai/messages"
HEALTH_FORECAST_TOPIC = "factory/ai/health"
ALERT_COOLDOWN_MINUTES = 24 * 60
REARM_SAMPLES = 12  # two simulated hours below half the alert cutoff

ALERT_COPY = {
    "temperature": (
        "WARNING", "Temperature risk within 24 hours",
        "The model predicts a new sustained temperature-limit event within 24 simulated hours.",
    ),
    "vibration": (
        "WARNING", "Vibration risk within 24 hours",
        "The model predicts a new sustained vibration-limit event within 24 simulated hours.",
    ),
    "current_excess": (
        "WARNING", "Current risk at this load within 24 hours",
        "The model predicts abnormal current for the observed load within 24 simulated hours.",
    ),
    "rapid_health_loss": (
        "WARNING", "Rapid health decline risk within 24 hours",
        "The model predicts a rapid health decline at the observed load within 24 simulated hours.",
    ),
    "failure": (
        "CRITICAL", "Failure risk within 48 hours",
        "The model predicts a machine failure event within 48 simulated hours.",
    ),
}

RECOMMENDED_ACTIONS = {
    "temperature": (
        "Increase cooling to 90% to slow the predicted temperature rise.",
        {"command": "SET_COOLING", "value": 90, "label": "COOLING 90"},
    ),
    "vibration": (
        "Reduce load toward 55% and inspect the vibration trend.",
        {"command": "REDUCE_LOAD", "targetValue": 55, "label": "REDUCE LOAD"},
    ),
    "current_excess": (
        "Reduce load toward 55% to lower the predicted current demand.",
        {"command": "REDUCE_LOAD", "targetValue": 55, "label": "REDUCE LOAD"},
    ),
    "rapid_health_loss": (
        "Reduce load toward 55% and inspect the machine condition.",
        {"command": "REDUCE_LOAD", "targetValue": 55, "label": "REDUCE LOAD"},
    ),
    "failure": (
        "Stop the machine safely and arrange an inspection.",
        {"command": "STOP", "label": "STOP + INSPECT"},
    ),
}

# Rounded-up 80th-percentile timing errors on held-out simulator machines.
# These are display ranges, not confidence intervals or field guarantees.
ETA_DISPLAY_ERROR_HOURS = {
    "temperature": 13, "vibration": 9, "current_excess": 19, "failure": 18,
}


class LiveInference:
    def __init__(self, checkpoint_path: Path, health_checkpoint_path: Path, broker: str, port: int):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.checkpoint, self.model = load_model(checkpoint_path, self.device)
        self.sequence_length = int(self.checkpoint["sequence_length"])
        self.output_names = tuple(self.checkpoint["output_names"])
        self.thresholds = self.checkpoint["alert_thresholds"]
        self.limits = self.checkpoint["limits"]
        self.disabled = set(self.checkpoint.get("disabled_alerts", []))
        (self.health_checkpoint, self.health_model,
         self.health_mean, self.health_std) = load_health_model(health_checkpoint_path, self.device)
        if self.health_checkpoint["sequence_length"] != self.sequence_length:
            raise ValueError("Health and event models require different sequence lengths")
        self.buffers = defaultdict(lambda: deque(maxlen=self.sequence_length))
        self.last_minute = {}
        self.last_health = {}
        self.active_alerts = set()
        self.last_alert_minute = {}
        self.rearm_counts = {}
        self.ready_machines = set()

        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="industrial_ai_inference",
        )
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.connect(broker, port, keepalive=30)

    def reset_machine(self, machine_id, new_lifecycle=False):
        if self.buffers[machine_id]:
            self.client.publish(f"{HEALTH_FORECAST_TOPIC}/{machine_id}", b"", qos=1, retain=True)
        self.buffers[machine_id].clear()
        self.active_alerts = {
            key for key in self.active_alerts if key[0] != machine_id
        }
        self.rearm_counts = {
            key: count for key, count in self.rearm_counts.items()
            if key[0] != machine_id
        }
        if new_lifecycle:
            self.last_alert_minute = {
                key: minute for key, minute in self.last_alert_minute.items()
                if key[0] != machine_id
            }
        self.ready_machines.discard(machine_id)

    def on_connect(self, client, _userdata, _flags, reason_code, _properties):
        if reason_code != 0:
            raise ConnectionError(f"MQTT connection failed: {reason_code}")
        client.subscribe(TELEMETRY_TOPIC, qos=1)
        print(f"AI subscribed to {TELEMETRY_TOPIC}; device={self.device}", flush=True)

    def on_message(self, _client, _userdata, message):
        try:
            samples = json.loads(message.payload)
            if not isinstance(samples, list):
                raise ValueError("AI telemetry payload must be a sample list")
            for sample in samples:
                self.process({
                    "id": sample["machine_id"],
                    "simulatedMinute": sample["simulated_minute"],
                    "temperature": sample["temperature"],
                    "vibration": sample["vibration"],
                    "rpm": sample["rpm"],
                    "load": sample["load"],
                    "current": sample["current"],
                    "health": sample["health"],
                    "running": sample["running"],
                    "state": "FAILURE" if sample["state_code"] == 3 else "RUNNING",
                })
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            print(f"Ignored invalid telemetry: {error}", flush=True)

    def process(self, telemetry):
        machine_id = int(telemetry["id"])
        minute = int(telemetry["simulatedMinute"])
        health = float(telemetry["health"])
        running = telemetry["running"]
        if machine_id < 1 or minute < 0 or not isinstance(running, bool):
            raise ValueError("invalid machine ID, simulated minute, or running flag")

        values = np.asarray([float(telemetry[name]) for name in FEATURES], dtype=np.float32)
        if not np.isfinite(values).all() or not np.isfinite(health):
            raise ValueError("sensor values and health must be finite")

        previous_health = self.last_health.get(machine_id)
        previous_minute = self.last_minute.get(machine_id)
        self.last_health[machine_id] = health

        if previous_health is not None and health - previous_health > 10:
            self.reset_machine(machine_id, new_lifecycle=True)
            previous_minute = None

        if previous_minute is not None and minute < previous_minute:
            self.reset_machine(machine_id, new_lifecycle=True)
            previous_minute = None

        if not running or telemetry.get("state") == "FAILURE":
            self.reset_machine(machine_id)
            self.last_minute[machine_id] = minute
            return

        if minute % SAMPLE_INTERVAL != 0 or minute == previous_minute:
            return
        if previous_minute is not None and minute - previous_minute != SAMPLE_INTERVAL:
            self.reset_machine(machine_id)

        self.last_minute[machine_id] = minute
        self.buffers[machine_id].append(values)
        if len(self.buffers[machine_id]) == 1:
            self.client.publish(f"{HEALTH_FORECAST_TOPIC}/{machine_id}", b"", qos=1, retain=True)
        if len(self.buffers[machine_id]) != self.sequence_length:
            return

        if machine_id not in self.ready_machines:
            self.ready_machines.add(machine_id)
            print(f"Machine {machine_id} has a complete inference window", flush=True)

        window = np.asarray(self.buffers[machine_id], dtype=np.float32)[np.newaxis, :, :]
        scores = predict(self.model, window, self.checkpoint, 1, self.device)[0]
        health = float(predict_health(
            self.health_model, window, self.health_mean, self.health_std,
            self.health_checkpoint["target_scale"], 1, self.device,
        )[0])
        forecast = {
            "machineId": machine_id,
            "simulatedMinute": minute,
            "horizonMinutes": self.health_checkpoint["horizon"] * SAMPLE_INTERVAL,
            "predictedHealth": round(max(0.0, min(100.0, health)), 1),
        }
        self.client.publish(
            f"{HEALTH_FORECAST_TOPIC}/{machine_id}", json.dumps(forecast), qos=1, retain=True
        )
        for column, name in enumerate(self.output_names):
            if scores.ndim == 2:
                curve = scores[column, :8 if name == "failure" else 4]
                self.update_alert(machine_id, minute, values, name, float(curve[-1]), curve)
            else:
                self.update_alert(machine_id, minute, values, name, float(scores[column]))

    def update_alert(self, machine_id, minute, values, name, score, eta_curve=None):
        key = (machine_id, name)
        cutoff = float(self.thresholds[name])
        if name in self.disabled or self.already_in_event(name, values):
            self.active_alerts.discard(key)
            self.rearm_counts.pop(key, None)
            return
        if key in self.active_alerts:
            if score <= cutoff * 0.5:
                count = self.rearm_counts.get(key, 0) + 1
                self.rearm_counts[key] = count
                if count >= REARM_SAMPLES:
                    self.active_alerts.discard(key)
                    self.rearm_counts.pop(key, None)
            else:
                self.rearm_counts.pop(key, None)
            if key in self.active_alerts:
                return

        if score < cutoff:
            return
        last_minute = self.last_alert_minute.get(key)
        if last_minute is not None:
            if name == "failure" or minute - last_minute < ALERT_COOLDOWN_MINUTES:
                return

        severity, title, body = ALERT_COPY[name]
        if eta_curve is not None and name in ETA_DISPLAY_ERROR_HOURS:
            lower, upper = eta_band(eta_curve, self.checkpoint["eta_bin_minutes"])
            center_hours = round((lower + upper) / 120)
            uncertainty = ETA_DISPLAY_ERROR_HOURS[name]
            max_hours = 48 if name == "failure" else 24
            timing_range = (max(0, center_hours - uncertainty),
                            min(max_hours, center_hours + uncertainty))
            event_label = "Current at this load" if name == "current_excess" else name.title()
            title = f"{event_label} risk around {center_hours}h"
            body += (f" Rough timing range: {timing_range[0]}–{timing_range[1]} "
                     "simulated hours; this is a broad estimate, not a deadline.")
        recommended_action, recommended_command = RECOMMENDED_ACTIONS[name]
        payload = {
            "id": f"ai-{machine_id}-{name}-{minute}-{uuid.uuid4().hex[:8]}",
            "machineId": machine_id,
            "severity": severity,
            "kind": "PREDICTION",
            "eventType": name,
            "title": title,
            "message": f"{body} Model score: {score:.3f}; alert cutoff: {cutoff:.3f}.",
            "recommendedAction": recommended_action,
            "recommendedCommand": recommended_command,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "simulatedMinute": minute,
            "horizonMinutes": (
                FAILURE_HORIZON if name == "failure" else SENSOR_HORIZON
            ) * SAMPLE_INTERVAL,
            "prominent": name in ("temperature", "vibration", "current_excess", "failure"),
        }
        result = self.client.publish(AI_MESSAGE_TOPIC, json.dumps(payload), qos=1)
        if result.rc != mqtt.MQTT_ERR_SUCCESS:
            print(f"AI message publish failed for machine {machine_id}: {result.rc}", flush=True)
        else:
            self.active_alerts.add(key)
            self.last_alert_minute[key] = minute
            print(f"Published {name} alert for machine {machine_id}: {score:.3f}", flush=True)

    def already_in_event(self, name, values):
        by_name = dict(zip(FEATURES, values))
        if name in ("temperature", "vibration", "rpm"):
            return by_name[name] >= self.limits[name]
        if name == "current_excess":
            excess = by_name["current"] - (2.0 + 0.12 * by_name["load"])
            return excess >= self.limits[name]
        return False

    def run(self):
        print("AI MQTT inference starting; advisory messages only", flush=True)
        try:
            self.client.loop_forever()
        except KeyboardInterrupt:
            print("AI MQTT inference stopped", flush=True)
        finally:
            self.client.disconnect()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path,
                        default=Path(__file__).resolve().parent / "models/simulator_event_eta.pt")
    parser.add_argument("--health-checkpoint", type=Path,
                        default=Path(__file__).resolve().parent / "models/simulator_health_scratch.pt")
    parser.add_argument("--broker", default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    args = parser.parse_args()
    LiveInference(args.checkpoint, args.health_checkpoint, args.broker, args.port).run()


if __name__ == "__main__":
    main()
