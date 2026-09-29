"""Score one local CSV sensor history with an offline event checkpoint."""

import argparse
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from evaluate_events import load_model, predict
from loaders.simulator_loader import FEATURES, SAMPLE_INTERVAL


def read_window(path, sequence_length, load_block_minutes=None):
    """Validate metadata, then return only the five model input sensors."""
    frame = pd.read_csv(path)
    required = ["machine_id", "cycle_id", "simulated_minute", *FEATURES]
    missing = [name for name in required if name not in frame]
    if missing:
        raise ValueError(f"CSV is missing columns: {missing}")
    if len(frame) != sequence_length:
        raise ValueError(f"Expected exactly {sequence_length} ordered samples; got {len(frame)}")
    if frame["machine_id"].isna().any() or frame["machine_id"].nunique() != 1:
        raise ValueError("All rows must belong to one machine")
    if frame["cycle_id"].isna().any() or frame["cycle_id"].nunique() != 1:
        raise ValueError("All rows must belong to one repair cycle")
    raw_minutes = pd.to_numeric(frame["simulated_minute"], errors="raise").to_numpy()
    if not np.isfinite(raw_minutes).all() or not np.equal(raw_minutes, np.floor(raw_minutes)).all():
        raise ValueError("Simulated minutes must be finite whole numbers")
    minutes = raw_minutes.astype(np.int64)
    if not np.all(np.diff(minutes) == SAMPLE_INTERVAL):
        raise ValueError(f"Rows must be in order at {SAMPLE_INTERVAL}-minute intervals")
    if load_block_minutes is not None and np.unique(minutes // load_block_minutes).size != 1:
        raise ValueError("All rows must belong to one training load block")
    sensors = frame[list(FEATURES)].to_numpy(dtype=np.float32)
    if not np.isfinite(sensors).all():
        raise ValueError("Sensor values must all be finite")
    return sensors[np.newaxis, :, :], frame.iloc[-1]


def alert_status(name, score, cutoff, last, limits, disabled):
    """Translate one offline score into an alert for an eligible window."""
    if name in disabled:
        return "alert disabled (diagnostic score only)"
    if name in ("temperature", "vibration", "rpm") and last[name] >= limits[name]:
        return "already above example limit"
    if name == "current_excess" and (
        last["current"] - (2.0 + 0.12 * last["load"]) >= limits[name]
    ):
        return "current already abnormal for this load"
    return "alert" if score >= cutoff else "no alert"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path,
                        help="CSV with machine_id, cycle_id, simulated_minute, and five sensor columns")
    args = parser.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    checkpoint, model = load_model(args.checkpoint, device)
    X, last = read_window(
        args.input, checkpoint["sequence_length"], checkpoint.get("load_block_minutes")
    )
    scores = predict(model, X, checkpoint, 1, device)[0]
    cutoffs = checkpoint["alert_thresholds"]
    disabled = set(checkpoint.get("disabled_alerts", []))
    print(f"Machine {int(last['machine_id'])}, cycle {int(last['cycle_id'])}, "
          f"simulated minute {int(last['simulated_minute'])}")
    print("Offline simulator scores; not calibrated factory failure probabilities")
    output_names = tuple(checkpoint["output_names"])
    for column, name in enumerate(output_names):
        horizon = checkpoint["failure_horizon"] if name == "failure" else checkpoint["sensor_horizon"]
        status = alert_status(name, scores[column], cutoffs[name], last,
                              checkpoint["limits"], disabled)
        meaning = {
            "current_excess": f"current abnormal for observed load {last['load']:.1f}%",
            "rapid_health_loss": f"rapid health decline at observed load {last['load']:.1f}%",
        }.get(name, name)
        print(f"{meaning} within {horizon * SAMPLE_INTERVAL / 60:g}h: "
              f"score={scores[column]:.4f}, cutoff={cutoffs[name]:.4f}, {status}")


if __name__ == "__main__":
    main()
