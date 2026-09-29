import os
import glob
import numpy as np
import pandas as pd


# ============================================================
# PATH
# ============================================================

DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "data",
    "pronostia",
    "10. FEMTO Bearing",
    "FEMTOBearingDataSet"
)


# ============================================================
# VIBRATION FEATURES
# ============================================================

def extract_vibration_features(values):
    """
    Convert a raw vibration signal into compact features.
    """

    values = np.asarray(
        values,
        dtype=np.float32
    )

    if len(values) == 0:
        return {
            "vibration_rms": 0.0,
            "vibration_std": 0.0,
            "vibration_peak": 0.0,
            "vibration_kurtosis": 0.0,
        }

    mean = np.mean(values)

    centered = values - mean

    std = np.std(values)

    rms = np.sqrt(
        np.mean(values ** 2)
    )

    peak = np.max(
        np.abs(values)
    )

    if std > 1e-8:

        kurtosis = (
                np.mean(centered ** 4)
                / (std ** 4)
        )

    else:

        kurtosis = 0.0

    return {
        "vibration_rms": float(rms),
        "vibration_std": float(std),
        "vibration_peak": float(peak),
        "vibration_kurtosis": float(kurtosis),
    }


# ============================================================
# FIND BEARING DIRECTORIES
# ============================================================

def find_bearing_directories(include_validation=True):
    """
    Find every Bearing* directory that actually contains
    FEMTO acceleration files.

    This works with the actual structure:

        Training_set/Learning_set/Bearing*
        Validation_Set/Full_Test_Set/Bearing*
    """

    directories = []

    for root, dirs, files in os.walk(DATA_DIR):

        # Only consider directories whose name starts
        # with "Bearing".
        if not os.path.basename(root).startswith("Bearing"):
            continue

        # A valid bearing directory must contain acc_*.csv
        acc_files = glob.glob(
            os.path.join(
                root,
                "acc_*.csv"
            )
        )

        if not acc_files:
            continue

        # Skip validation if requested
        if not include_validation:

            if "Validation_Set" in root:
                continue

        directories.append(root)

    return sorted(directories)


# ============================================================
# LOAD ONE BEARING
# ============================================================

def load_bearing(bearing_directory):
    """
    Load one complete bearing degradation history.

    Every vibration measurement becomes one timestep.
    """

    files = sorted(
        glob.glob(
            os.path.join(
                bearing_directory,
                "acc_*.csv"
            )
        )
    )

    if not files:

        raise FileNotFoundError(
            f"No vibration files found in:\n"
            f"{bearing_directory}"
        )

    rows = []

    for measurement_index, file_path in enumerate(files):

        try:

            data = pd.read_csv(
                file_path,
                header=None
            )

        except Exception as error:

            print(
                f"Could not read {file_path}: "
                f"{error}"
            )

            continue

        # FEMTO acceleration measurements.
        values = data.select_dtypes(
            include=[np.number]
        ).to_numpy()

        values = values.flatten()

        features = extract_vibration_features(
            values
        )

        rows.append(
            {
                "machine_id":
                    os.path.basename(
                        bearing_directory
                    ),

                "measurement":
                    measurement_index,

                **features,
            }
        )

    return pd.DataFrame(rows)


# ============================================================
# LOAD ALL BEARINGS
# ============================================================

def load_pronostia(include_validation=True):
    """
    Load all PRONOSTIA/FEMTO bearing histories.
    """

    directories = find_bearing_directories(
        include_validation=include_validation
    )

    if not directories:

        raise FileNotFoundError(
            f"No PRONOSTIA bearing directories found "
            f"under:\n{DATA_DIR}"
        )

    print(
        f"\nFound {len(directories)} bearing directories."
    )

    all_bearings = []

    for directory in directories:

        print(
            f"Loading: "
            f"{os.path.relpath(directory, DATA_DIR)}"
        )

        try:

            df = load_bearing(
                directory
            )

            if len(df) > 0:

                all_bearings.append(
                    df
                )

        except Exception as error:

            print(
                f"Skipped {directory}: "
                f"{error}"
            )

    if not all_bearings:

        raise RuntimeError(
            "No PRONOSTIA data could be loaded."
        )

    return pd.concat(
        all_bearings,
        ignore_index=True
    )


# ============================================================
# ADD RUL
# ============================================================

def add_rul(df):
    """
    Calculate Remaining Useful Life.

    For every bearing:

        RUL =
        final measurement - current measurement
    """

    df = df.copy()

    max_measurement = (
        df.groupby(
            "machine_id"
        )["measurement"]
        .transform("max")
    )

    df["rul"] = (
            max_measurement -
            df["measurement"]
    )

    return df


# ============================================================
# MAIN TEST
# ============================================================

if __name__ == "__main__":

    print("PRONOSTIA loader")

    print(
        f"\nData directory:\n{DATA_DIR}"
    )

    print("\nSearching for bearings...")

    bearings = find_bearing_directories(
        include_validation=True
    )

    print(
        f"Found {len(bearings)} bearing directories."
    )

    for bearing in bearings:
        print(
            "  ",
            os.path.relpath(
                bearing,
                DATA_DIR
            )
        )

    print("\nLoading data...")

    data = load_pronostia(
        include_validation=True
    )

    data = add_rul(
        data
    )

    print(
        "\n========================================"
    )
    print("LOADED SUCCESSFULLY")
    print("========================================")

    print(
        f"Rows: {len(data):,}"
    )

    print(
        f"Bearings: "
        f"{data['machine_id'].nunique()}"
    )

    print(
        "\nColumns:"
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