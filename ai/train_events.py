"""Train offline simulator forecasts for operating-limit events and failure."""

import argparse
from datetime import datetime
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import precision_recall_curve
from torch.utils.data import DataLoader, TensorDataset

from loaders.simulator_loader import FEATURES, SAMPLE_INTERVAL
from models.temporal_model import TemporalModel
from prepare_dataset import (
    EVENT_NAMES, LOAD_CONTEXT_EVENT_NAMES, LOAD_BLOCK_MINUTES,
    FAILURE_HORIZON, SEQUENCE_LENGTH, SENSOR_HORIZON,
    build_event_sequences,
)


AI_DIR = Path(__file__).resolve().parent
SEED = 42
ETA_BIN_MINUTES = 6 * 60
ETA_BIN_COUNT = 8


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True, type=datetime.fromisoformat)
    parser.add_argument("--end", required=True, type=datetime.fromisoformat)
    parser.add_argument("--machines", nargs="+", type=int, default=list(range(1, 21)))
    parser.add_argument("--val-machines", nargs="+", type=int, default=[17, 18, 19, 20])
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--max-sequences-per-machine", type=int, default=10000)
    parser.add_argument("--profile", choices=["legacy", "load_context"], default="legacy")
    parser.add_argument("--temperature-limit", type=float, default=100.0)
    parser.add_argument("--vibration-limit", type=float, default=1.5)
    parser.add_argument("--rpm-limit", type=float, default=2500.0)
    parser.add_argument("--current-excess-limit", type=float, default=1.5)
    parser.add_argument("--rapid-health-loss-limit", type=float, default=3.0)
    parser.add_argument("--load-block-minutes", type=int, default=LOAD_BLOCK_MINUTES)
    parser.add_argument("--confirmation-samples", type=int, default=3)
    parser.add_argument("--init-from", type=Path)
    parser.add_argument("--eta", action="store_true",
                        help="train cumulative event risk in six-hour bands")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.start.tzinfo is None or args.end.tzinfo is None or args.start >= args.end:
        parser.error("--start and --end must be timezone-aware and ordered")
    if len(set(args.machines)) != len(args.machines) or any(m < 1 for m in args.machines):
        parser.error("--machines must contain unique positive IDs")
    if not args.val_machines or not set(args.val_machines).issubset(args.machines):
        parser.error("--val-machines must be a nonempty subset of --machines")
    if not set(args.machines) - set(args.val_machines):
        parser.error("at least one training machine is required")
    if min(args.epochs, args.batch_size, args.max_sequences_per_machine,
           args.confirmation_samples) < 1 or args.learning_rate <= 0:
        parser.error("epochs, batch size, cap, confirmation, and learning rate must be positive")
    if args.load_block_minutes < FAILURE_HORIZON * SAMPLE_INTERVAL:
        parser.error("--load-block-minutes must cover the 48-hour failure horizon")
    if args.eta and args.profile != "load_context":
        parser.error("--eta requires --profile load_context")
    limits = {"temperature": args.temperature_limit, "vibration": args.vibration_limit}
    if args.profile == "load_context":
        limits.update(current_excess=args.current_excess_limit,
                      rapid_health_loss=args.rapid_health_loss_limit)
    else:
        limits["rpm"] = args.rpm_limit
    if any(not np.isfinite(value) or value <= 0 for value in limits.values()):
        parser.error("all limits must be positive and finite")
    if args.output is None:
        name = ("simulator_event_eta.pt" if args.eta else
                "simulator_load_context.pt" if args.profile == "load_context" else
                "simulator_events.pt")
        args.output = AI_DIR / "models" / name
    return args, limits


def load_machine(machine_id, args, limits):
    X, labels, observed, groups = build_event_sequences(
        machine_id, args.start, args.end, limits,
        confirmation_samples=args.confirmation_samples,
        max_sequences=args.max_sequences_per_machine,
        profile=args.profile,
        load_block_minutes=args.load_block_minutes if args.profile == "load_context" else None,
    )
    if args.eta:
        labels, observed = eta_targets(labels, observed, groups,
                                       LOAD_CONTEXT_EVENT_NAMES)
    return X, labels, observed


def eta_targets(labels, observed, groups, output_names):
    """Cumulative labels; only horizons whose outcome is observed are trained."""
    count = len(labels)
    targets = np.zeros((count, len(output_names), ETA_BIN_COUNT), dtype=np.float32)
    masks = np.zeros_like(targets, dtype=bool)
    input_minutes = groups["input_minute"].to_numpy(dtype=np.int64)
    for column, name in enumerate(output_names):
        last_bin = ETA_BIN_COUNT if name == "failure" else 4
        event_minutes = groups[f"{name}_event_minute"].to_numpy(dtype=np.int64)
        for bin_index in range(last_bin):
            if name == "rapid_health_loss" and bin_index != last_bin - 1:
                continue  # this target measures a change exactly 24h ahead
            masks[:, column, bin_index] = observed[:, column]
            targets[:, column, bin_index] = (
                observed[:, column] & (labels[:, column] > 0) &
                (event_minutes <= input_minutes + (bin_index + 1) * ETA_BIN_MINUTES)
            )
    return targets, masks


def cumulative_risks(logits, output_count):
    """Turn per-bin hazards into nondecreasing event-by-horizon risks."""
    hazards = torch.sigmoid(logits.reshape(-1, output_count, ETA_BIN_COUNT))
    return 1 - torch.cumprod(1 - hazards, dim=-1)


def training_normalization(train_machines, machine_data):
    """Use only training-machine sensor windows to estimate scale."""
    sums = np.zeros(len(FEATURES), dtype=np.float64)
    squares = np.zeros(len(FEATURES), dtype=np.float64)
    count = 0
    for machine in train_machines:
        X = machine_data[machine][0]
        sums += X.sum(axis=(0, 1), dtype=np.float64)
        squares += np.einsum("ntf,ntf->f", X, X, dtype=np.float64)
        count += X.shape[0] * X.shape[1]
    mean = sums / count
    std = np.sqrt(np.maximum(squares / count - mean * mean, 0))
    std[std < 1e-8] = 1.0
    return mean.astype(np.float32), std.astype(np.float32)


def make_model(init_from, device, output_names=EVENT_NAMES, eta=False):
    if init_from is not None:
        checkpoint = torch.load(init_from, map_location="cpu", weights_only=True)
        source = checkpoint.get("model_state_dict", checkpoint)
        hidden_size = source["lstm.weight_hh_l0"].shape[1]
    else:
        source = None
        hidden_size = 128
    model = TemporalModel(input_size=len(FEATURES), hidden_size=hidden_size,
                          output_size=len(output_names) * (ETA_BIN_COUNT if eta else 1))
    if source is not None:
        current = model.state_dict()
        compatible = {
            name: value for name, value in source.items()
            if name.startswith("lstm.") and name in current and value.shape == current[name].shape
        }
        if not compatible:
            raise ValueError(f"No compatible LSTM weights in {init_from}")
        model.load_state_dict(compatible, strict=False)
        print(f"Transferred {len(compatible)} LSTM tensors from {init_from}; "
              f"new {model.output_size}-output head")
    else:
        print("Initialized event LSTM from scratch")
    return model.to(device)


def run_epoch(model, machine_ids, machine_data, mean, std, batch_size, device,
              optimizer=None, epoch=0):
    training = optimizer is not None
    model.train(training)
    if training:
        machine_ids = np.random.default_rng(SEED + epoch).permutation(machine_ids)
    mean_tensor = torch.as_tensor(mean, device=device)
    std_tensor = torch.as_tensor(std, device=device)
    total_loss = 0.0
    total_labels = 0
    for machine in machine_ids:
        X, labels, observed = machine_data[int(machine)]
        loader = DataLoader(TensorDataset(
            torch.from_numpy(X), torch.from_numpy(labels), torch.from_numpy(observed)
        ), batch_size=batch_size, shuffle=training)
        for batch_X, batch_y, batch_mask in loader:
            inputs = (batch_X.to(device) - mean_tensor) / std_tensor
            targets = batch_y.to(device)
            mask = batch_mask.to(device)
            with torch.set_grad_enabled(training):
                logits = model(inputs)
                if targets.ndim == 3:
                    risks = cumulative_risks(logits, targets.shape[1])
                    per_label = torch.nn.functional.binary_cross_entropy(
                        risks.clamp(1e-6, 1 - 1e-6), targets, reduction="none"
                    )
                else:
                    per_label = torch.nn.functional.binary_cross_entropy_with_logits(
                        logits, targets, reduction="none"
                    )
                loss = (per_label * mask).sum() / mask.sum()
                if training:
                    optimizer.zero_grad()
                    loss.backward()
                    optimizer.step()
            total_loss += (per_label * mask).sum().item()
            total_labels += mask.sum().item()
    return total_loss / total_labels


def validation_thresholds(model, machines, machine_data, mean, std, batch_size, device,
                          output_names=EVENT_NAMES):
    """Choose F2 alert cutoffs on validation windows; these are not test scores."""
    model.eval()
    means = torch.as_tensor(mean, device=device)
    scales = torch.as_tensor(std, device=device)
    scores, labels, masks = [], [], []
    with torch.inference_mode():
        for machine in machines:
            X, y, observed = machine_data[machine]
            for start in range(0, len(X), batch_size):
                inputs = (torch.from_numpy(X[start:start + batch_size]).to(device) - means) / scales
                logits = model(inputs)
                scores.append((cumulative_risks(logits, len(output_names))
                               if y.ndim == 3 else torch.sigmoid(logits)).cpu().numpy())
            labels.append(y)
            masks.append(observed)
    scores = np.concatenate(scores)
    labels = np.concatenate(labels)
    masks = np.concatenate(masks)
    thresholds = {}
    for column, name in enumerate(output_names):
        final_bin = ETA_BIN_COUNT - 1 if name == "failure" else 3
        valid = masks[:, column, final_bin] if masks.ndim == 3 else masks[:, column]
        target = (labels[valid, column, final_bin] if labels.ndim == 3 else
                  labels[valid, column])
        risk = (scores[valid, column, final_bin] if scores.ndim == 3 else
                scores[valid, column])
        if not np.any(target) or np.all(target):
            thresholds[name] = 0.5
            print(f"{name}: only one class in validation; threshold remains 0.5")
            continue
        precision, recall, cutoffs = precision_recall_curve(target, risk)
        f2 = 5 * precision[:-1] * recall[:-1] / np.maximum(
            4 * precision[:-1] + recall[:-1], 1e-12
        )
        best = int(np.argmax(f2))
        thresholds[name] = float(cutoffs[best])
        print(f"{name}: validation positives={int(target.sum())}/{len(target)} "
              f"F2={f2[best]:.3f} alert cutoff={cutoffs[best]:.4f}")
    return thresholds


def main():
    args, limits = parse_args()
    output_names = LOAD_CONTEXT_EVENT_NAMES if args.profile == "load_context" else EVENT_NAMES
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    train_machines = [m for m in args.machines if m not in args.val_machines]
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}; train machines: {train_machines}; validation: {args.val_machines}")
    print(f"Five inputs: {FEATURES}; outputs: {output_names}; demo limits: {limits}")
    print(f"Sensor horizon={SENSOR_HORIZON * SAMPLE_INTERVAL} min; "
          f"failure horizon={FAILURE_HORIZON * SAMPLE_INTERVAL} min")
    machine_data = {}
    for machine in args.machines:
        machine_data[machine] = load_machine(machine, args, limits)
        X, y, observed = machine_data[machine]
        if args.eta:
            final_bins = [ETA_BIN_COUNT - 1 if name == "failure" else 3 for name in output_names]
            summary_y = np.stack([y[:, column, final_bin]
                                  for column, final_bin in enumerate(final_bins)], axis=1)
            summary_mask = np.stack([observed[:, column, final_bin]
                                     for column, final_bin in enumerate(final_bins)], axis=1)
        else:
            summary_y, summary_mask = y, observed
        print(f"Machine {machine}: windows={len(X):,}, positives={summary_y.sum(axis=0).astype(int).tolist()}, "
              f"observed={summary_mask.sum(axis=0).tolist()}", flush=True)
    if args.profile == "load_context":
        for name, machine_ids in (("training", train_machines), ("validation", args.val_machines)):
            labels = np.concatenate([machine_data[m][1] for m in machine_ids])
            masks = np.concatenate([machine_data[m][2] for m in machine_ids])
            positives = (labels * masks).sum(axis=0)
            negatives = masks.sum(axis=0) - positives
            if args.eta:
                final_bins = [ETA_BIN_COUNT - 1 if name == "failure" else 3
                              for name in output_names]
                positives = np.array([positives[column, final_bin]
                                      for column, final_bin in enumerate(final_bins)])
                negatives = np.array([negatives[column, final_bin]
                                      for column, final_bin in enumerate(final_bins)])
            if np.any(positives == 0) or np.any(negatives == 0):
                raise ValueError(f"{name} split lacks both classes for every output: "
                                 f"positive={positives.astype(int)}, negative={negatives.astype(int)}")
    mean, std = training_normalization(train_machines, machine_data)
    model = make_model(args.init_from, device, output_names, eta=args.eta)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    best_loss = float("inf")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        train_loss = run_epoch(model, train_machines, machine_data, mean, std,
                               args.batch_size, device, optimizer, epoch)
        validation_loss = run_epoch(model, args.val_machines, machine_data, mean, std,
                                    args.batch_size, device)
        print(f"Epoch {epoch}/{args.epochs}: train BCE={train_loss:.5f}, "
              f"validation BCE={validation_loss:.5f}", flush=True)
        if validation_loss < best_loss:
            best_loss = validation_loss
            torch.save({
                "model_state_dict": model.state_dict(),
                "mean": torch.from_numpy(mean), "std": torch.from_numpy(std),
                "features": list(FEATURES), "output_names": list(output_names),
                "limits": limits, "sequence_length": SEQUENCE_LENGTH,
                "sensor_horizon": SENSOR_HORIZON, "failure_horizon": FAILURE_HORIZON,
                "task_profile": args.profile,
                "prediction_type": "cumulative_event_risk" if args.eta else "fixed_window",
                "eta_bin_minutes": ETA_BIN_MINUTES if args.eta else None,
                "eta_bin_count": ETA_BIN_COUNT if args.eta else None,
                "load_block_minutes": args.load_block_minutes if args.profile == "load_context" else None,
                "confirmation_samples": args.confirmation_samples,
                "train_machines": train_machines, "validation_machines": args.val_machines,
                "start": args.start.isoformat(), "end": args.end.isoformat(),
                "init_from": str(args.init_from) if args.init_from else None,
                "best_epoch": epoch, "validation_bce": best_loss,
                "max_sequences_per_machine": args.max_sequences_per_machine,
            }, args.output)
    checkpoint = torch.load(args.output, map_location="cpu", weights_only=True)
    model.load_state_dict(checkpoint["model_state_dict"])
    checkpoint["alert_thresholds"] = validation_thresholds(
        model, args.val_machines, machine_data, mean, std, args.batch_size, device,
        output_names,
    )
    torch.save(checkpoint, args.output)
    print(f"Saved best offline event model: {args.output}")


if __name__ == "__main__":
    main()
