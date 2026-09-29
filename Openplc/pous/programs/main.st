PROGRAM main
  VAR
    TemperatureIn : REAL AT %MD0;
    VibrationIn : REAL AT %MD1;
    RPMIn : REAL AT %MD2;
    CurrentIn : REAL AT %MD3;
    LoadSetpointOut : REAL AT %MD4;
    CoolingSetpointOut : REAL AT %MD5;
    MachineIndexIn : REAL AT %MD6;
    MotorEnabledOut : BOOL AT %MX0.0;
    RequestToggle : BOOL AT %MX0.1;
    ResponseToggle : BOOL AT %MX0.2;
    CommandMachineIndex : REAL AT %MD7;
    CommandCode : REAL AT %MD8;
    CommandValue : REAL AT %MD9;
    CommandRequestToggle : BOOL AT %MX0.3;
    CommandResponseToggle : BOOL AT %MX0.4;
    ActualLoadIn : REAL AT %MD10;
    HealthIn : REAL AT %MD11;
    RunningIn : BOOL AT %MX0.5;
    TelemetryMachineIndex : REAL AT %MD12;
    TelemetryTemperatureOut : REAL AT %MD13;
    TelemetryVibrationOut : REAL AT %MD14;
    TelemetryRPMOut : REAL AT %MD15;
    TelemetryCurrentOut : REAL AT %MD16;
    TelemetryLoadOut : REAL AT %MD17;
    TelemetryHealthOut : REAL AT %MD18;
    TelemetryCoolingOut : REAL AT %MD19;
    StateCodeIn : REAL AT %MD20;
    TelemetryStateCodeOut : REAL AT %MD21;
    TelemetryRunningOut : BOOL AT %MX0.6;
    TelemetryRequestToggle : BOOL AT %MX0.7;
    TelemetryResponseToggle : BOOL AT %MX1.0;
    SimulationSpeedIn : REAL AT %MD22;
    SimulationMinuteIn : REAL AT %MD23;
    SimulationPausedIn : BOOL AT %MX1.1;
    AutomaticRepairEnabled : BOOL AT %MX1.2;
    MachineLoadSetpoint : ARRAY[0..127] OF REAL;
    MachineCoolingSetpoint : ARRAY[0..127] OF REAL;
    MachineMotorEnabled : ARRAY[0..127] OF BOOL;
    MachineInitialized : ARRAY[0..127] OF BOOL;
    MachineTemperature : ARRAY[0..127] OF REAL;
    MachineVibration : ARRAY[0..127] OF REAL;
    MachineRPM : ARRAY[0..127] OF REAL;
    MachineCurrent : ARRAY[0..127] OF REAL;
    MachineActualLoad : ARRAY[0..127] OF REAL;
    MachineHealth : ARRAY[0..127] OF REAL;
    MachineRunning : ARRAY[0..127] OF BOOL;
    MachineStateCode : ARRAY[0..127] OF REAL;
    idx : INT;
    ActiveMachines : INT := 128;
  END_VAR

(* ========================================================= *)
(* RUST -> PLC COMMAND MAILBOX                               *)
(* ========================================================= *)

IF CommandRequestToggle <> CommandResponseToggle THEN

    (* ===================================================== *)
    (* GLOBAL COMMAND 6 = SET AUTO REPAIR                    *)
    (* ===================================================== *)

    IF REAL_TO_INT(CommandCode) = 6 THEN

        IF CommandValue >= 0.5 THEN
            AutomaticRepairEnabled := TRUE;
        ELSE
            AutomaticRepairEnabled := FALSE;
        END_IF;

    ELSE

        (* ================================================= *)
        (* NORMAL MACHINE COMMAND                            *)
        (* ================================================= *)

        idx := REAL_TO_INT(CommandMachineIndex);

        IF idx >= 0 AND idx < ActiveMachines THEN

            (* --------------------------------------------- *)
            (* INITIALIZE MACHINE PLC STATE                  *)
            (* --------------------------------------------- *)

            IF NOT MachineInitialized[idx] THEN

                MachineLoadSetpoint[idx] := 50.0;

                MachineCoolingSetpoint[idx] := 50.0;

                MachineMotorEnabled[idx] := TRUE;

                MachineInitialized[idx] := TRUE;

            END_IF;


            (* --------------------------------------------- *)
            (* MACHINE COMMANDS                              *)
            (* --------------------------------------------- *)

            CASE REAL_TO_INT(CommandCode) OF

                (* START *)
                1:
                    MachineMotorEnabled[idx] := TRUE;

                (* STOP *)
                2:
                    MachineMotorEnabled[idx] := FALSE;

                (* SET LOAD *)
                3:
                    MachineLoadSetpoint[idx] := CommandValue;

                (* REDUCE LOAD *)
                4:
                    MachineLoadSetpoint[idx] :=
                        MachineLoadSetpoint[idx] -
                        CommandValue;

                (* SET COOLING *)
                5:
                    MachineCoolingSetpoint[idx] := CommandValue;

            END_CASE;


            (* --------------------------------------------- *)
            (* CLAMP LOAD                                    *)
            (* --------------------------------------------- *)

            IF MachineLoadSetpoint[idx] < 0.0 THEN

                MachineLoadSetpoint[idx] := 0.0;

            ELSIF MachineLoadSetpoint[idx] > 100.0 THEN

                MachineLoadSetpoint[idx] := 100.0;

            END_IF;


            (* --------------------------------------------- *)
            (* CLAMP COOLING                                 *)
            (* --------------------------------------------- *)

            IF MachineCoolingSetpoint[idx] < 0.0 THEN

                MachineCoolingSetpoint[idx] := 0.0;

            ELSIF MachineCoolingSetpoint[idx] > 100.0 THEN

                MachineCoolingSetpoint[idx] := 100.0;

            END_IF;

        END_IF;

    END_IF;


    (* ACKNOWLEDGE RUST COMMAND *)

    CommandResponseToggle :=
        CommandRequestToggle;

END_IF;



(* ========================================================= *)
(* C++ -> PLC SENSOR DATA                                    *)
(* PLC -> C++ ACTUATOR COMMANDS                              *)
(* ========================================================= *)

IF RequestToggle <> ResponseToggle THEN

    idx := REAL_TO_INT(MachineIndexIn);


    IF idx >= 0 AND idx < ActiveMachines THEN

        (* ================================================= *)
        (* INITIALIZE MACHINE                                *)
        (* ================================================= *)

        IF NOT MachineInitialized[idx] THEN

            MachineLoadSetpoint[idx] := 50.0;

            MachineCoolingSetpoint[idx] := 50.0;

            MachineMotorEnabled[idx] := TRUE;

            MachineInitialized[idx] := TRUE;

        END_IF;


        (* ================================================= *)
        (* STORE PHYSICAL TELEMETRY FROM C++                 *)
        (* ================================================= *)

        MachineTemperature[idx] :=
            TemperatureIn;

        MachineVibration[idx] :=
            VibrationIn;

        MachineRPM[idx] :=
            RPMIn;

        MachineCurrent[idx] :=
            CurrentIn;

        MachineActualLoad[idx] :=
            ActualLoadIn;

        MachineHealth[idx] :=
            HealthIn;

        MachineRunning[idx] :=
            RunningIn;

        MachineStateCode[idx] :=
            StateCodeIn;


        (* ================================================= *)
        (* SAFETY CLAMP LOAD                                 *)
        (* ================================================= *)

        IF MachineLoadSetpoint[idx] < 0.0 THEN

            MachineLoadSetpoint[idx] := 0.0;

        ELSIF MachineLoadSetpoint[idx] > 100.0 THEN

            MachineLoadSetpoint[idx] := 100.0;

        END_IF;


        (* ================================================= *)
        (* SAFETY CLAMP COOLING                              *)
        (* ================================================= *)

        IF MachineCoolingSetpoint[idx] < 0.0 THEN

            MachineCoolingSetpoint[idx] := 0.0;

        ELSIF MachineCoolingSetpoint[idx] > 100.0 THEN

            MachineCoolingSetpoint[idx] := 100.0;

        END_IF;


        (* ================================================= *)
        (* PLC -> C++ CONTROL OUTPUTS                        *)
        (* ================================================= *)

        LoadSetpointOut :=
            MachineLoadSetpoint[idx];

        CoolingSetpointOut :=
            MachineCoolingSetpoint[idx];

        MotorEnabledOut :=
            MachineMotorEnabled[idx];


    ELSE

        (* INVALID MACHINE INDEX *)

        LoadSetpointOut := 0.0;

        CoolingSetpointOut := 0.0;

        MotorEnabledOut := FALSE;

    END_IF;


    (* ACKNOWLEDGE C++ REQUEST *)

    ResponseToggle :=
        RequestToggle;

END_IF;



(* ========================================================= *)
(* PLC -> RUST TELEMETRY MAILBOX                             *)
(* ========================================================= *)

IF TelemetryRequestToggle <> TelemetryResponseToggle THEN

    idx := REAL_TO_INT(TelemetryMachineIndex);


    IF idx >= 0 AND idx < ActiveMachines THEN

        (* ================================================= *)
        (* RETURN SELECTED MACHINE STATE TO RUST             *)
        (* ================================================= *)

        TelemetryTemperatureOut :=
            MachineTemperature[idx];

        TelemetryVibrationOut :=
            MachineVibration[idx];

        TelemetryRPMOut :=
            MachineRPM[idx];

        TelemetryCurrentOut :=
            MachineCurrent[idx];

        TelemetryLoadOut :=
            MachineActualLoad[idx];

        TelemetryHealthOut :=
            MachineHealth[idx];

        TelemetryCoolingOut :=
            MachineCoolingSetpoint[idx];

        TelemetryRunningOut :=
            MachineRunning[idx];

        TelemetryStateCodeOut :=
            MachineStateCode[idx];


    ELSE

        (* INVALID MACHINE INDEX *)

        TelemetryTemperatureOut := 0.0;

        TelemetryVibrationOut := 0.0;

        TelemetryRPMOut := 0.0;

        TelemetryCurrentOut := 0.0;

        TelemetryLoadOut := 0.0;

        TelemetryHealthOut := 0.0;

        TelemetryCoolingOut := 0.0;

        TelemetryRunningOut := FALSE;

        TelemetryStateCodeOut := 0.0;

    END_IF;


    (* ACKNOWLEDGE RUST TELEMETRY REQUEST *)

    TelemetryResponseToggle :=
        TelemetryRequestToggle;

END_IF;

END_PROGRAM