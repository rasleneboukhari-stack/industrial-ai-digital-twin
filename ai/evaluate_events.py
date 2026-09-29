"""Evaluate offline event forecasts without connecting them to the gateway."""

import argparse
from datetime import datetime
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import average_precision_score, brier_score_loss

from loaders.simulator_loader import FEATURES, SAMPLE_INTERVAL, load_simulator_run
from models.temporal_model import TemporalModel
from prepare_dataset import (
    EVENT_NAMES, EVENT_SENSORS, LOAD_CONTEXT_EVENT_NAMES,
    _confirmed_crossings, build_event_sequences,
)
from train_events import cumulative_risks


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True, type=datetime.fromisoformat)
    parser.add_argument("--end", required=True, type=datetime.fromisoformat)
    parser.add_argument("--machines", nargs="+", type=int, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--max-sequences-per-machine", type=int, default=10000)
    parser.add_argument("--batch-size", type=int, default=1024)
    args = parser.parse_args()
    if args.start.tzinfo is None or args.end.tzinfo is None or args.start >= args.end:
        parser.error("--start and --end must be timezone-aware and ordered")
    if not args.machines or len(set(args.machines)) != len(args.machines):
        parser.error("--machines must contain unique IDs")
    if args.max_sequences_per_machine < 1 or args.batch_size < 1:
        parser.error("window cap and batch size must be positive")
    return args


def load_model(path, device):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    output_names = tuple(checkpoint["output_names"])
    if tuple(checkpoint["features"]) != FEATURES or output_names not in (
        EVENT_NAMES, LOAD_CONTEXT_EVENT_NAMES
    ):
        raise ValueError("Checkpoint feature/output names do not match this evaluator")
    state = checkpoint["model_state_dict"]
    hidden_size = state["lstm.weight_hh_l0"].shape[1]
    eta_bins = checkpoint.get("eta_bin_count") or 1
    model = TemporalModel(len(FEATURES), hidden_size=hidden_size,
                          output_size=len(output_names) * eta_bins).to(device)
    model.load_state_dict(state, strict=True)
    model.eval()
    return checkpoint, model


def predict(model, X, checkpoint, batch_size, device):
    mean = checkpoint["mean"].to(device)
    std = checkpoint["std"].to(device)
    results = []
    with torch.inference_mode():
        for start in range(0, len(X), batch_size):
            inputs = torch.from_numpy(X[start:start + batch_size]).to(device)
            logits = model((inputs - mean) / std)
            scores = (cumulative_risks(logits, len(checkpoint["output_names"]))
                      if checkpoint.get("prediction_type") == "cumulative_event_risk"
                      else torch.sigmoid(logits))
            results.append(scores.cpu().numpy())
    return np.concatenate(results)


def horizon_scores(risks, output_names):
    """Select the trained full horizon for each event from an ETA checkpoint."""
    if risks.ndim == 2:
        return risks
    return np.stack([
        risks[:, column, -1 if name == "failure" else 3]
        for column, name in enumerate(output_names)
    ], axis=1)


def eta_band(risk_curve, bin_minutes):
    """Conditional median event-time band, given an event in the horizon."""
    bin_index = int(np.searchsorted(risk_curve, 0.5 * risk_curve[-1]))
    return bin_index * bin_minutes, (bin_index + 1) * bin_minutes


def actual_events(machine, start, end, limits, confirmation_samples,
                  output_names=EVENT_NAMES, load_block_minutes=None):
    """Read observed episode starts and failure onsets for event-level recall."""
    history = load_simulator_run(machine, start, end)
    history["cycle_id"] = history["health"].diff().gt(10).cumsum()
    catalog = {name: [] for name in output_names}
    for cycle_id, cycle in history.groupby("cycle_id", sort=False):
        minutes = cycle["simulated_minute"].to_numpy(dtype=np.int64)
        running = cycle["running"].to_numpy(dtype=bool)
        states = cycle["state_code"].to_numpy(dtype=np.int8)
        sensor_names = EVENT_SENSORS if output_names == EVENT_NAMES else (
            "temperature", "vibration", "current_excess"
        )
        for name in sensor_names:
            values = (
                cycle["current"].to_numpy(dtype=np.float32) -
                (2.0 + 0.12 * cycle["load"].to_numpy(dtype=np.float32))
                if name == "current_excess" else cycle[name].to_numpy(dtype=np.float32)
            )
            positions = _confirmed_crossings(values, limits[name], running,
                                             confirmation_samples)
            for position in positions[states[positions] != 3]:
                block = int(minutes[position] // load_block_minutes) if load_block_minutes else 0
                catalog[name].append((int(cycle_id), block, int(minutes[position])))
        failures = np.flatnonzero((states == 3) & ~np.r_[False, states[:-1] == 3])
        catalog["failure"].extend(
            (int(cycle_id), int(minutes[position] // load_block_minutes) if load_block_minutes else 0,
             int(minutes[position])) for position in failures
        )
    return catalog


def score_windows(labels, observed, risks, thresholds, disabled=(), output_names=EVENT_NAMES):
    """Count only labels whose entire outcome is known."""
    for column, name in enumerate(output_names):
        valid = observed[:, column]
        if not valid.any():
            print(f"  {name}: no observed labels")
            continue
        truth = labels[valid, column].astype(bool)
        risk = risks[valid, column]
        alert = risk >= thresholds[name]
        positives = int(truth.sum())
        ap = average_precision_score(truth, risk) if 0 < positives < len(truth) else float("nan")
        brier = brier_score_loss(truth, risk)
        if name in disabled:
            print(f"  {name}: observed={len(truth):,} positive={positives:,} "
                  f"AP={ap:.3f} prevalence={truth.mean():.3f} Brier={brier:.3f}; "
                  "alerts disabled")
            continue
        print(f"  {name}: observed={len(truth):,} positive={positives:,} "
              f"AP={ap:.3f} prevalence={truth.mean():.3f} Brier={brier:.3f} "
              f"TP={int((alert & truth).sum()):,} FN={int((~alert & truth).sum()):,} "
              f"FP={int((alert & ~truth).sum()):,} TN={int((~alert & ~truth).sum()):,}")


def score_events(machine_data, catalogs, thresholds, disabled=(), output_names=EVENT_NAMES):
    """An event is evaluable when a selected pre-event window targets it."""
    for column, name in enumerate(output_names):
        if name == "rapid_health_loss":
            print("  rapid_health_loss: 24-hour window target; episode counts do not apply")
            continue
        if name in disabled:
            actual = sum(len(catalog[name]) for catalog in catalogs.values())
            print(f"  {name}: actual episodes={actual}; alerts disabled")
            continue
        actual = evaluable = warned = early24 = false_episodes = 0
        leads = []
        for machine, (labels, observed, groups, risks) in machine_data.items():
            event_minutes = groups[f"{name}_event_minute"].to_numpy()
            cycle_ids = groups["cycle_id"].to_numpy()
            block_ids = groups["load_block_id"].to_numpy()
            input_minutes = groups["input_minute"].to_numpy()
            alert = risks[:, column] >= thresholds[name]
            for cycle, block, minute in catalogs[machine][name]:
                actual += 1
                opportunities = observed[:, column] & (event_minutes == minute) & (
                    cycle_ids == cycle
                ) & (block_ids == block)
                if not opportunities.any():
                    continue
                evaluable += 1
                alerted = opportunities & alert
                if alerted.any():
                    warned += 1
                    lead = int(minute - input_minutes[alerted].min())
                    leads.append(lead)
                    if lead >= 24 * 60:
                        early24 += 1
            for cycle, block in groups[["cycle_id", "load_block_id"]].drop_duplicates().itertuples(index=False):
                in_cycle = (cycle_ids == cycle) & (block_ids == block)
                false = alert[in_cycle] & observed[in_cycle, column] & ~labels[in_cycle, column].astype(bool)
                false_episodes += int((false & ~np.r_[False, false[:-1]]).sum())
        median_lead = f"{np.median(leads):.0f} min" if leads else "none"
        print(f"  {name}: actual episodes={actual}, evaluable={evaluable}, "
              f"warned={warned}, missed={evaluable - warned}, "
              f"median lead={median_lead}, >=24h lead={early24}, "
              f"false-alert episodes={false_episodes}")


def score_eta(machine_data, catalogs, thresholds, output_names, bin_minutes):
    """Evaluate timing at the first alerted window for each observed episode."""
    print("ETA at first alert (conditional median band; baseline is horizon midpoint):")
    for column, name in enumerate(output_names):
        if name == "rapid_health_loss":
            print("  rapid_health_loss: fixed 24-hour change target; no event ETA")
            continue
        errors, baseline_errors, predicted_bands = [], [], []
        covered = 0
        horizon = 48 * 60 if name == "failure" else 24 * 60
        for machine, (_labels, observed, groups, _scores, curves) in machine_data.items():
            input_minutes = groups["input_minute"].to_numpy()
            event_minutes = groups[f"{name}_event_minute"].to_numpy()
            cycles = groups["cycle_id"].to_numpy()
            blocks = groups["load_block_id"].to_numpy()
            for cycle, block, event_minute in catalogs[machine][name]:
                eligible = np.flatnonzero(
                    observed[:, column] & (event_minutes == event_minute) &
                    (cycles == cycle) & (blocks == block) &
                    (_scores[:, column] >= thresholds[name])
                )
                if len(eligible) == 0:
                    continue
                first = eligible[np.argmin(input_minutes[eligible])]
                curve = curves[first, column, :8 if name == "failure" else 4]
                lower, upper = eta_band(curve, bin_minutes)
                actual = int(event_minute - input_minutes[first])
                errors.append(abs((lower + upper) / 2 - actual))
                baseline_errors.append(abs(horizon / 2 - actual))
                predicted_bands.append((lower, upper))
                covered += lower < actual <= upper
        if not errors:
            print(f"  {name}: no alerted episodes with observed event times")
            continue
        print(f"  {name}: episodes={len(errors)}, exact 6h band={covered/len(errors):.1%}, "
              f"median error={np.median(errors)/60:.1f}h, "
              f"80th error={np.quantile(errors, .8)/60:.1f}h, "
              f"midpoint baseline={np.median(baseline_errors)/60:.1f}h, "
              f"median forecast={np.median([sum(band) / 2 for band in predicted_bands])/60:.1f}h")


def main():
    args = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    checkpoint, model = load_model(args.checkpoint, device)
    output_names = tuple(checkpoint["output_names"])
    profile = checkpoint.get("task_profile", "legacy")
    load_block_minutes = checkpoint.get("load_block_minutes")
    limits = checkpoint["limits"]
    thresholds = checkpoint.get("alert_thresholds", {name: 0.5 for name in output_names})
    disabled = set(checkpoint.get("disabled_alerts", []))
    print(f"Run {args.start.isoformat()} to {args.end.isoformat()}; machines={args.machines}")
    print(f"Checkpoint={args.checkpoint}; selected epoch={checkpoint.get('best_epoch')}; "
          f"limits={limits}; cutoffs={thresholds}")
    print("Operating limits are illustrative simulator settings, not certified factory limits.")
    machine_data = {}
    eta_data = {}
    catalogs = {}
    for machine in args.machines:
        X, labels, observed, groups = build_event_sequences(
            machine, args.start, args.end, limits,
            sequence_length=checkpoint["sequence_length"],
            sensor_horizon=checkpoint["sensor_horizon"],
            failure_horizon=checkpoint["failure_horizon"],
            confirmation_samples=checkpoint["confirmation_samples"],
            max_sequences=args.max_sequences_per_machine,
            profile=profile, load_block_minutes=load_block_minutes,
        )
        risks = predict(model, X, checkpoint, args.batch_size, device)
        final_risks = horizon_scores(risks, output_names)
        machine_data[machine] = labels, observed, groups, final_risks
        if risks.ndim == 3:
            eta_data[machine] = labels, observed, groups, final_risks, risks
        catalogs[machine] = actual_events(
            machine, args.start, args.end, limits, checkpoint["confirmation_samples"],
            output_names, load_block_minutes,
        )
        print(f"Loaded machine {machine}: {len(X):,} windows", flush=True)
    all_labels = np.concatenate([data[0] for data in machine_data.values()])
    all_observed = np.concatenate([data[1] for data in machine_data.values()])
    all_risks = np.concatenate([data[3] for data in machine_data.values()])
    print("Window scores (AP compared with prevalence; thresholds chosen on validation):")
    score_windows(all_labels, all_observed, all_risks, thresholds, disabled, output_names)
    print("Event scores (only events with at least one selected eligible window are evaluable):")
    score_events(machine_data, catalogs, thresholds, disabled, output_names)
    if eta_data:
        score_eta(eta_data, catalogs, thresholds, output_names,
                  checkpoint["eta_bin_minutes"])


if __name__ == "__main__":
    main()
