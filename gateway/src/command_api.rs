use serde::Deserialize;
use std::io::Read;
use std::sync::mpsc::Sender;
use std::thread;

use tiny_http::{
    Header,
    Method,
    Request,
    Response,
    Server,
    StatusCode,
};

#[derive(Debug)]
pub struct GatewayCommand {
    pub machine_id: i32,
    pub command: String,
    pub value: Option<i32>,
}

#[derive(Debug)]
pub struct SimulationControl {
    pub speed: i32,
    pub paused: bool,
}

#[derive(Deserialize)]
struct CommandBody {
    command: String,
    value: Option<i32>,
}

#[derive(Deserialize)]
struct SimulationBody {
    speed: i32,
    paused: bool,
}

#[derive(Deserialize)]
struct AutoRepairBody {
    enabled: bool,
}

fn header(
    name: &str,
    value: &str,
) -> Header {
    Header::from_bytes(
        name.as_bytes(),
        value.as_bytes(),
    )
        .unwrap()
}

fn respond(
    request: Request,
    status: u16,
    body: &str,
) {
    let response =
        Response::from_string(
            body.to_string()
        )
            .with_status_code(
                StatusCode(status)
            )
            .with_header(
                header(
                    "Content-Type",
                    "application/json",
                )
            )
            .with_header(
                header(
                    "Access-Control-Allow-Origin",
                    "*",
                )
            )
            .with_header(
                header(
                    "Access-Control-Allow-Headers",
                    "Content-Type",
                )
            )
            .with_header(
                header(
                    "Access-Control-Allow-Methods",
                    "POST, OPTIONS",
                )
            );

    let _ =
        request.respond(response);
}

pub fn start_command_api(
    sender: Sender<GatewayCommand>,
    simulation_sender: Sender<SimulationControl>,
) {
    thread::spawn(move || {
        let server =
            Server::http(
                "0.0.0.0:8081"
            )
                .expect(
                    "Failed to start command API"
                );

        println!(
            "Command API running on :8081"
        );

        for mut request in
            server.incoming_requests()
        {
            // ==========================================
            // CORS PREFLIGHT
            // ==========================================

            if request.method() ==
                &Method::Options
            {
                respond(
                    request,
                    204,
                    "",
                );

                continue;
            }

            if request.method() !=
                &Method::Post
            {
                respond(
                    request,
                    405,
                    r#"{"error":"Method not allowed"}"#,
                );

                continue;
            }

            let url =
                request.url().to_string();

            // ==========================================
            // SIMULATION SPEED
            // ==========================================

            if url ==
                "/api/simulation/speed"
            {
                let mut body =
                    String::new();

                if let Err(error) =
                    request
                        .as_reader()
                        .read_to_string(
                            &mut body
                        )
                {
                    respond(
                        request,
                        400,
                        &format!(
                            r#"{{"error":"{}"}}"#,
                            error
                        ),
                    );

                    continue;
                }

                let control =
                    match serde_json::from_str::<
                        SimulationBody
                    >(&body)
                    {
                        Ok(control) =>
                            control,

                        Err(error) => {
                            respond(
                                request,
                                400,
                                &format!(
                                    r#"{{"error":"{}"}}"#,
                                    error
                                ),
                            );

                            continue;
                        }
                    };

                let allowed =
                    [
                        1,
                        10,
                        60,
                        600,
                        10000,
                    ];

                if
                !control.paused &&
                    !allowed.contains(
                        &control.speed
                    )
                {
                    respond(
                        request,
                        400,
                        r#"{"error":"Unsupported simulation speed"}"#,
                    );

                    continue;
                }

                if let Err(error) =
                    simulation_sender.send(
                        SimulationControl {
                            speed:
                            control.speed,
                            paused:
                            control.paused,
                        }
                    )
                {
                    respond(
                        request,
                        500,
                        &format!(
                            r#"{{"error":"{}"}}"#,
                            error
                        ),
                    );

                    continue;
                }

                respond(
                    request,
                    200,
                    r#"{"accepted":true}"#,
                );

                continue;
            }

            // ==========================================
            // AUTO REPAIR
            // ==========================================

            if url ==
                "/api/simulation/auto-repair"
            {
                let mut body =
                    String::new();

                if let Err(error) =
                    request
                        .as_reader()
                        .read_to_string(
                            &mut body
                        )
                {
                    respond(
                        request,
                        400,
                        &format!(
                            r#"{{"error":"{}"}}"#,
                            error
                        ),
                    );

                    continue;
                }

                let control =
                    match serde_json::from_str::<
                        AutoRepairBody
                    >(&body)
                    {
                        Ok(control) =>
                            control,

                        Err(error) => {
                            respond(
                                request,
                                400,
                                &format!(
                                    r#"{{"error":"{}"}}"#,
                                    error
                                ),
                            );

                            continue;
                        }
                    };

                // Reuse the existing PLC command mailbox.
                //
                // Command 6 is a GLOBAL PLC command:
                // SET_AUTO_REPAIR
                //
                // machine_id = 1 is ignored by the PLC
                // for command 6.
                let command =
                    GatewayCommand {
                        machine_id: 1,
                        command:
                        "SET_AUTO_REPAIR"
                            .to_string(),
                        value:
                        Some(
                            if control.enabled {
                                1
                            } else {
                                0
                            }
                        ),
                    };

                if let Err(error) =
                    sender.send(command)
                {
                    respond(
                        request,
                        500,
                        &format!(
                            r#"{{"error":"{}"}}"#,
                            error
                        ),
                    );

                    continue;
                }

                let response =
                    if control.enabled {
                        r#"{"accepted":true,"enabled":true}"#
                    } else {
                        r#"{"accepted":true,"enabled":false}"#
                    };

                respond(
                    request,
                    200,
                    response,
                );

                continue;
            }

            // ==========================================
            // MACHINE COMMANDS
            // POST /api/machines/{id}/commands
            // ==========================================

            let parts:
                Vec<&str> =
                url
                    .trim_matches('/')
                    .split('/')
                    .collect();

            if
            parts.len() != 4 ||
                parts[0] != "api" ||
                parts[1] != "machines" ||
                parts[3] != "commands"
            {
                respond(
                    request,
                    404,
                    r#"{"error":"Not found"}"#,
                );

                continue;
            }

            let machine_id =
                match parts[2]
                    .parse::<i32>()
                {
                    Ok(id)
                    if id > 0 =>
                        {
                            id
                        }

                    _ => {
                        respond(
                            request,
                            400,
                            r#"{"error":"Invalid machine id"}"#,
                        );

                        continue;
                    }
                };

            let mut body =
                String::new();

            if let Err(error) =
                request
                    .as_reader()
                    .read_to_string(
                        &mut body
                    )
            {
                respond(
                    request,
                    400,
                    &format!(
                        r#"{{"error":"{}"}}"#,
                        error
                    ),
                );

                continue;
            }

            let body =
                match serde_json::from_str::<
                    CommandBody
                >(&body)
                {
                    Ok(body) =>
                        body,

                    Err(error) => {
                        respond(
                            request,
                            400,
                            &format!(
                                r#"{{"error":"{}"}}"#,
                                error
                            ),
                        );

                        continue;
                    }
                };

            let command =
                GatewayCommand {
                    machine_id,
                    command:
                    body.command
                        .to_uppercase(),
                    value:
                    body.value,
                };

            if let Err(error) =
                sender.send(command)
            {
                respond(
                    request,
                    500,
                    &format!(
                        r#"{{"error":"{}"}}"#,
                        error
                    ),
                );

                continue;
            }

            respond(
                request,
                200,
                r#"{"accepted":true,"message":"Command queued"}"#,
            );
        }
    });
}