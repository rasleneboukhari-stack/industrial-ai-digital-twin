"""Boundary checks for simulator event labels (no database required)."""

import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prepare_dataset import build_event_sequences
from predict_events import alert_status, read_window
from train_events import ETA_BIN_COUNT, cumulative_risks, eta_targets
from evaluate_events import eta_band, horizon_scores


class EventSequenceTests(unittest.TestCase):
    def test_eta_bands_use_event_time_and_observed_mask(self):
        labels = np.array([[1, 0, 0, 0, 1], [0, 0, 0, 0, 0]], dtype=np.float32)
        observed = np.array([[True, True, False, True, True],
                             [True, True, True, True, False]])
        groups = pd.DataFrame({
            "input_minute": [1000, 1000],
            "temperature_event_minute": [1900, -1],
            "vibration_event_minute": [-1, -1],
            "current_excess_event_minute": [-1, -1],
            "rapid_health_loss_event_minute": [-1, -1],
            "failure_event_minute": [2800, -1],
        })
        names = ("temperature", "vibration", "current_excess",
                 "rapid_health_loss", "failure")
        targets, mask = eta_targets(labels, observed, groups, names)
        self.assertEqual(targets.shape, (2, 5, ETA_BIN_COUNT))
        self.assertEqual(targets[0, 0, :4].tolist(), [0, 0, 1, 1])
        self.assertEqual(targets[0, 4].tolist(), [0, 0, 0, 0, 1, 1, 1, 1])
        self.assertFalse(mask[0, 2].any())
        self.assertFalse(mask[1, 4].any())
        self.assertEqual(np.flatnonzero(mask[0, 3]).tolist(), [3])
        risks = cumulative_risks(torch.zeros((1, 5 * ETA_BIN_COUNT)), 5)
        self.assertTrue(torch.all(risks[:, :, 1:] >= risks[:, :, :-1]))
        self.assertEqual(eta_band(np.array([0.1, 0.2, 0.8, 1.0]), 360), (720, 1080))
        self.assertEqual(horizon_scores(risks.numpy(), names).shape, (1, 5))

    def test_load_context_current_health_and_load_blocks(self):
        rows = 300
        minute = np.arange(rows) * 10
        load = np.repeat([30.0, 90.0, 50.0], 100)
        health = np.r_[
            100.0 - 0.01 * np.arange(100),
            99.0 - 0.10 * np.arange(100),
            89.0 - 0.01 * np.arange(100),
        ]
        current = 2.0 + 0.12 * load
        current[150:153] += 2.0  # new three-sample excess-current episode
        frame = pd.DataFrame({
            "simulated_minute": minute, "temperature": 70.0,
            "vibration": 0.4, "rpm": 800.0 + 30.0 * load,
            "load": load, "current": current, "health": health,
            "running": True, "state_code": 0,
        })
        limits = {"temperature": 100.0, "vibration": 1.5,
                  "current_excess": 1.5, "rapid_health_loss": 2.5}
        now = datetime.now(timezone.utc)
        with patch("prepare_dataset.load_simulator_run", return_value=frame):
            X, labels, observed, groups = build_event_sequences(
                1, now, now, limits, sensor_horizon=30, failure_horizon=40,
                profile="load_context", load_block_minutes=1000,
            )
        self.assertEqual(X.shape[1:], (30, 5))
        self.assertEqual(labels.shape, (len(X), 5))
        by_minute = {int(value): i for i, value in enumerate(groups.input_minute)}
        self.assertEqual(labels[by_minute[1300], 2], 1)  # current excess ahead
        self.assertEqual(groups.iloc[by_minute[1300]].current_excess_event_minute, 1520)
        self.assertEqual(labels[by_minute[1300], 3], 1)  # rapid future health loss
        self.assertFalse(observed[by_minute[1510], 2])  # already abnormal current
        self.assertEqual(labels[by_minute[500], 3], 0)  # slow decline at low load
        self.assertNotIn(1700, by_minute)  # no target across a load-block boundary
        self.assertEqual(groups.iloc[by_minute[1300]].load_block_id, 1)

    def test_offline_prediction_window_metadata(self):
        frame = pd.DataFrame({
            "machine_id": [1] * 30, "cycle_id": [0] * 30,
            "simulated_minute": np.arange(30) * 10,
            "temperature": [70.0] * 30, "vibration": [0.8] * 30,
            "rpm": [2300.0] * 30, "load": [50.0] * 30,
            "current": [10.0] * 30,
        })
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "window.csv"
            frame.to_csv(path, index=False)
            X, _ = read_window(path, 30)
            self.assertEqual(X.shape, (1, 30, 5))
            frame["simulated_minute"] = np.arange(30) * 10 + 800
            frame.to_csv(path, index=False)
            with self.assertRaisesRegex(ValueError, "one training load block"):
                read_window(path, 30, load_block_minutes=1000)
            frame["simulated_minute"] = np.arange(30) * 10
            frame.loc[15, "cycle_id"] = 1
            frame.to_csv(path, index=False)
            with self.assertRaisesRegex(ValueError, "one repair cycle"):
                read_window(path, 30)
            frame.loc[15, "cycle_id"] = 0
            frame["simulated_minute"] = frame["simulated_minute"].astype(float)
            frame.loc[15, "simulated_minute"] = 150.5
            frame.to_csv(path, index=False)
            with self.assertRaisesRegex(ValueError, "whole numbers"):
                read_window(path, 30)

    def test_offline_current_alert_uses_load_context(self):
        last = pd.Series({"load": 90.0, "current": 13.2,
                          "temperature": 70.0, "vibration": 0.5})
        limits = {"current_excess": 1.5, "rapid_health_loss": 3.0}
        self.assertEqual(alert_status("current_excess", 0.8, 0.6, last, limits, set()),
                         "alert")
        self.assertEqual(alert_status("rapid_health_loss", 0.8, 0.6, last, limits, set()),
                         "alert")
        last["current"] = 14.5
        self.assertEqual(alert_status("current_excess", 0.8, 0.6, last, limits, set()),
                         "current already abnormal for this load")

    def test_events_censoring_and_repair_boundaries(self):
        rows = 700
        temperature = np.full(rows, 25.0)
        temperature[200:203] = 101.0  # confirmed at minute 2020
        temperature[600:603] = 101.0  # separate event after repair
        health = np.full(rows, 80.0)
        health[320:330] = 10.0
        health[330:] = 100.0
        state = np.zeros(rows, dtype=np.int8)
        state[320:330] = 3
        frame = pd.DataFrame({
            "simulated_minute": np.arange(rows) * 10,
            "temperature": temperature,
            "vibration": 0.2,
            "rpm": 2000.0,
            "load": 50.0,
            "current": 10.0,
            "health": health,
            "running": True,
            "state_code": state,
        })
        limits = {"temperature": 100.0, "vibration": 1.5, "rpm": 2500.0}
        now = datetime.now(timezone.utc)
        with patch("prepare_dataset.load_simulator_run", return_value=frame):
            X, labels, observed, groups = build_event_sequences(1, now, now, limits)

        self.assertEqual(X.shape[1:], (30, 5))
        self.assertEqual(labels.shape, observed.shape)
        self.assertEqual(labels.shape[1], 4)
        by_minute = {int(minute): i for i, minute in enumerate(groups.input_minute)}
        before_event = by_minute[1700]
        self.assertEqual(labels[before_event, 0], 1)
        self.assertEqual(groups.iloc[before_event].temperature_event_minute, 2020)
        self.assertEqual(labels[before_event, 3], 1)
        self.assertEqual(groups.iloc[before_event].failure_event_minute, 3200)
        self.assertEqual(labels[by_minute[580], 0], 1)  # exactly 144 samples ahead
        self.assertEqual(labels[by_minute[570], 0], 0)  # 145 samples ahead
        self.assertEqual(labels[by_minute[320], 3], 1)  # exactly 288 samples ahead
        self.assertEqual(labels[by_minute[310], 3], 0)  # 289 samples ahead
        self.assertFalse(observed[by_minute[2010], 0])  # already above limit
        self.assertFalse(observed[by_minute[3000], 0])  # failure censors sensor negative
        self.assertTrue(labels[by_minute[3190], 3])  # failure before cycle ends
        self.assertNotIn(3250, by_minute)  # no predictions in failed state
        self.assertEqual(groups.loc[groups.input_minute == 5800, "cycle_id"].iloc[0], 1)
        self.assertFalse(np.any((groups.cycle_id == 0) &
                                (groups.temperature_event_minute == 6020)))


if __name__ == "__main__":
    unittest.main()
