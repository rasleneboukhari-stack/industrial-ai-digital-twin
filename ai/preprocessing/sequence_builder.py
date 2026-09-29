import numpy as np
import pandas as pd

import sys
import os


FEATURES = [
    "vibration_rms",
    "vibration_std",
    "vibration_peak",
    "vibration_kurtosis",
]


def build_sequences(
        df,
        sequence_length=30
):
    """
    Convert machine histories into sequences for the LSTM.

    Example:

        timestep 1  \
        timestep 2   \
        ...           > one sequence
        timestep 30 /

        target = RUL at timestep 30
    """

    X = []
    y = []

    # Process every bearing separately.
    # We must NEVER create a sequence across two different bearings.
    for machine_id, machine_df in df.groupby("machine_id"):

        machine_df = machine_df.sort_values(
            "measurement"
        ).reset_index(drop=True)

        # Remove rows where required features are missing.
        machine_df = machine_df.dropna(
            subset=FEATURES + ["rul"]
        )

        values = machine_df[FEATURES].to_numpy(
            dtype=np.float32
        )

        targets = machine_df["rul"].to_numpy(
            dtype=np.float32
        )

        if len(values) < sequence_length:
            continue

        # Sliding window
        for start in range(
                len(values) - sequence_length + 1
        ):

            end = start + sequence_length

            sequence = values[start:end]

            target = targets[end - 1]

            X.append(sequence)
            y.append(target)

    X = np.asarray(
        X,
        dtype=np.float32
    )

    y = np.asarray(
        y,
        dtype=np.float32
    )

    return X, y


if __name__ == "__main__":



    AI_DIR = os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))
    )

    sys.path.insert(0, AI_DIR)

    from loaders.pronostia_loader import (
        load_pronostia,
        add_rul,
    )

    print("Loading PRONOSTIA...")

    df = load_pronostia(
        include_validation=False
    )

    df = add_rul(df)

    print(
        f"Loaded {len(df):,} measurements"
    )

    X, y = build_sequences(
        df,
        sequence_length=30
    )

    print("\nSequence dataset created.")

    print(
        f"X shape: {X.shape}"
    )

    print(
        f"y shape: {y.shape}"
    )

    if len(X) > 0:

        print(
            f"\nOne sequence shape: "
            f"{X[0].shape}"
        )

        print(
            f"First target RUL: "
            f"{y[0]}"
        )