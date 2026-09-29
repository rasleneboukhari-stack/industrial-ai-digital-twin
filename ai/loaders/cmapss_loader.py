import os
import numpy as np
import pandas as pd


# ============================================================
# PATH
# ============================================================

DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "data",
    "cmapss",
    "CMAPSSData(1)"
)


# ============================================================
# CMAPSS COLUMNS
# ============================================================

COLUMNS = (
        ["unit", "cycle"]
        + [f"setting_{i}" for i in range(1, 4)]
        + [f"sensor_{i}" for i in range(1, 22)]
)


# ============================================================
# LOAD ONE TRAINING FILE
# ============================================================

def load_cmapss_file(filename):
    """
    Load one CMAPSS training dataset and calculate RUL.

    Example:
        train_FD001.txt

    Each engine/unit has a degradation history.
    RUL = final cycle - current cycle.
    """

    path = os.path.join(
        DATA_DIR,
        filename
    )

    if not os.path.exists(path):
        raise FileNotFoundError(
            f"CMAPSS file not found:\n{path}"
        )

    df = pd.read_csv(
        path,
        sep=r"\s+",
        header=None,
        names=COLUMNS
    )

    # --------------------------------------------------------
    # Calculate RUL separately for every engine.
    # --------------------------------------------------------

    max_cycle = (
        df.groupby("unit")["cycle"]
        .transform("max")
    )

    df["rul"] = (
            max_cycle - df["cycle"]
    )

    # --------------------------------------------------------
    # Rename unit to machine_id so the sequence builder
    # can treat each engine as a separate machine.
    # --------------------------------------------------------

    df["machine_id"] = (
            filename.replace(".txt", "")
            + "_"
            + df["unit"].astype(str)
    )

    return df


# ============================================================
# LOAD ALL CMAPSS TRAINING DATA
# ============================================================

def load_all_cmapss():
    """
    Load FD001, FD002, FD003 and FD004.

    Returns one DataFrame containing all engines.
    """

    datasets = [
        "train_FD001.txt",
        "train_FD002.txt",
        "train_FD003.txt",
        "train_FD004.txt",
    ]

    all_data = []

    for filename in datasets:

        print(
            f"Loading CMAPSS: {filename}"
        )

        df = load_cmapss_file(
            filename
        )

        all_data.append(df)

        print(
            f"  Engines: {df['unit'].nunique():,}"
        )

        print(
            f"  Measurements: {len(df):,}"
        )

    combined = pd.concat(
        all_data,
        ignore_index=True
    )

    return combined


# ============================================================
# CONVERT TO COMMON FEATURES
# ============================================================

def prepare_features(df):
    """
    Convert CMAPSS into the feature representation
    used by our temporal model.

    We keep the actual sensor information instead of
    inventing physical quantities that CMAPSS does not provide.
    """

    df = df.copy()

    feature_columns = (
            [f"setting_{i}" for i in range(1, 4)]
            + [f"sensor_{i}" for i in range(1, 22)]
    )

    # Keep only the features needed by the model.
    result = df[
        ["machine_id", "cycle", "rul"]
        + feature_columns
        ].copy()

    return result


# ============================================================
# MAIN TEST
# ============================================================

if __name__ == "__main__":

    print("CMAPSS loader")
    print(
        f"\nData directory:\n{DATA_DIR}"
    )

    data = load_all_cmapss()

    data = prepare_features(
        data
    )

    print(
        "\nLoaded successfully."
    )

    print(
        f"Total measurements: "
        f"{len(data):,}"
    )

    print(
        f"Total engines: "
        f"{data['machine_id'].nunique():,}"
    )

    print(
        "\nFeatures:"
    )

    print(
        data.columns.tolist()
    )

    print(
        "\nFirst rows:"
    )

    print(
        data.head()
    )

    print(
        "\nRUL statistics:"
    )

    print(
        data["rul"].describe()
    )