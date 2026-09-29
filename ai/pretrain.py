import os
import sys

import numpy as np
import torch
from torch.utils.data import TensorDataset, DataLoader

# Allow imports from the ai/ directory
AI_DIR = os.path.dirname(
    os.path.abspath(__file__)
)

sys.path.insert(0, AI_DIR)

from loaders.pronostia_loader import (
    load_pronostia,
    add_rul,
)

from preprocessing.sequence_builder import (
    build_sequences,
)

from models.temporal_model import (
    TemporalModel,
)


# ============================================================
# CONFIG
# ============================================================

SEQUENCE_LENGTH = 30

BATCH_SIZE = 64

EPOCHS = 20

LEARNING_RATE = 0.001

MODEL_PATH = os.path.join(
    AI_DIR,
    "models",
    "pronostia_grouped_lstm.pt"
)


# ============================================================
# LOAD DATA
# ============================================================

print("Loading PRONOSTIA...")

df = load_pronostia(
    include_validation=False
)

df = add_rul(df)

print(
    f"Measurements: {len(df):,}"
)


# ============================================================
# SPLIT BEARINGS, THEN BUILD SEQUENCES
# ============================================================

bearings = np.array(sorted(df["machine_id"].unique()))
if len(bearings) < 2:
    raise ValueError("Need at least two bearings for grouped validation")
rng = np.random.default_rng(42)
rng.shuffle(bearings)
validation_count = max(1, len(bearings) // 3)
train_bearings = bearings[validation_count:].tolist()
val_bearings = bearings[:validation_count].tolist()
print(f"Training bearings: {train_bearings}")
print(f"Validation bearings: {val_bearings}")
print("\nBuilding sequences...")

X_train, y_train = build_sequences(
    df[df["machine_id"].isin(train_bearings)],
    sequence_length=SEQUENCE_LENGTH
)
X_val, y_val = build_sequences(
    df[df["machine_id"].isin(val_bearings)],
    sequence_length=SEQUENCE_LENGTH
)
if len(X_train) == 0 or len(X_val) == 0:
    raise ValueError("Each split needs at least one complete sequence")
print(f"Training X/y: {X_train.shape} / {y_train.shape}")
print(f"Validation X/y: {X_val.shape} / {y_val.shape}")


# ============================================================
# NORMALIZE FEATURES
# ============================================================

print("\nNormalizing features...")

mean = X_train.mean(
    axis=(0, 1),
    keepdims=True
)

std = X_train.std(
    axis=(0, 1),
    keepdims=True
)

std[std < 1e-8] = 1.0

X_train = (X_train - mean) / std
X_val = (X_val - mean) / std


print(
    f"\nTraining sequences: "
    f"{len(X_train):,}"
)

print(
    f"Validation sequences: "
    f"{len(X_val):,}"
)


# ============================================================
# PYTORCH DATASETS
# ============================================================

X_train_tensor = torch.tensor(
    X_train,
    dtype=torch.float32
)

y_train_tensor = torch.tensor(
    y_train,
    dtype=torch.float32
)



X_val_tensor = torch.tensor(
    X_val,
    dtype=torch.float32
)

y_val_tensor = torch.tensor(
    y_val,
    dtype=torch.float32
)


train_dataset = TensorDataset(
    X_train_tensor,
    y_train_tensor
)

val_dataset = TensorDataset(
    X_val_tensor,
    y_val_tensor
)


train_loader = DataLoader(
    train_dataset,
    batch_size=BATCH_SIZE,
    shuffle=True
)

val_loader = DataLoader(
    val_dataset,
    batch_size=BATCH_SIZE,
    shuffle=False
)


# ============================================================
# DEVICE
# ============================================================

device = torch.device(
    "cuda"
    if torch.cuda.is_available()
    else "cpu"
)

print(
    f"\nUsing device: {device}"
)


# ============================================================
# MODEL
# ============================================================

model = TemporalModel(
    input_size=4,
    hidden_size=64,
    num_layers=2
)

model = model.to(device)


# ============================================================
# LOSS + OPTIMIZER
# ============================================================

criterion = torch.nn.MSELoss()

optimizer = torch.optim.Adam(
    model.parameters(),
    lr=LEARNING_RATE
)


# ============================================================
# TRAINING
# ============================================================

print("\nStarting training...\n")
best_val_loss = float("inf")

for epoch in range(EPOCHS):

    model.train()

    train_loss = 0.0

    for batch_X, batch_y in train_loader:

        batch_X = batch_X.to(device)

        batch_y = batch_y.to(device)

        optimizer.zero_grad()

        predictions = model(
            batch_X
        )

        loss = criterion(
            predictions,
            batch_y
        )

        loss.backward()

        optimizer.step()

        train_loss += (
                loss.item()
                * len(batch_X)
        )

    train_loss /= len(
        train_dataset
    )


    # --------------------------------------------------------
    # VALIDATION
    # --------------------------------------------------------

    model.eval()

    val_loss = 0.0

    with torch.no_grad():

        for batch_X, batch_y in val_loader:

            batch_X = batch_X.to(device)

            batch_y = batch_y.to(device)

            predictions = model(
                batch_X
            )

            loss = criterion(
                predictions,
                batch_y
            )

            val_loss += (
                    loss.item()
                    * len(batch_X)
            )

    val_loss /= len(
        val_dataset
    )


    print(
        f"Epoch "
        f"{epoch + 1:02d}/{EPOCHS} "
        f"| train loss: {train_loss:.4f} "
        f"| val loss: {val_loss:.4f}"
    )

    if val_loss < best_val_loss:
        best_val_loss = val_loss
        torch.save(
            {
                "model_state_dict": model.state_dict(),
                "mean": torch.from_numpy(mean.squeeze().copy()),
                "std": torch.from_numpy(std.squeeze().copy()),
                "sequence_length": SEQUENCE_LENGTH,
                "features": [
                    "vibration_rms", "vibration_std",
                    "vibration_peak", "vibration_kurtosis",
                ],
                "train_bearings": train_bearings,
                "validation_bearings": val_bearings,
            },
            MODEL_PATH,
        )


# ============================================================
# REPORT BEST MODEL
# ============================================================

print(f"Best validation loss: {best_val_loss:.4f}; saved to {MODEL_PATH}")

print(
    f"\nModel saved to:\n{MODEL_PATH}"
)
