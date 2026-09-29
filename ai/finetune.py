"""Compare pretrained and scratch LSTMs on simulator future health."""

import argparse
from datetime import datetime
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, TensorDataset

from loaders.simulator_loader import FEATURES
from models.temporal_model import TemporalModel
from prepare_dataset import HORIZON, SEQUENCE_LENGTH, build_simulator_sequences


AI_DIR = Path(__file__).resolve().parent
TARGET_SCALE = 100.0  # health is stored on a 0..100 scale
SEED = 42


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True, type=datetime.fromisoformat)
    parser.add_argument("--end", required=True, type=datetime.fromisoformat)
    parser.add_argument("--machines", nargs="+", type=int, default=list(range(1, 21)))
    parser.add_argument("--val-machines", nargs="+", type=int, default=[17, 18, 19, 20])
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--max-sequences-per-machine", type=int)
    parser.add_argument("--source", choices=["cmapss", "pronostia", "scratch"], default="cmapss")
    parser.add_argument("--pretrained", type=Path)
    parser.add_argument("--output", type=Path, default=AI_DIR / "models/simulator_health_lstm.pt")
    args = parser.parse_args()

    if args.start.tzinfo is None or args.end.tzinfo is None or args.start >= args.end:
        parser.error("--start and --end must be timezone-aware and ordered")
    if len(set(args.machines)) != len(args.machines) or any(m < 1 for m in args.machines):
        parser.error("--machines must contain unique positive IDs")
    if not set(args.val_machines).issubset(args.machines):
        parser.error("--val-machines must be included in --machines")
    if not set(args.machines) - set(args.val_machines) or not args.val_machines:
        parser.error("training and validation must each have at least one machine")
    if args.epochs < 1 or args.batch_size < 1 or args.learning_rate <= 0:
        parser.error("epochs, batch size, and learning rate must be positive")
    if args.max_sequences_per_machine is not None and args.max_sequences_per_machine < 1:
        parser.error("--max-sequences-per-machine must be positive")
    if args.source == "scratch" and args.pretrained is not None:
        parser.error("--pretrained cannot be used with --source scratch")
    if args.source != "scratch" and args.pretrained is None:
        args.pretrained = AI_DIR / "models" / f"{args.source}_grouped_lstm.pt"
    return args


def load_machine(machine_id, args):
    """Build one machine's windows; optionally select evenly spaced examples."""
    X, y, _ = build_simulator_sequences(
        machine_id, args.start, args.end,
        sequence_length=SEQUENCE_LENGTH, horizon=HORIZON,
    )
    limit = args.max_sequences_per_machine
    if limit is not None and len(X) > limit:
        indices = np.linspace(0, len(X) - 1, limit, dtype=np.int64)
        X, y = X[indices], y[indices]
    return X, y


def training_normalization(train_machines, machine_data):
    """Estimate sensor statistics using training machines only."""
    sums = np.zeros(len(FEATURES), dtype=np.float64)
    squares = np.zeros(len(FEATURES), dtype=np.float64)
    observations = 0
    for machine_id in train_machines:
        X, _ = machine_data[machine_id]
        sums += X.sum(axis=(0, 1), dtype=np.float64)
        squares += np.einsum("ntf,ntf->f", X, X, dtype=np.float64)
        observations += X.shape[0] * X.shape[1]
        print(f"Normalization: machine {machine_id}, {len(X):,} windows", flush=True)
    mean = sums / observations
    std = np.sqrt(np.maximum(squares / observations - mean * mean, 0))
    std[std < 1e-8] = 1.0
    return mean.astype(np.float32), std.astype(np.float32)


def make_model(source, checkpoint_path, device):
    """Transfer compatible LSTM weights; learn a new input and health head."""
    if source == "scratch":
        print("Initialized five-sensor LSTM from scratch")
        return TemporalModel(input_size=len(FEATURES)).to(device)

    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    pretrained = checkpoint.get("model_state_dict", checkpoint)
    hidden_size = pretrained["lstm.weight_hh_l0"].shape[1]
    model = TemporalModel(input_size=len(FEATURES), hidden_size=hidden_size)
    current = model.state_dict()
    transferable = {
        name: value for name, value in pretrained.items()
        if name.startswith("lstm.")
        and name != "lstm.weight_ih_l0"
        and name in current
        and value.shape == current[name].shape
    }
    if "lstm.weight_ih_l1" not in transferable:
        raise ValueError("Checkpoint has no compatible upper LSTM layer")
    model.load_state_dict(transferable, strict=False)
    print(f"Transferred {len(transferable)} LSTM tensors from {checkpoint_path}")
    print("Initialized a new five-sensor input weight and future-health head")
    return model.to(device)


def run_epoch(model, machine_ids, machine_data, args, mean, std, device, optimizer=None):
    training = optimizer is not None
    model.train(training)
    total_loss = 0.0
    total_examples = 0
    if training:
        machine_ids = np.random.default_rng(SEED + run_epoch.epoch).permutation(machine_ids)
    mean_tensor = torch.as_tensor(mean, device=device)
    std_tensor = torch.as_tensor(std, device=device)

    for machine_id in machine_ids:
        X, y = machine_data[int(machine_id)]
        loader = DataLoader(
            TensorDataset(torch.from_numpy(X), torch.from_numpy(y)),
            batch_size=args.batch_size, shuffle=training,
        )
        for batch_X, batch_y in loader:
            inputs = (batch_X.to(device) - mean_tensor) / std_tensor
            targets = batch_y.to(device) / TARGET_SCALE
            with torch.set_grad_enabled(training):
                predictions = model(inputs)
                loss = torch.nn.functional.mse_loss(predictions, targets)
                if training:
                    optimizer.zero_grad()
                    loss.backward()
                    optimizer.step()
            total_loss += loss.item() * len(batch_X)
            total_examples += len(batch_X)
        print(f"{'Train' if training else 'Validate'} machine {machine_id}: {len(X):,} windows", flush=True)
    return total_loss / total_examples


def main():
    args = parse_args()
    torch.manual_seed(SEED)
    train_machines = [m for m in args.machines if m not in args.val_machines]
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Train machines: {train_machines}; validation machines: {args.val_machines}")
    print(f"Device: {device}; features: {FEATURES}; horizon: {HORIZON} samples")

    machine_data = {machine_id: load_machine(machine_id, args) for machine_id in args.machines}
    mean, std = training_normalization(train_machines, machine_data)
    model = make_model(args.source, args.pretrained, device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    best_validation_loss = float("inf")

    for epoch in range(1, args.epochs + 1):
        run_epoch.epoch = epoch
        train_loss = run_epoch(model, train_machines, machine_data, args, mean, std, device, optimizer)
        val_loss = run_epoch(model, args.val_machines, machine_data, args, mean, std, device)
        print(f"Epoch {epoch}/{args.epochs}: train MSE={train_loss:.6f}, validation MSE={val_loss:.6f}")
        if val_loss < best_validation_loss:
            best_validation_loss = val_loss
            args.output.parent.mkdir(parents=True, exist_ok=True)
            torch.save({
                "model_state_dict": model.state_dict(),
                "mean": torch.from_numpy(mean),
                "std": torch.from_numpy(std),
                "features": list(FEATURES),
                "sequence_length": SEQUENCE_LENGTH,
                "horizon": HORIZON,
                "target_scale": TARGET_SCALE,
                "train_machines": train_machines,
                "validation_machines": args.val_machines,
                "start": args.start.isoformat(),
                "end": args.end.isoformat(),
                "pretrained": str(args.pretrained),
                "source": args.source,
                "hidden_size": model.lstm.hidden_size,
                "max_sequences_per_machine": args.max_sequences_per_machine,
            }, args.output)
            print(f"Saved best model to {args.output}")


if __name__ == "__main__":
    main()
