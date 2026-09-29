"""Load one simulator run from TimescaleDB, one machine at a time."""

from datetime import datetime

import numpy as np
import pandas as pd
import psycopg2


FEATURES = ("temperature", "vibration", "rpm", "load", "current")
SAMPLE_INTERVAL = 10  # simulated minutes between training samples


def load_simulator_run(machine_id: int, start: datetime, end: datetime) -> pd.DataFrame:
    """Return one machine's ordered samples from one ingestion-time window.

    ``start`` and ``end`` must be timezone-aware. The selected window must
    contain only one simulation run; repeated minutes are rejected.
    """
    if machine_id < 1:
        raise ValueError("machine_id must be positive")
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start and end must include a timezone")
    if start >= end:
        raise ValueError("start must be earlier than end")

    connection = psycopg2.connect(
        host="localhost",
        port=5433,
        database="factory",
        user="industrial",
        password="industrial",
    )
    try:
        df = pd.read_sql_query(
            """
            SELECT simulated_minute, machine_id,
                   temperature, vibration, rpm, load, current,
                   health, running, state_code, ingested_at
            FROM training_telemetry
            WHERE machine_id = %s
              AND ingested_at >= %s
              AND ingested_at < %s
            ORDER BY simulated_minute
            """,
            connection,
            params=(machine_id, start, end),
        )
    finally:
        connection.close()

    if df.empty:
        raise ValueError(f"No simulator samples found for machine {machine_id}")

    numeric_columns = [*FEATURES, "health"]
    if df[numeric_columns].isna().any().any() or not np.isfinite(
        df[numeric_columns].to_numpy(dtype=np.float64)
    ).all():
        raise ValueError(f"Machine {machine_id} has missing or non-finite values")
    if not df["health"].between(0, 100).all():
        raise ValueError(f"Machine {machine_id} has health outside 0..100")
    if not df["load"].between(0, 100).all():
        raise ValueError(f"Machine {machine_id} has load outside 0..100")
    if (df[["vibration", "rpm", "current"]] < 0).any().any():
        raise ValueError(f"Machine {machine_id} has negative sensor values")

    minutes = df["simulated_minute"]
    if minutes.duplicated().any():
        raise ValueError(f"Machine {machine_id} has overlapping simulation runs")
    if not minutes.mod(SAMPLE_INTERVAL).eq(0).all():
        raise ValueError(f"Machine {machine_id} has off-cadence samples")
    if not minutes.diff().dropna().eq(SAMPLE_INTERVAL).all():
        raise ValueError(f"Machine {machine_id} has missing simulation samples")

    return df
