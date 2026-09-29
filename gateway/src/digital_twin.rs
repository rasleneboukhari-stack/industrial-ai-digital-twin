use std::collections::HashMap;
use crate::machine::{MachineState, MachineStatus};
use std::time::{Instant, Duration};

pub struct DigitalTwin {

    machines: HashMap<i32, MachineState>,

}


impl DigitalTwin {


    pub fn new() -> Self {

        DigitalTwin {
            machines: HashMap::new(),
        }

    }


    pub fn update_machine(
        &mut self,
        machine: MachineState
    ) {

        self.machines.insert(
            machine.id,
            machine
        );

    }


    pub fn print(&self) {

        println!("{:?}", self.machines);

    }

    pub fn check_timeouts(&mut self) {

        for machine in self.machines.values_mut() {

            if machine.last_seen.elapsed() > Duration::from_secs(10) {

                machine.status = MachineStatus::Offline;

            }

        }

    }

}