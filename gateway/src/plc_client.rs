use std::net::SocketAddr;

use tokio_modbus::{
    client::sync::{tcp, Context, Reader, Writer},
    Slave,
};

pub struct PlcClient {
    ctx: Context,
    request_toggle: bool,
    telemetry_request_toggle: bool,
}

pub struct PlcTelemetry {
    pub machine_id: i32,
    pub temperature: f32,
    pub vibration: f32,
    pub rpm: f32,
    pub current: f32,
    pub load: f32,
    pub health: f32,
    pub cooling: f32,
    pub running: bool,
    pub state_code: i32,
}


impl PlcClient {
    pub fn connect() -> Result<Self, Box<dyn std::error::Error>> {
        let addr: SocketAddr =
            "127.0.0.1:1502".parse()?;

        let ctx =
            tcp::connect_slave(
                addr,
                Slave(1),
            )?;

        Ok(Self {
            ctx,
            request_toggle: false,
            telemetry_request_toggle: false,
        })
    }

    fn write_real(
        &mut self,
        address: u16,
        value: f32,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let bits = value.to_bits();

        let registers = [
            (bits >> 16) as u16,
            bits as u16,
        ];

        self.ctx.write_multiple_registers(
            address,
            &registers,
        )??;

        Ok(())
    }

    pub fn send_command(
        &mut self,
        machine_id: i32,
        command_code: i32,
        value: Option<i32>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let machine_index =
            machine_id - 1;

        // %MD7 -> Modbus registers 14-15
        self.write_real(
            14,
            machine_index as f32,
        )?;

        // %MD8 -> registers 16-17
        self.write_real(
            16,
            command_code as f32,
        )?;

        // %MD9 -> registers 18-19
        self.write_real(
            18,
            value.unwrap_or(0) as f32,
        )?;

        self.request_toggle =
            !self.request_toggle;

        // %MX0.3
        self.ctx.write_single_coil(
            3,
            self.request_toggle,
        )??;

        // Wait for %MX0.4 acknowledgement
        for _ in 0..50 {
            let response =
                self.ctx.read_coils(4, 1)??;

            if response[0] ==
                self.request_toggle
            {
                return Ok(());
            }

            std::thread::sleep(
                std::time::Duration::from_millis(2)
            );
        }

        Err("PLC command timeout".into())
    }

    fn read_real(
        &mut self,
        address: u16,
    ) -> Result<f32, Box<dyn std::error::Error>> {
        let registers =
            self.ctx.read_holding_registers(
                address,
                2,
            )??;

        let bits =
            ((registers[0] as u32) << 16)
                | registers[1] as u32;

        Ok(f32::from_bits(bits))
    }

    pub fn read_telemetry(
        &mut self,
        machine_id: i32,
    ) -> Result<PlcTelemetry, Box<dyn std::error::Error>> {

        let machine_index =
            machine_id - 1;

        // %MD12 -> registers 24-25
        self.write_real(
            24,
            machine_index as f32,
        )?;

        self.telemetry_request_toggle =
            !self.telemetry_request_toggle;

        // %MX0.7
        self.ctx.write_single_coil(
            7,
            self.telemetry_request_toggle,
        )??;

        // %MX1.0 = coil 8
        for _ in 0..50 {
            let response =
                self.ctx.read_coils(8, 1)??;

            if response[0] ==
                self.telemetry_request_toggle
            {
                let running =
                    self.ctx.read_coils(6, 1)??[0];

                return Ok(PlcTelemetry {
                    machine_id,

                    temperature:
                    self.read_real(26)?,

                    vibration:
                    self.read_real(28)?,

                    rpm:
                    self.read_real(30)?,

                    current:
                    self.read_real(32)?,

                    load:
                    self.read_real(34)?,

                    health:
                    self.read_real(36)?,

                    cooling:
                    self.read_real(38)?,

                    state_code:
                    self.read_real(42)? as i32,

                    running,
                });
            }

            std::thread::sleep(
                std::time::Duration::from_millis(2)
            );
        }

        Err("PLC telemetry timeout".into())
    }


    pub fn set_simulation_speed(
        &mut self,
        speed: i32,
        paused: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let speed = speed.clamp(1, 10000);

        // %MD22 -> registers 44-45
        self.write_real(
            44,
            speed as f32,
        )?;

        // %MX1.1 -> coil 9
        self.ctx.write_single_coil(
            9,
            paused,
        )??;

        Ok(())
    }

    pub fn read_simulated_minute(
        &mut self,
    ) -> Result<i64, Box<dyn std::error::Error>> {
        // %MD23 -> registers 46-47
        Ok(
            self.read_real(46)? as i64
        )
    }
}