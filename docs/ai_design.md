# Simulator AI experiments

## Live advisory inference

`ai/live_inference.py` loads `ai/models/simulator_event_eta.pt` and publishes advisory messages only. The simulator emits its existing exact ten-minute samples on `factory/training/live`; the Rust gateway validates and relays them to `factory/ai/telemetry`; Python keeps a separate 30-sample window per machine and publishes new alerts on `factory/ai/messages`. Phaser subscribes to that topic and displays the alerts in its existing AI UI. Temperature, vibration, and excess current remain 24-hour risk targets; failure remains a 48-hour risk target. The ETA checkpoint adds six-hour cumulative risk bands. Alert titles may show a machine-specific approximate time, while the message retains the full horizon and a broad timing range. Model scores are not calibrated probabilities, and the timing range is not a guaranteed crossing time. Repair, stop, failure, missing-sample, and clock-reset boundaries clear the affected machine window. This path has no command publisher and cannot alter PLC or simulator state.

The ETA checkpoint transferred the existing load-context LSTM and trained a new 40-output head on 30×5 sensor windows. Current health remains target-only. On validation machines 17–20, first-warning failure ETAs landed in the correct six-hour band for only 8.1% of 37 warned episodes; median timing error was 8.8 hours and the 80th-percentile error was 17.3 hours. Temperature's median first-warning lead was 10.7 hours, so a 24-hour temperature advance warning is not established. An earlier simulator run with the same fixed seeds showed 25.0% six-hour failure-band accuracy over 112 warned episodes. These are simulator results, not independent factory validation. The UI therefore uses broad ranges rather than an exact countdown.

Start the simulator, gateway, and frontend normally, then run:

```bash
ai/.venv/bin/python ai/live_inference.py
```

## Load-context fine-tuning (completed 2026-09-28)

The previous simulator run held load near 50% (about 40–60% after noise), so it cannot teach the model how outcomes change at substantially lower or higher loads. The simulator now has an opt-in `SIM_TRAINING_LOAD_SWEEP=1` mode. During data collection it assigns each machine a setpoint from 30%, 45%, 60%, 75%, and 90%, changing every seven simulated days and staggering machine starting levels. The existing `10Kx` game control still sets simulation speed. This changes only training-mode load setpoints; normal PLC-controlled operation remains the default. The machine model approaches each setpoint gradually with its existing disturbance, so recorded load is not a perfectly fixed label.

The new `--profile load_context` checkpoint uses the same 30 consecutive samples of **temperature, vibration, RPM, load, current**, shaped `(batch, 30, 5)`. It outputs five logits `(batch, 5)`: a new sustained temperature crossing within 24 hours, a new sustained vibration crossing within 24 hours, a new sustained **excess-current** episode within 24 hours, a **rapid health decline** over the next 24 hours, and first failure within 48 hours. A current episode is three consecutive samples where `current - (2 + 0.12 * load) >= 1.5 A`; this subtracts the simulator's nominal current for that load. Rapid decline means `health(now) - health(24h later) >= 3` points. These example thresholds are configurable, and their usefulness must be evaluated after data collection. Health is used **only to construct the rapid-decline target**, never as an input. The former RPM limit output remains available in the legacy checkpoint but is omitted from this load-context profile because its old limit lacked useful warning performance.

Windows and targets stay inside one machine, repair cycle, and seven-day load block. Censored outcomes are masked. Machines 1–16 train; 17–20 select an epoch and preliminary alert cutoffs. The fine-tune transferred the existing five-sensor `simulator_events.pt` recurrent weights and learned a new five-output head; the earlier C-MAPSS and PRONOSTIA experiments remain available and unchanged. A forecast means **risk observed under the current operating load**. It does not prove that load caused the fault or that changing load will prevent it. The offline predictor remains available for local CSV scoring; the live runtime described above publishes advisory messages only.

The trained checkpoint is `ai/models/simulator_load_context.pt`; epoch 10 had the lowest validation BCE (`0.09783`). On validation machines 17–20, failure episode scoring warned 37/37 evaluable failures, 36 at least 24 simulated hours early, with 33 false-alert episodes. Excess-current scoring warned 147/166 evaluable episodes with 19 misses and 60 false-alert episodes. These machines also selected the epoch and cutoffs, so this is validation evidence rather than an independent test. A separately seeded run and factory-specific data are still required for stronger claims.

## Offline event forecast (2026-09-28)

`ai/train_events.py` trains a separate LSTM checkpoint for four outcomes from the preceding 30 samples of **temperature, vibration, RPM, load, and current**. Its input is `(batch, 30, 5)` and its output is `(batch, 4)` event logits. Current health, running state, and state code are never input features. Health resets identify repair cycles; running and state are used only to determine whether a label can be observed. A sensor event is three consecutive samples at or above its configured upper limit. The sensor target asks whether such a *new* event is confirmed within 24 simulated hours (144 samples). The failure target asks whether the simulator first enters `state_code == 3` within 48 simulated hours (288 samples). These are separate outcomes; a predicted sensor crossing does not imply it caused a failure.

Each label has an observation mask. A window already above a sensor limit is excluded for that sensor. A later repair or failure may cut short the observation period; then a missing sensor event is censored rather than called a negative. Positive events observed before the boundary remain positive. Windows never cross machine or repair-cycle boundaries, and inputs at an already failed machine state are excluded. The default sensor limits (temperature 100, vibration 1.5, RPM 2500) are **illustrative simulator operating limits**, not verified equipment safety limits. They are command-line options and stored in each event checkpoint.

`ai/train_events.py` can initialize compatible LSTM weights from an earlier C-MAPSS, PRONOSTIA, or simulator-health checkpoint; a fresh four-output head learns the event task. It normalizes using training machines only. Machines 1–16 train and 17–20 select the best epoch and initial four alert cutoffs. The trainer's cutoffs optimize validation F2, which gives missed events more weight than false alerts, and are not independently validated. `ai/evaluate_events.py` reports window average precision relative to event prevalence, Brier score, missed and false-alert windows, plus episode-level detection, lead time, and false-alert episodes. An actual episode is marked evaluable only when a selected pre-event window has an observed positive label. The live path is advisory; no AI model sends machine commands.

### Completed offline run

The September 27 run used up to 10,000 evenly spaced windows per machine and 12 epochs. The best scratch epoch (11) had validation BCE `0.06724`; the best C-MAPSS-initialized epoch (11) had `0.08225`. C-MAPSS transfer did not improve this event task. PRONOSTIA initialization is supported but was not rerun for this comparison. The recommended artifact is `ai/models/simulator_events.pt`: scratch weights plus a failure alert cutoff of `0.15`. That cutoff was chosen on September 27 validation to get at least 95% of evaluable failures warned at least 24 simulated hours early; it trades extra false alerts for lead time. The original F2-tuned scratch and C-MAPSS checkpoints remain in `ai/models/` for comparison.

| Failure forecast | Sep 27 validation (machines 17–20) | Sep 26 stress trajectory (machines 17–20) |
| --- | ---: | ---: |
| Actual/evaluable failure episodes | 124/124 | 4/4 |
| Warned before failure | 124/124 | 4/4 |
| Warned at least 24h before failure | 119/124 | 4/4 |
| Median lead among warnings | 2,685 min (44.8h) | 2,230 min (37.2h) |
| False-alert episodes | 92 | 4 |
| Failure-window AP / prevalence | 0.934 / 0.030 | 0.908 / 0.033 |

At the same recommended checkpoint, temperature AP was `0.963` on validation and `0.969` on the stress run; vibration AP was `0.935` and `0.838`. On validation, 228/228 evaluable temperature episodes were warned about with 715-minute median lead and 70 false-alert episodes; vibration was 295/295 with 280-minute median lead and 73 false-alert episodes. Many actual episodes were not evaluable because the selected window was already above the limit or its outcome was censored, so these counts do not imply detection of every observed crossing. These are forecasts of the **illustrative** limits, not evidence those values are hazardous. RPM AP was `0.050` versus `0.042` prevalence on validation and `0.040` versus `0.040` on stress; its example-limit alerts generated excessive false episodes. RPM remains a model output for research but is explicitly **disabled as an alert** in the recommended checkpoint and offline predictor.

September 27 was used to select the epoch and cutoffs, so its figures are validation results. September 26 contains only four failure events and shares fixed simulator seeds with September 27. Neither run is an independently seeded test or a field trial. The scores are not calibrated failure probabilities. These results support an offline simulator demonstration only; factory-specific sensor limits, real maintenance outcomes, independent test data, and advisory/shadow evaluation are still needed before any operational use.

To reproduce the offline run (from the repository root):

```bash
ai/.venv/bin/python ai/train_events.py --start 2026-09-27T00:00:00+00:00 --end 2026-09-28T00:00:00+00:00 --epochs 12 --max-sequences-per-machine 10000 --output ai/models/simulator_events_scratch.pt
ai/.venv/bin/python ai/evaluate_events.py --start 2026-09-26T00:00:00+00:00 --end 2026-09-27T00:00:00+00:00 --machines 17 18 19 20 --checkpoint ai/models/simulator_events.pt
ai/.venv/bin/python ai/predict_events.py --checkpoint ai/models/simulator_events.pt --input path/to/one_window.csv
```

The prediction CSV must contain exactly 30 ordered rows with `machine_id`, `cycle_id`, `simulated_minute`, and the five sensor columns. All rows must be one machine and repair cycle at 10-minute intervals. Only the five sensors enter the LSTM; the IDs and minute validate the offline input. Retraining is required if the sensor limits or event definitions change. The recommended checkpoint's failure cutoff and disabled RPM alert are post-training policy settings; rerunning the training command alone produces the original F2-tuned scratch checkpoint.

## Future-health experiment (2026-09-27)

The AI currently predicts simulator health 30 samples (300 simulated minutes) ahead from the preceding 30 samples of temperature, vibration, RPM, load, and current. Inputs have shape `(batch, 30, 5)` and the target is one future-health value on a 0–100 scale. Current health is **not** an input. Windows and targets stay inside one machine and one repair cycle.

## Experiment

- PRONOSTIA and C-MAPSS pretraining now split by bearing or engine **before** building windows. Normalization uses training groups only. Their new grouped checkpoints leave the earlier checkpoints intact.
- The September 27 simulator run supplies 10,000 evenly spaced windows per machine. Machines 1–16 train; machines 17–20 select the best epoch. All three fine-tunes use the same five sensor inputs, 30-sample horizon, batch size 256, learning rate `1e-4`, and at most 20 epochs.
- C-MAPSS transfers compatible recurrent weights from a 128-unit LSTM; PRONOSTIA transfers from a 64-unit LSTM. Both get a new five-sensor input weight and health head. Scratch uses a 128-unit LSTM with random initialization. The differing PRONOSTIA capacity limits causal claims about its pretraining benefit.
- The September 26 run is a separate trajectory used as a stress test on machines 17–20. Both runs share fixed simulator seeds and their first 10 samples per machine, so this is **not** an independently seeded test or field validation.

| Start | Sep 27 validation MAE / RMSE | Sep 26 trajectory MAE / RMSE |
| --- | ---: | ---: |
| C-MAPSS | 0.53 / 0.71 | 4.86 / 6.15 |
| PRONOSTIA | 0.43 / 0.63 | 3.27 / 4.12 |
| Scratch | **0.39 / 0.52** | **1.65 / 2.01** |

Each column scores 40,000 selected windows from machines 17–20. Errors are in health points. The September 27 values are validation scores used for epoch selection, not an untouched test. Scratch performed best in both comparisons; this experiment does not support a benefit from transferred weights for the current simulator target.

At a reporting threshold of health below 30, the evaluator counts missed low-health **windows** and false-alert **windows**. It also counts a repair cycle as an *evaluable crossing* when at least one selected input window has current health at least 30 and future health below 30. A warning must predict below 30 before the actual crossing; current health is used only to score this event and never enters the model. On the September 27 validation machines, C-MAPSS warned before 101/125 evaluable crossings, PRONOSTIA before 84/125, and scratch before 86/125. Median lead among detected crossings was 120, 115, and 120 simulated minutes respectively. The September 26 trajectory had only four evaluable crossings, all detected by every model; that sample is too small for an event-reliability claim.

On machine 1, future health changes by a median of only 0.26 points across the 300-minute horizon, and about 0.31% of input rows cross from at least 30 to below 30 during that horizon. Small prediction error therefore does not establish useful advance warning. The event counts are specific to this synthetic threshold and the 10,000-window sampling; they are not field failure rates.

## Before factory use

For a specific factory, collect representative sensor histories with asset IDs, timestamps, operating conditions, repairs, and confirmed fault/maintenance outcomes. Define a field-observable target because the simulator's 0–100 health label may not exist on real equipment. Keep whole machines and repair lifecycles separate across training, validation, and an untouched later test period. Evaluate lead time, missed failures, false alarms, calibration, and performance under operating changes. Run the model in advisory/shadow mode before considering automated commands. No factory data or field validation is available yet.
