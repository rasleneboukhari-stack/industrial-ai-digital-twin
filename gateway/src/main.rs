mod command_api;
mod digital_twin;
mod machine;
mod plc_client;
mod system_alerts;
mod training_data;

use command_api::start_command_api;
use digital_twin::DigitalTwin;
use machine::{MachineData, MachineState, MachineStatus};
use plc_client::PlcClient;

use system_alerts::SystemAlertMonitor;
use training_data::{TrainingSample, start_training_writer};

use std::sync::{Arc, Mutex, mpsc};

use std::thread;
use std::time::{Duration, Instant};

use postgres::{Client as PgClient, NoTls};

use rumqttc::{Client, Event, Incoming, MqttOptions, QoS};

fn command_code(command: &str) -> Option<i32> {
    match command {
        "START" => Some(1),

        "STOP" => Some(2),

        "SET_LOAD" => Some(3),

        "REDUCE_LOAD" => Some(4),

        "SET_COOLING" => Some(5),

        "SET_AUTO_REPAIR" => Some(6),

        _ => None,
    }
}

fn state_name(code: i32) -> &'static str {
    match code {
        1 => "WARNING",

        2 => "DEGRADING",

        3 => "FAILURE",

        _ => "NORMAL",
    }
}

fn main() {
    const NUM_MACHINES: i32 = 20;

    // =====================================================
    // PLC
    // =====================================================

    let mut plc = PlcClient::connect().expect("Failed to connect to PLC");

    // Initial simulation speed.
    let mut current_simulation_speed = 1;
    let mut current_paused = false;

    plc.set_simulation_speed(current_simulation_speed, false)
        .expect("Failed to initialize simulation speed");

    // =====================================================
    // HTTP COMMAND CHANNELS
    // =====================================================

    let (command_tx, command_rx) = mpsc::channel();

    let (simulation_tx, simulation_rx) = mpsc::channel();

    start_command_api(command_tx, simulation_tx);

    // =====================================================
    // DATABASE
    // =====================================================

    let mut db = PgClient::connect(
        "host=localhost port=5433 user=industrial password=industrial dbname=factory",
        NoTls,
    )
    .expect("Failed to connect to TimescaleDB");

    // =====================================================
    // MQTT
    // Rust -> Phaser live telemetry
    // C++ -> Rust training batches
    // =====================================================

    let mut mqttoptions = MqttOptions::new("rust_gateway", "localhost", 1883);

    mqttoptions.set_keep_alive(Duration::from_secs(5));

    mqttoptions.set_max_packet_size(16 * 1024 * 1024, 16 * 1024 * 1024);

    let (client, mut connection) = Client::new(mqttoptions, 100);

    // =====================================================
    // TRAINING DB WRITER
    // =====================================================

    let (training_tx, training_rx) = mpsc::channel::<Vec<TrainingSample>>();

    start_training_writer(training_rx);

    client
        .subscribe("factory/training/batch", QoS::AtLeastOnce)
        .expect("Failed to subscribe to training batches");

    client
        .subscribe("factory/training/live", QoS::AtLeastOnce)
        .expect("Failed to subscribe to live AI samples");

    // The MQTT event loop must never publish into its own bounded client queue:
    // a full queue would block the only thread able to drain it.
    let (outbound_tx, outbound_rx) = mpsc::channel::<(String, Vec<u8>)>();
    let outbound_client = client.clone();
    thread::spawn(move || {
        for (topic, payload) in outbound_rx {
            if let Err(error) = outbound_client.publish(topic, QoS::AtLeastOnce, false, payload) {
                eprintln!("MQTT relay publish failed: {}", error);
            }
        }
    });

    // =====================================================
    // MQTT NETWORK LOOP
    // =====================================================

    thread::spawn(move || {
        let mut system_alerts = SystemAlertMonitor::new();
        for notification in connection.iter() {
            match notification {
                Ok(Event::Incoming(Incoming::Publish(packet))) => {
                    if packet.topic == "factory/training/batch" {
                        match serde_json::from_slice::<Vec<TrainingSample>>(&packet.payload) {
                            Ok(batch) => {
                                if let Err(error) = training_tx.send(batch) {
                                    eprintln!("Training channel failed: {}", error);
                                }
                            }

                            Err(error) => {
                                eprintln!("Invalid training batch: {}", error);
                            }
                        }
                    } else if packet.topic == "factory/training/live" {
                        match serde_json::from_slice::<Vec<TrainingSample>>(&packet.payload) {
                            Ok(batch) => {
                                for sample in &batch {
                                    for alert in system_alerts.observe(sample) {
                                        if let Err(error) = outbound_tx.send((
                                            "factory/system/alerts".to_string(),
                                            alert.to_string().into_bytes(),
                                        )) {
                                            eprintln!("System alert relay failed: {}", error);
                                        }
                                    }
                                }
                                if let Err(error) = outbound_tx.send((
                                    "factory/ai/telemetry".to_string(),
                                    packet.payload.to_vec(),
                                )) {
                                    eprintln!("AI telemetry relay failed: {}", error);
                                }
                            }

                            Err(error) => {
                                eprintln!("Invalid live AI samples: {}", error);
                            }
                        }
                    }
                }

                Ok(_) => {}

                Err(error) => {
                    eprintln!("MQTT connection error: {}", error);
                }
            }
        }
    });

    // =====================================================
    // DIGITAL TWIN
    // =====================================================

    let twin = Arc::new(Mutex::new(DigitalTwin::new()));

    let twin_timeout = Arc::clone(&twin);

    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(2));

            let mut twin = twin_timeout.lock().unwrap();

            twin.check_timeouts();
        }
    });

    println!("Rust Gateway running...");

    // =====================================================
    // MAIN LOOP
    // =====================================================

    loop {
        // =================================================
        // OPERATOR / GLOBAL COMMANDS
        // Phaser -> Rust -> PLC
        // =================================================

        while let Ok(request) = command_rx.try_recv() {
            if let Some(code) = command_code(&request.command) {
                match plc.send_command(request.machine_id, code, request.value) {
                    Ok(_) => {
                        if request.command == "SET_AUTO_REPAIR" {
                            let enabled = request.value == Some(1);

                            println!("Automatic repair: {}", if enabled { "ON" } else { "OFF" });
                        } else {
                            println!(
                                "Operator command M{}: {} {:?}",
                                request.machine_id, request.command, request.value
                            );
                        }
                    }

                    Err(error) => {
                        eprintln!("PLC command failed: {}", error);
                    }
                }
            } else {
                eprintln!("Unknown command: {}", request.command);
            }
        }

        // =================================================
        // SIMULATION SPEED
        // =================================================

        while let Ok(control) = simulation_rx.try_recv() {
            if !control.paused {
                current_simulation_speed = control.speed;
            }

            match plc.set_simulation_speed(current_simulation_speed, control.paused) {
                Ok(_) => {
                    current_paused = control.paused;
                    if control.paused {
                        println!("Simulation: PAUSED");
                    } else {
                        println!("Simulation: {}x", current_simulation_speed);
                    }
                }

                Err(error) => {
                    eprintln!("Failed to change simulation speed: {}", error);
                }
            }
        }

        // =================================================
        // SIMULATED CLOCK
        // =================================================

        let simulated_minute = match plc.read_simulated_minute() {
            Ok(minute) => minute,

            Err(error) => {
                eprintln!("Failed to read simulation clock: {}", error);

                thread::sleep(Duration::from_secs(1));

                continue;
            }
        };

        // =================================================
        // POLL MACHINES
        // =================================================

        for machine_id in 1..=NUM_MACHINES {
            let telemetry = match plc.read_telemetry(machine_id) {
                Ok(data) => data,

                Err(error) => {
                    eprintln!("PLC telemetry M{} failed: {}", machine_id, error);

                    continue;
                }
            };

            // ---------------------------------------------
            // PLC -> RUST MACHINE DATA
            // ---------------------------------------------

            let machine = MachineData {
                id: telemetry.machine_id,

                temperature: telemetry.temperature as f64,

                vibration: telemetry.vibration as f64,

                rpm: telemetry.rpm as f64,

                load: telemetry.load as f64,

                current: telemetry.current as f64,

                health: telemetry.health as f64,
            };

            // ---------------------------------------------
            // DIGITAL TWIN
            // ---------------------------------------------

            let state = MachineState {
                id: machine.id,

                temperature: machine.temperature,

                vibration: machine.vibration,

                rpm: machine.rpm,

                load: machine.load,

                current: machine.current,

                health: machine.health,

                last_seen: Instant::now(),

                status: MachineStatus::Online,
            };

            {
                let mut twin = twin.lock().unwrap();

                twin.update_machine(state);
            }

            // ---------------------------------------------
            // LIVE TELEMETRY DATABASE
            // ---------------------------------------------

            let cooling = telemetry.cooling as f64;

            if let Err(error) = db.execute(
                "
                    INSERT INTO machine_telemetry
                    (
                        time,
                        machine_id,
                        temperature,
                        vibration,
                        rpm,
                        load,
                        current,
                        health,
                        cooling,
                        running,
                        state_code,
                        simulated_minute
                    )
                    VALUES
                    (
                        NOW(),
                        $1,$2,$3,$4,$5,$6,
                        $7,$8,$9,$10,$11
                    )
                    ",
                &[
                    &machine.id,
                    &machine.temperature,
                    &machine.vibration,
                    &machine.rpm,
                    &machine.load,
                    &machine.current,
                    &machine.health,
                    &cooling,
                    &telemetry.running,
                    &telemetry.state_code,
                    &simulated_minute,
                ],
            ) {
                eprintln!("DB insert failed M{}: {}", machine.id, error);
            }

            // ---------------------------------------------
            // MQTT LIVE TELEMETRY -> PHASER
            // ---------------------------------------------

            let payload = serde_json::json!({
                "id":
                    machine.id,

                "temperature":
                    machine.temperature,

                "vibration":
                    machine.vibration,

                "rpm":
                    machine.rpm,

                "load":
                    machine.load,

                "current":
                    machine.current,

                "cooling":
                    cooling,

                "health":
                    machine.health,

                "running":
                    telemetry.running,

                "state":
                    state_name(
                        telemetry.state_code
                    ),

                "simulatedMinute":
                    simulated_minute,

                "simulationSpeed":
                    current_simulation_speed,

                "paused":
                    current_paused
            });

            let topic = format!("factory/machine/{}/telemetry", machine.id);

            if let Err(error) = client.publish(topic, QoS::AtLeastOnce, false, payload.to_string())
            {
                eprintln!("MQTT publish failed M{}: {}", machine.id, error);
            }
        }

        thread::sleep(Duration::from_secs(1));
    }
}
