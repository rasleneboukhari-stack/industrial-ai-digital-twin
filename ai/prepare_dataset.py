"""Prepare simulator observations for future-health fine-tuning."""

import numpy as np
import pandas as pd

from loaders.simulator_loader import FEATURES, SAMPLE_INTERVAL, load_simulator_run


HORIZON = 30
SEQUENCE_LENGTH = 30
SENSOR_HORIZON = 24 * 60 // SAMPLE_INTERVAL
FAILURE_HORIZON = 48 * 60 // SAMPLE_INTERVAL
EVENT_SENSORS = ("temperature", "vibration", "rpm")
EVENT_NAMES = (*EVENT_SENSORS, "failure")
LOAD_CONTEXT_EVENT_NAMES = (
    "temperature", "vibration", "current_excess", "rapid_health_loss", "failure"
)
LOAD_BLOCK_MINUTES = 7 * 24 * 60


def _labeled_history(machine_id, start, end, horizon):
    """Keep future-health targets inside each repair cycle."""
    if horizon < 1:
        raise ValueError("horizon must be positive")

    df = load_simulator_run(machine_id, start, end)

    # A repair resets health upward.
    # Create a new degradation cycle whenever that happens.
    df["repair_event"] = df["health"].diff().gt(10)
    df["cycle_id"] = df["repair_event"].cumsum()

    # Predict health horizon samples into the future,
    # but NEVER across a repair boundary.
    df["future_health"] = (
        df.groupby("cycle_id")["health"]
        .shift(-horizon)
    )

    # The last horizon rows of each cycle cannot have an in-cycle target.
    return df.dropna(subset=["future_health"])


def prepare_dataset(machine_id, start, end, horizon=HORIZON):
    """Return X=(rows, 5) and future-health y=(rows,) for one machine.

    Use build_simulator_sequences for LSTM-shaped inputs.
    """
    df = _labeled_history(machine_id, start, end, horizon)

    X = df[list(FEATURES)].copy()
    y = df["future_health"].copy()

    return X, y


def build_simulator_sequences(
    machine_id, start, end, sequence_length=SEQUENCE_LENGTH, horizon=HORIZON
):
    """Return sensor windows, future health, and their lifecycle metadata.

    X has shape (examples, sequence_length, 5); y has shape (examples,).
    Every window and target belongs to one machine and one repair cycle.
    """
    if sequence_length < 1:
        raise ValueError("sequence_length must be positive")

    history = _labeled_history(machine_id, start, end, horizon)
    cycles = list(history.groupby("cycle_id", sort=False))
    count = sum(max(0, len(cycle) - sequence_length + 1) for _, cycle in cycles)
    if count == 0:
        raise ValueError("No complete sequences with an in-cycle future target")

    X = np.empty((count, sequence_length, len(FEATURES)), dtype=np.float32)
    y = np.empty(count, dtype=np.float32)
    group_rows = np.empty((count, 4), dtype=np.int64)

    row = 0
    for cycle_id, cycle in cycles:
        sensors = cycle[list(FEATURES)].to_numpy(dtype=np.float32)
        targets = cycle["future_health"].to_numpy(dtype=np.float32)
        minutes = cycle["simulated_minute"].to_numpy(dtype=np.int64)

        for last in range(sequence_length - 1, len(cycle)):
            X[row] = sensors[last - sequence_length + 1:last + 1]
            y[row] = targets[last]
            group_rows[row] = (
                machine_id,
                cycle_id,
                minutes[last],
                minutes[last] + horizon * SAMPLE_INTERVAL,
            )
            row += 1

    groups = pd.DataFrame(
        group_rows,
        columns=["machine_id", "cycle_id", "input_minute", "target_minute"],
    )
    return X, y, groups


def _confirmed_crossings(values, limit, running, confirmation_samples):
    """Indices where a new sustained upper-limit episode is confirmed."""
    breached = (values >= limit) & running
    confirmed = np.convolve(
        breached.astype(np.int32),
        np.ones(confirmation_samples, dtype=np.int32),
        mode="full",
    )[:len(values)] == confirmation_samples
    return np.flatnonzero(confirmed & ~np.r_[False, confirmed[:-1]])


def _next_event(event_indices, positions):
    """First event strictly after each input, or a sentinel beyond this cycle."""
    locations = np.searchsorted(event_indices, positions + 1)
    return np.concatenate((event_indices, [np.iinfo(np.int64).max]))[
        locations
    ]


def build_event_sequences(
    machine_id, start, end, limits, sequence_length=SEQUENCE_LENGTH,
    sensor_horizon=SENSOR_HORIZON, failure_horizon=FAILURE_HORIZON,
    confirmation_samples=3, max_sequences=None, profile="legacy",
    load_block_minutes=None,
):
    """Return X, binary labels, observed-label mask, and lifecycle metadata.

    X: (examples, sequence_length, 5); labels/mask: (examples, outputs).
    A positive needs an observed event within its horizon. A negative needs
    the full horizon observed before repair or failure. Censored labels are
    masked rather than treated as negatives.
    """
    if sequence_length < 1 or sensor_horizon < 1 or failure_horizon < 1:
        raise ValueError("sequence length and horizons must be positive")
    if confirmation_samples < 1:
        raise ValueError("confirmation_samples must be positive")
    if max_sequences is not None and max_sequences < 1:
        raise ValueError("max_sequences must be positive")
    if profile == "legacy":
        event_names = EVENT_NAMES
        sensor_names = EVENT_SENSORS
        if load_block_minutes is not None:
            raise ValueError("load blocks require the load_context profile")
    elif profile == "load_context":
        event_names = LOAD_CONTEXT_EVENT_NAMES
        sensor_names = ("temperature", "vibration", "current_excess")
        if load_block_minutes is None:
            load_block_minutes = LOAD_BLOCK_MINUTES
        if load_block_minutes < max(sensor_horizon, failure_horizon) * SAMPLE_INTERVAL:
            raise ValueError("load block must cover both forecast horizons")
    else:
        raise ValueError("Unknown event profile")
    expected_limits = set(event_names) - {"failure"}
    if set(limits) != expected_limits or any(
        not np.isfinite(limits[name]) or limits[name] <= 0 for name in expected_limits
    ):
        raise ValueError(f"limits must contain positive finite values for {sorted(expected_limits)}")

    history = load_simulator_run(machine_id, start, end)
    history["cycle_id"] = history["health"].diff().gt(10).cumsum()
    history["load_block_id"] = (
        history["simulated_minute"] // load_block_minutes
        if load_block_minutes is not None else 0
    )
    cycles = []
    for (cycle_id, block_id), cycle in history.groupby(
        ["cycle_id", "load_block_id"], sort=False
    ):
        n = len(cycle)
        if n < sequence_length:
            continue
        sensors = cycle[list(FEATURES)].to_numpy(dtype=np.float32)
        running = cycle["running"].to_numpy(dtype=bool)
        states = cycle["state_code"].to_numpy(dtype=np.int8)
        positions = np.arange(sequence_length - 1, n)
        eligible = running[positions] & (states[positions] != 3)
        failure_events = np.flatnonzero(
            (states == 3) & ~np.r_[False, states[:-1] == 3]
        )
        next_failure = _next_event(failure_events, positions)
        labels = np.zeros((len(positions), len(event_names)), dtype=np.float32)
        mask = np.zeros_like(labels, dtype=bool)
        event_minutes = np.full(labels.shape, -1, dtype=np.int64)
        minutes = cycle["simulated_minute"].to_numpy(dtype=np.int64)

        for column, name in enumerate(sensor_names):
            values = (
                sensors[:, FEATURES.index("current")] -
                (2.0 + 0.12 * sensors[:, FEATURES.index("load")])
                if name == "current_excess" else sensors[:, FEATURES.index(name)]
            )
            events = _confirmed_crossings(
                values, limits[name], running, confirmation_samples
            )
            next_sensor = _next_event(events, positions)
            positive = (next_sensor <= positions + sensor_horizon) & (
                next_sensor < next_failure
            )
            complete_negative = (positions + sensor_horizon < n) & (
                next_failure > positions + sensor_horizon
            )
            mask[:, column] = eligible & (values[positions] < limits[name]) & (
                positive | complete_negative
            )
            labels[:, column] = positive & mask[:, column]
            valid_event = labels[:, column].astype(bool)
            event_minutes[valid_event, column] = minutes[next_sensor[valid_event]]

        if profile == "load_context":
            column = event_names.index("rapid_health_loss")
            future = positions + sensor_horizon
            complete = (future < n) & (next_failure > future)
            health = cycle["health"].to_numpy(dtype=np.float32)
            mask[:, column] = eligible & complete
            labels[:, column] = mask[:, column] & (
                health[positions] - health[np.minimum(future, n - 1)] >= limits["rapid_health_loss"]
            )
            positive = labels[:, column].astype(bool)
            event_minutes[positive, column] = minutes[future[positive]]

        positive_failure = next_failure <= positions + failure_horizon
        mask[:, -1] = eligible & (positive_failure | (positions + failure_horizon < n))
        labels[:, -1] = positive_failure & mask[:, -1]
        valid_failure = labels[:, -1].astype(bool)
        event_minutes[valid_failure, -1] = minutes[next_failure[valid_failure]]

        usable = mask.any(axis=1)
        if usable.any():
            cycles.append((cycle_id, block_id, sensors, minutes, positions[usable],
                           labels[usable], mask[usable], event_minutes[usable]))

    total = sum(len(cycle[4]) for cycle in cycles)
    if total == 0:
        raise ValueError("No event windows with observed labels")
    selected = np.arange(total) if max_sequences is None or total <= max_sequences else np.linspace(
        0, total - 1, max_sequences, dtype=np.int64
    )
    X = np.empty((len(selected), sequence_length, len(FEATURES)), dtype=np.float32)
    y = np.empty((len(selected), len(event_names)), dtype=np.float32)
    observed = np.empty_like(y, dtype=bool)
    group_rows = np.empty((len(selected), 4 + len(event_names)), dtype=np.int64)
    offsets = np.cumsum([0, *(len(cycle[4]) for cycle in cycles)])
    for row, global_index in enumerate(selected):
        cycle_slot = np.searchsorted(offsets, global_index, side="right") - 1
        cycle_id, block_id, sensors, minutes, positions, labels, mask, event_minutes = cycles[cycle_slot]
        local_index = global_index - offsets[cycle_slot]
        last = positions[local_index]
        X[row] = sensors[last - sequence_length + 1:last + 1]
        y[row] = labels[local_index]
        observed[row] = mask[local_index]
        group_rows[row] = (machine_id, cycle_id, block_id, minutes[last], *event_minutes[local_index])

    groups = pd.DataFrame(
        group_rows,
        columns=["machine_id", "cycle_id", "load_block_id", "input_minute", *(
            f"{name}_event_minute" for name in event_names
        )],
    )
    return X, y, observed, groups
