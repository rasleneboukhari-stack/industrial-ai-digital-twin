use serde::{Deserialize};
use std::time::Instant;

#[derive(Debug)]
pub enum MachineStatus {
    Online,
    Offline,
}
#[derive(Debug)]
pub struct MachineState {

    pub id: i32,

    pub temperature: f64,

    pub vibration: f64,

    pub rpm: f64,

    pub load: f64,

    pub current: f64,

    pub health: f64,
    pub last_seen: Instant,
    pub status: MachineStatus,

}

#[derive(Debug, Deserialize)]
pub struct MachineData {

    pub id: i32,

    pub temperature: f64,
    pub vibration: f64,
    pub rpm: f64,
    pub load: f64,
    pub current: f64,
    pub health: f64,

}