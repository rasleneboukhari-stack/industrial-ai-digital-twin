import os
import numpy as np
import torch
from torch.utils.data import TensorDataset, DataLoader

from loaders.cmapss_loader import load_all_cmapss, prepare_features
from models.temporal_model import TemporalModel
from preprocessing.cmapss_sequence_builder import build_sequences, normalize_features


# ============================================================
# PATHS
# ============================================================

AI_DIR = os.path.dirname(__file__)

DATA_DIR = os.path.join(
    AI_DIR,
    "data",
    "processed",
    "cmapss"
)

MODEL_PATH = os.path.join(AI_DIR, "models", "cmapss_grouped_lstm.pt")


# ============================================================
# CONFIGURATION
# ============================================================

BATCH_SIZE = 256
EPOCHS = 20
LEARNING_RATE = 0.001

TRAIN_RATIO = 0.8

SEED = 42


# ============================================================
# DEVICE
# ============================================================

if torch.cuda.is_available():

    device = torch.device("cuda")

else:

    device = torch.device("cpu")


print(
    f"Using device: {device}"
)


# ============================================================
# LOAD DATA
# ============================================================

print("\nLoading CMAPSS engine histories...")
df = prepare_features(load_all_cmapss())
engines = np.array(sorted(df["machine_id"].unique()))
generator = np.random.default_rng(SEED)
generator.shuffle(engines)
train_size = int(len(engines) * TRAIN_RATIO)
if train_size == 0 or train_size == len(engines):
    raise ValueError("Need engines in both train and validation")
train_engines = engines[:train_size].tolist()
val_engines = engines[train_size:].tolist()
print(f"Training engines: {len(train_engines)}; validation engines: {len(val_engines)}")

X_train, y_train = build_sequences(df[df["machine_id"].isin(train_engines)])
X_val, y_val = build_sequences(df[df["machine_id"].isin(val_engines)])
if len(X_train) == 0 or len(X_val) == 0:
    raise ValueError("Each split needs at least one complete sequence")
X_train, mean, std = normalize_features(X_train)
X_val = ((X_val - mean) / std).astype(np.float32)


# ============================================================
# DATASET
# ============================================================

train_dataset = TensorDataset(torch.from_numpy(X_train), torch.from_numpy(y_train))
val_dataset = TensorDataset(torch.from_numpy(X_val), torch.from_numpy(y_val))


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


print(
    f"\nTraining sequences: {len(train_dataset):,}"
)

print(
    f"Validation sequences: {len(val_dataset):,}"
)


# ============================================================
# MODEL
# ============================================================

input_size = X_train.shape[2]

model = TemporalModel(
    input_size=input_size
)

model = model.to(device)


print("\nModel:")
print(model)


# ============================================================
# LOSS / OPTIMIZER
# ============================================================

criterion = torch.nn.MSELoss()

optimizer = torch.optim.Adam(
    model.parameters(),
    lr=LEARNING_RATE
)


# ============================================================
# TRAINING
# ============================================================

print("\nStarting CMAPSS training...\n")
best_val_loss = float("inf")


for epoch in range(EPOCHS):

    # --------------------------------------------------------
    # TRAIN
    # --------------------------------------------------------

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
                * batch_X.size(0)
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
                    * batch_X.size(0)
            )

    val_loss /= len(
        val_dataset
    )

    print(
        f"Epoch {epoch + 1:02d}/{EPOCHS} "
        f"| train loss: {train_loss:.4f} "
        f"| val loss: {val_loss:.4f}"
    )

    if val_loss < best_val_loss:
        best_val_loss = val_loss
        torch.save({
            "model_state_dict": model.state_dict(),
            "mean": torch.from_numpy(mean),
            "std": torch.from_numpy(std),
            "train_engines": train_engines,
            "validation_engines": val_engines,
        }, MODEL_PATH)


# ============================================================
# SAVE MODEL
# ============================================================

print(
    f"\nBest CMAPSS validation loss: {best_val_loss:.4f}; model saved to:"
)

print(
    MODEL_PATH
)
