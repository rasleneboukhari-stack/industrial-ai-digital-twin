import os
import numpy as np
import torch


# ============================================================
# PATHS
# ============================================================

AI_DIR = os.path.dirname(
    os.path.dirname(__file__)
)

import sys

sys.path.insert(
    0,
    os.path.join(
        AI_DIR,
        "loaders"
    )
)

from cmapss_loader import (
    load_all_cmapss,
    prepare_features
)


OUTPUT_DIR = os.path.join(
    AI_DIR,
    "data",
    "processed",
    "cmapss"
)

os.makedirs(
    OUTPUT_DIR,
    exist_ok=True
)


# ============================================================
# CONFIGURATION
# ============================================================

SEQUENCE_LENGTH = 50

FEATURES = [
    "sensor_2",
    "sensor_3",
    "sensor_4",
    "sensor_7",
    "sensor_8",
    "sensor_9",
    "sensor_11",
    "sensor_12",
    "sensor_13",
    "sensor_14",
    "sensor_15",
    "sensor_17",
    "sensor_20",
    "sensor_21",
]


# ============================================================
# BUILD SEQUENCES
# ============================================================

def build_sequences(df):

    X = []
    y = []

    print(
        f"\nBuilding sequences "
        f"(length={SEQUENCE_LENGTH})..."
    )

    # Each machine_id represents one CMAPSS engine.
    # Never allow a sequence to cross between engines.

    for machine_id, engine in df.groupby(
            "machine_id"
    ):

        engine = engine.sort_values(
            "cycle"
        ).reset_index(
            drop=True
        )

        values = engine[
            FEATURES
        ].to_numpy(
            dtype=np.float32
        )

        rul = engine[
            "rul"
        ].to_numpy(
            dtype=np.float32
        )

        if len(engine) < SEQUENCE_LENGTH:
            continue

        # Sliding window

        for end in range(
                SEQUENCE_LENGTH,
                len(engine) + 1
        ):

            start = (
                    end -
                    SEQUENCE_LENGTH
            )

            sequence = values[
                start:end
            ]

            target = rul[
                end - 1
                ]

            X.append(
                sequence
            )

            y.append(
                target
            )

    X = np.asarray(
        X,
        dtype=np.float32
    )

    y = np.asarray(
        y,
        dtype=np.float32
    )

    print(
        f"Created {len(X):,} sequences."
    )

    print(
        f"X shape: {X.shape}"
    )

    print(
        f"y shape: {y.shape}"
    )

    return X, y


# ============================================================
# NORMALIZATION
# ============================================================

def normalize_features(X):

    print(
        "\nNormalizing CMAPSS features..."
    )

    flattened = X.reshape(
        -1,
        X.shape[-1]
    )

    mean = flattened.mean(
        axis=0
    )

    std = flattened.std(
        axis=0
    )

    # Prevent division by zero

    std[
        std < 1e-8
        ] = 1.0

    X_normalized = (
                           X - mean
                   ) / std

    return (
        X_normalized.astype(
            np.float32
        ),
        mean.astype(
            np.float32
        ),
        std.astype(
            np.float32
        )
    )


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    print(
        "================================"
    )

    print(
        "CMAPSS Sequence Builder"
    )

    print(
        "================================"
    )

    # --------------------------------------------------------
    # LOAD CMAPSS
    # --------------------------------------------------------

    print(
        "\nLoading CMAPSS..."
    )

    raw_data = load_all_cmapss()

    df = prepare_features(
        raw_data
    )

    print(
        f"\nRows: {len(df):,}"
    )

    print(
        f"Engines: "
        f"{df['machine_id'].nunique():,}"
    )

    print(
        f"Features: {len(FEATURES)}"
    )

    # --------------------------------------------------------
    # BUILD SEQUENCES
    # --------------------------------------------------------

    X, y = build_sequences(
        df
    )

    # --------------------------------------------------------
    # NORMALIZE
    # --------------------------------------------------------

    X, mean, std = normalize_features(
        X
    )

    # --------------------------------------------------------
    # CONVERT TO PYTORCH
    # --------------------------------------------------------

    X_tensor = torch.from_numpy(
        X
    )

    y_tensor = torch.from_numpy(
        y
    )

    mean_tensor = torch.from_numpy(
        mean
    )

    std_tensor = torch.from_numpy(
        std
    )

    # --------------------------------------------------------
    # SAVE
    # --------------------------------------------------------

    torch.save(
        X_tensor,
        os.path.join(
            OUTPUT_DIR,
            "X.pt"
        )
    )

    torch.save(
        y_tensor,
        os.path.join(
            OUTPUT_DIR,
            "y.pt"
        )
    )

    torch.save(
        mean_tensor,
        os.path.join(
            OUTPUT_DIR,
            "mean.pt"
        )
    )

    torch.save(
        std_tensor,
        os.path.join(
            OUTPUT_DIR,
            "std.pt"
        )
    )

    # Save feature names

    with open(
            os.path.join(
                OUTPUT_DIR,
                "features.txt"
            ),
            "w"
    ) as file:

        for feature in FEATURES:

            file.write(
                feature + "\n"
            )

    # --------------------------------------------------------
    # DONE
    # --------------------------------------------------------

    print(
        "\n================================"
    )

    print(
        "CMAPSS preprocessing complete."
    )

    print(
        "================================"
    )

    print(
        f"\nX shape: {X_tensor.shape}"
    )

    print(
        f"y shape: {y_tensor.shape}"
    )

    print(
        "\nSaved to:"
    )

    print(
        OUTPUT_DIR
    )