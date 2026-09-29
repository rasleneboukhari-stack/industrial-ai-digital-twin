"""Evaluate simulator future-health checkpoints on a selected ingestion-time run."""

import argparse
from datetime import datetime
from pathlib import Path

import numpy as np
import torch

from loaders.simulator_loader import FEATURES, load_simulator_run
from models.temporal_model import TemporalModel
from prepare_dataset import HORIZON, SEQUENCE_LENGTH, build_simulator_sequences


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True, type=datetime.fromisoformat)
    parser.add_argument("--end", required=True, type=datetime.fromisoformat)
    parser.add_argument("--machines", nargs="+", type=int, required=True)
    parser.add_argument("--checkpoint", nargs="+", type=Path, required=True)
    parser.add_argument("--max-sequences-per-machine", type=int, default=10000)
    parser.add_argument("--low-health-threshold", type=float, default=30.0)
    parser.add_argument("--batch-size", type=int, default=1024)
    args = parser.parse_args()
    if args.start.tzinfo is None or args.end.tzinfo is None or args.start >= args.end:
        parser.error("--start and --end must be timezone-aware and ordered")
    if len(set(args.machines)) != len(args.machines) or any(m < 1 for m in args.machines):
        parser.error("--machines must be unique positive IDs")
    if args.max_sequences_per_machine < 1 or args.batch_size < 1:
        parser.error("window cap and batch size must be positive")
    if not 0 < args.low_health_threshold < 100:
        parser.error("low-health threshold must lie between 0 and 100")
    return args


def load_model(path, device):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if tuple(checkpoint["features"]) != FEATURES:
        raise ValueError(f"{path} has different sensor features")
    if checkpoint["sequence_length"] != SEQUENCE_LENGTH or checkpoint["horizon"] != HORIZON:
        raise ValueError(f"{path} has a different sequence length or horizon")
    state = checkpoint["model_state_dict"]
    hidden_size = state["lstm.weight_hh_l0"].shape[1]
    model = TemporalModel(input_size=len(FEATURES), hidden_size=hidden_size).to(device)
    model.load_state_dict(state)
    model.eval()
    mean = checkpoint["mean"].to(device)
    std = checkpoint["std"].to(device)
    return checkpoint, model, mean, std


def load_eval_machine(machine, args):
    """Keep current health only as evaluation metadata, never model input."""
    X, y, groups = build_simulator_sequences(
        machine, args.start, args.end, sequence_length=SEQUENCE_LENGTH, horizon=HORIZON
    )
    if len(X) > args.max_sequences_per_machine:
        indices = np.linspace(0, len(X) - 1, args.max_sequences_per_machine, dtype=np.int64)
        X, y, groups = X[indices], y[indices], groups.iloc[indices].reset_index(drop=True)

    history = load_simulator_run(machine, args.start, args.end)
    history["cycle_id"] = history["health"].diff().gt(10).cumsum()
    by_minute = history.set_index("simulated_minute")
    input_rows = by_minute.loc[groups["input_minute"]]
    if not np.array_equal(input_rows["cycle_id"].to_numpy(), groups["cycle_id"].to_numpy()):
        raise ValueError("Evaluation repair cycles do not match sequence metadata")
    current_health = input_rows["health"].to_numpy(dtype=np.float32)
    crossing_minutes = (
        history.loc[history["health"] < args.low_health_threshold]
        .groupby("cycle_id")["simulated_minute"].min().to_dict()
    )
    return X, y, groups, current_health, crossing_minutes


def predict(model, X, mean, std, scale, batch_size, device):
    predictions = []
    with torch.inference_mode():
        for start in range(0, len(X), batch_size):
            batch = torch.from_numpy(X[start:start + batch_size]).to(device)
            predictions.append((model((batch - mean) / std) * scale).cpu().numpy())
    return np.concatenate(predictions)


def score(y, prediction, threshold):
    difference = prediction - y
    low = y < threshold
    alert = prediction < threshold
    return {
        "windows": len(y),
        "mae": float(np.mean(np.abs(difference))),
        "rmse": float(np.sqrt(np.mean(difference ** 2))),
        "low_health": int(low.sum()),
        "missed": int(np.count_nonzero(low & ~alert)),
        "false_alarms": int(np.count_nonzero(~low & alert)),
        "normal": int((~low).sum()),
    }


def event_score(y, prediction, groups, current_health, crossing_minutes, threshold):
    """Count cycles warned about before their first low-health crossing."""
    cycle_ids = groups["cycle_id"].to_numpy()
    input_minutes = groups["input_minute"].to_numpy()
    opportunity = (current_health >= threshold) & (y < threshold)
    evaluable = np.unique(cycle_ids[opportunity])
    leads = []
    for cycle_id in evaluable:
        warned = opportunity & (cycle_ids == cycle_id) & (prediction < threshold)
        if warned.any():
            leads.append(int(crossing_minutes[int(cycle_id)] - input_minutes[warned].min()))
    return len(evaluable), len(leads), leads


def main():
    args = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    machine_data = {machine: load_eval_machine(machine, args) for machine in args.machines}
    print(f"Run: {args.start.isoformat()} to {args.end.isoformat()}; machines: {args.machines}")
    print(f"Low-health threshold: {args.low_health_threshold}; cap: {args.max_sequences_per_machine}/machine")

    for path in args.checkpoint:
        checkpoint, model, mean, std = load_model(path, device)
        all_y, all_predictions = [], []
        total_events = total_detected = 0
        all_leads = []
        print(f"\n{path.name} (source={checkpoint.get('source', 'unknown')}, hidden={model.lstm.hidden_size})")
        for machine, (X, y, groups, current_health, crossing_minutes) in machine_data.items():
            predictions = predict(model, X, mean, std, checkpoint["target_scale"], args.batch_size, device)
            result = score(y, predictions, args.low_health_threshold)
            events, detected, leads = event_score(
                y, predictions, groups, current_health, crossing_minutes, args.low_health_threshold
            )
            total_events += events
            total_detected += detected
            all_leads.extend(leads)
            print(
                f"  machine {machine}: windows={result['windows']:,} MAE={result['mae']:.2f} "
                f"RMSE={result['rmse']:.2f} early warnings={detected}/{events} evaluable crossings"
            )
            all_y.append(y)
            all_predictions.append(predictions)
        result = score(np.concatenate(all_y), np.concatenate(all_predictions), args.low_health_threshold)
        miss_rate = result["missed"] / result["low_health"] if result["low_health"] else float("nan")
        false_rate = result["false_alarms"] / result["normal"] if result["normal"] else float("nan")
        print(
            f"  OVERALL: windows={result['windows']:,} MAE={result['mae']:.2f} "
            f"RMSE={result['rmse']:.2f} low-health windows={result['low_health']:,} "
            f"missed low-health windows={result['missed']:,} ({miss_rate:.1%}) "
            f"false-alert windows={result['false_alarms']:,} ({false_rate:.1%})"
        )
        lead = f"{np.median(all_leads):.0f} simulated minutes" if all_leads else "none"
        print(
            f"  EARLY WARNING: detected={total_detected}/{total_events} evaluable crossing cycles; "
            f"median lead among detections={lead}"
        )


if __name__ == "__main__":
    main()
