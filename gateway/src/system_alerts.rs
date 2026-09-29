use std::collections::HashMap;

use serde_json::{Value, json};

use crate::training_data::TrainingSample;

// These simulator operating limits match the trained event checkpoint.
const TEMPERATURE_LIMIT: f64 = 100.0;
const VIBRATION_LIMIT: f64 = 1.5;
const CURRENT_EXCESS_LIMIT: f64 = 1.5;

#[derive(Default)]
struct ConditionState {
    consecutive: u8,
    active_since: Option<i64>,
    last_emitted_minute: Option<i64>,
}

pub struct SystemAlertMonitor {
    conditions: HashMap<(i32, &'static str), ConditionState>,
    last_minute: HashMap<i32, i64>,
}

impl SystemAlertMonitor {
    pub fn new() -> Self {
        Self {
            conditions: HashMap::new(),
            last_minute: HashMap::new(),
        }
    }

    pub fn observe(&mut self, sample: &TrainingSample) -> Vec<Value> {
        let previous = self.last_minute.insert(sample.machine_id, sample.simulated_minute);
        if let Some(previous) = previous {
            if sample.simulated_minute == previous {
                return Vec::new();
            }
            if sample.simulated_minute < previous {
                self.conditions.retain(|(machine_id, _), _| *machine_id != sample.machine_id);
            } else if sample.simulated_minute - previous != 10 {
                for ((machine_id, _), state) in &mut self.conditions {
                    if *machine_id == sample.machine_id {
                        state.consecutive = 0;
                    }
                }
            }
        }

        let failed = sample.state_code == 3;
        let operating = sample.running && !failed;
        let current_excess = sample.current - (2.0 + 0.12 * sample.load);
        let checks = [
            ("failure", failed, 1, "CRITICAL", "Machine failure active",
             "The simulator reports an actual machine failure.", "Inspect and repair the machine."),
            ("temperature", operating && sample.temperature >= TEMPERATURE_LIMIT, 3,
             "HIGH", "Temperature operating limit reached",
             "Temperature has remained above the demo operating limit.", "Inspect cooling and load."),
            ("vibration", operating && sample.vibration >= VIBRATION_LIMIT, 3,
             "HIGH", "Vibration operating limit reached",
             "Vibration has remained above the demo operating limit.", "Inspect the mechanical condition."),
            ("current_excess", operating && current_excess >= CURRENT_EXCESS_LIMIT, 3,
             "HIGH", "Current excess observed",
             "Current has remained high for the measured load.", "Inspect load and electrical condition."),
        ];

        let mut alerts = Vec::new();
        for (kind, observed, required, severity, title, message, recommendation) in checks {
            let state = self.conditions.entry((sample.machine_id, kind)).or_default();
            if observed {
                state.consecutive = state.consecutive.saturating_add(1);
                if state.consecutive >= required {
                    let since = *state.active_since.get_or_insert(
                        sample.simulated_minute - i64::from(required - 1) * 10
                    );
                    if state.last_emitted_minute.is_none_or(
                        |last| sample.simulated_minute - last >= 60
                    ) {
                        alerts.push(alert(sample, kind, since, "ACTIVE", severity, title,
                                          message, recommendation));
                        state.last_emitted_minute = Some(sample.simulated_minute);
                    }
                }
            } else {
                state.consecutive = 0;
                state.last_emitted_minute = None;
                if let Some(since) = state.active_since.take() {
                    alerts.push(alert(sample, kind, since, "RESOLVED", severity, title,
                                      message, recommendation));
                }
            }
        }
        alerts
    }
}

fn alert(sample: &TrainingSample, kind: &str, since: i64, status: &str,
         severity: &str, title: &str, message: &str, recommendation: &str) -> Value {
    json!({
        "id": format!("system-{}-{}-{}", sample.machine_id, kind, since),
        "machineId": sample.machine_id,
        "source": "SYSTEM",
        "severity": severity,
        "title": title,
        "message": message,
        "recommendation": recommendation,
        "status": status,
        "onsetSimulatedMinute": since,
        "observedSimulatedMinute": sample.simulated_minute,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(minute: i64) -> TrainingSample {
        TrainingSample {
            simulated_minute: minute, machine_id: 1, temperature: 70.0,
            vibration: 0.4, rpm: 2300.0, load: 50.0, current: 8.0,
            health: 90.0, running: true, state_code: 0,
        }
    }

    #[test]
    fn sustained_limit_creates_one_episode_and_resolves() {
        let mut monitor = SystemAlertMonitor::new();
        for minute in [10, 20] {
            let mut reading = sample(minute);
            reading.temperature = 101.0;
            assert!(monitor.observe(&reading).is_empty());
        }
        let mut reading = sample(30);
        reading.temperature = 101.0;
        let first = monitor.observe(&reading);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["status"], "ACTIVE");
        assert_eq!(first[0]["onsetSimulatedMinute"], 10);
        assert_eq!(monitor.observe(&sample(30)).len(), 0);

        let mut reading = sample(40);
        reading.temperature = 101.0;
        assert!(monitor.observe(&reading).is_empty());
        for minute in [50, 60, 70, 80] {
            reading.simulated_minute = minute;
            assert!(monitor.observe(&reading).is_empty());
        }
        reading.simulated_minute = 90;
        assert_eq!(monitor.observe(&reading)[0]["id"], first[0]["id"]);
        let resolved = monitor.observe(&sample(100));
        assert_eq!(resolved[0]["status"], "RESOLVED");
        assert_eq!(resolved[0]["id"], first[0]["id"]);
    }

    #[test]
    fn failure_supersedes_sensor_alerts_immediately() {
        let mut monitor = SystemAlertMonitor::new();
        for minute in [10, 20, 30] {
            let mut reading = sample(minute);
            reading.vibration = 1.6;
            monitor.observe(&reading);
        }
        let mut failed = sample(40);
        failed.state_code = 3;
        failed.running = false;
        let alerts = monitor.observe(&failed);
        assert!(alerts.iter().any(|entry| entry["title"] == "Machine failure active"
            && entry["status"] == "ACTIVE"));
        assert!(alerts.iter().any(|entry| entry["title"] == "Vibration operating limit reached"
            && entry["status"] == "RESOLVED"));
    }
}
