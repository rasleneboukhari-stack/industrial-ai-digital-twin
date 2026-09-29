use postgres::{Client as PgClient, NoTls};
use serde::Deserialize;
use std::sync::mpsc::Receiver;
use std::thread;

#[derive(Debug, Deserialize)]
pub struct TrainingSample {
    pub simulated_minute: i64,
    pub machine_id: i32,
    pub temperature: f64,
    pub vibration: f64,
    pub rpm: f64,
    pub load: f64,
    pub current: f64,
    pub health: f64,
    pub running: bool,
    pub state_code: i32,
}

pub fn start_training_writer(
    receiver: Receiver<Vec<TrainingSample>>,
) {
    thread::spawn(move || {
        let mut db = PgClient::connect(
            "host=localhost port=5433 user=industrial password=industrial dbname=factory",
            NoTls,
        )
            .expect("Failed to connect training DB writer");

        println!("Training DB writer running...");

        for batch in receiver {
            let count = batch.len();

            match insert_batch(
                &mut db,
                &batch,
            ) {
                Ok(_) => {
                    println!(
                        "Training batch stored: {} rows",
                        count
                    );
                }

                Err(error) => {
                    eprintln!(
                        "Training batch insert failed: {}",
                        error
                    );
                }
            }
        }
    });
}

fn insert_batch(
    db: &mut PgClient,
    batch: &[TrainingSample],
) -> Result<(), postgres::Error> {
    if batch.is_empty() {
        return Ok(());
    }

    let mut transaction =
        db.transaction()?;

    let statement =
        transaction.prepare(
            "
            INSERT INTO training_telemetry
            (
                simulated_minute,
                machine_id,
                temperature,
                vibration,
                rpm,
                load,
                current,
                health,
                running,
                state_code
            )
            VALUES
            (
                $1,$2,$3,$4,$5,
                $6,$7,$8,$9,$10
            )
            "
        )?;

    for sample in batch {
        transaction.execute(
            &statement,
            &[
                &sample.simulated_minute,
                &sample.machine_id,
                &sample.temperature,
                &sample.vibration,
                &sample.rpm,
                &sample.load,
                &sample.current,
                &sample.health,
                &sample.running,
                &sample.state_code,
            ],
        )?;
    }

    transaction.commit()?;

    Ok(())
}