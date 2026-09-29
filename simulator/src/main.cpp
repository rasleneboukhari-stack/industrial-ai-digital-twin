#include <iostream>
#include <thread>
#include <chrono>
#include <array>
#include <algorithm>
#include <cstdlib>
#include <random>
#include <string>

#include "Factory.hpp"
#include "Machine.hpp"
#include "ModbusClient.hpp"
#include "MQTTClient.hpp"
#include "TelemetryBuffer.hpp"
#include "MaintenanceManager.hpp"

namespace
{
    constexpr long long TRAINING_LOAD_BLOCK_MINUTES = 7 * 24 * 60;
    constexpr std::array<int, 5> TRAINING_LOAD_LEVELS = {30, 45, 60, 75, 90};

    int trainingLoadFor(int machineId, long long simulatedMinute)
    {
        const auto block = simulatedMinute / TRAINING_LOAD_BLOCK_MINUTES;
        const auto levelIndex =
            (block + 2 * (machineId - 1)) % TRAINING_LOAD_LEVELS.size();
        return TRAINING_LOAD_LEVELS[levelIndex];
    }
}

int main()
{
    // =====================================================
    // FACTORY
    // =====================================================

    Factory factory;

    // =====================================================
    // TRAINING DATA MQTT
    // =====================================================

    MQTTClient trainingMqtt(
        "tcp://localhost:1883",
        "training_data_generator"
    );

    trainingMqtt.connect();

    // =====================================================
    // PLC / MODBUS
    // =====================================================

    ModbusClient plc(
        "127.0.0.1",
        1502
    );

    plc.connect();

    // =====================================================
    // CONFIGURATION
    // =====================================================

    constexpr int NUM_MACHINES = 20;
    constexpr int MAX_PLC_MACHINES = 128;

    constexpr int AI_SAMPLE_INTERVAL = 10;
    constexpr std::size_t BATCH_SIZE = 2000;

    // 2 simulated hours.
    constexpr long long REPAIR_DURATION_MINUTES =
        120;

    const char* trainingLoadSetting =
        std::getenv("SIM_TRAINING_LOAD_SWEEP");
    const bool trainingLoadSweep =
        trainingLoadSetting != nullptr &&
        std::string(trainingLoadSetting) == "1";

    const char* demoStaggerSetting =
        std::getenv("SIM_DEMO_STAGGER");
    const bool demoStagger =
        !trainingLoadSweep &&
        (demoStaggerSetting == nullptr ||
         std::string(demoStaggerSetting) != "0");

    std::array<double, NUM_MACHINES> demoHealthTargets = {
        98, 96, 94, 92, 90, 88, 86, 84, 82, 80,
        78, 76, 74, 72, 70, 68, 66, 62, 55, 50
    };

    if (demoStagger)
    {
        const char* seedSetting = std::getenv("SIM_DEMO_SEED");
        const unsigned int demoSeed = seedSetting != nullptr
            ? static_cast<unsigned int>(std::strtoul(seedSetting, nullptr, 10))
            : std::random_device{}();
        std::mt19937 demoRng(demoSeed);
        std::shuffle(demoHealthTargets.begin(), demoHealthTargets.end(), demoRng);
        std::cout << "Demo wear seed: " << demoSeed << std::endl;
    }

    // =====================================================
    // TRAINING BUFFER
    // =====================================================

    TelemetryBuffer trainingBuffer(
        AI_SAMPLE_INTERVAL,
        BATCH_SIZE
    );

    // =====================================================
    // MAINTENANCE
    // =====================================================

    MaintenanceManager maintenance(
        REPAIR_DURATION_MINUTES
    );

    // =====================================================
    // CREATE MACHINES
    // =====================================================

    for (
        int id = 1;
        id <= NUM_MACHINES;
        ++id
    )
    {
        Machine machine(id);

        if (demoStagger)
        {
            // Each update is one minute of the same physical wear model used
            // during normal simulation. This history predates monitoring, so
            // it is never published as training or live inference telemetry.
            int priorMinutes = 0;
            while (machine.getHealth() > demoHealthTargets[id - 1] &&
                   machine.getStateCode() != 3 &&
                   priorMinutes < 140000)
            {
                machine.update(25.0);
                ++priorMinutes;
            }
            std::cout << "M" << id << " starts at health "
                      << machine.getHealth() << "% after "
                      << priorMinutes << " prior minutes" << std::endl;
        }

        factory.addMachine(machine);
    }

    std::cout
        << "Industrial Factory Simulator running..."
        << std::endl;

    if (trainingLoadSweep)
    {
        std::cout
            << "Training load sweep enabled: 30/45/60/75/90% "
            << "in seven-day simulated blocks"
            << std::endl;
    }

    bool requestToggle = false;
    long long simulatedMinute = 0;

    bool previousAutoRepair = false;

    // =====================================================
    // MAIN LOOP
    // =====================================================

    while (true)
    {
        // =================================================
        // C++ -> PLC TELEMETRY
        // PLC -> C++ CONTROL
        // =================================================

        for (
            auto& machine :
            factory.getMachines()
        )
        {
            int index =
                machine.getID() - 1;

            if (
                index < 0 ||
                index >= MAX_PLC_MACHINES
            )
            {
                continue;
            }

            // -------------------------
            // C++ -> PLC TELEMETRY
            // -------------------------

            // %MD0
            plc.writeReal(
                0,
                machine.getTemperature()
            );

            // %MD1
            plc.writeReal(
                2,
                machine.getVibration()
            );

            // %MD2
            plc.writeReal(
                4,
                machine.getRPM()
            );

            // %MD3
            plc.writeReal(
                6,
                machine.getCurrent()
            );

            // %MD10
            plc.writeReal(
                20,
                machine.getLoad()
            );

            // %MD11
            plc.writeReal(
                22,
                machine.getHealth()
            );

            // %MX0.5
            plc.writeBool(
                5,
                machine.isRunning()
            );

            // %MD20
            plc.writeReal(
                40,
                static_cast<float>(
                    machine.getStateCode()
                )
            );

            // %MD6
            plc.writeReal(
                12,
                static_cast<float>(
                    index
                )
            );

            // -------------------------
            // REQUEST PLC PROCESSING
            // -------------------------

            requestToggle =
                !requestToggle;

            // %MX0.1
            plc.writeBool(
                1,
                requestToggle
            );

            bool answered = false;

            for (
                int retry = 0;
                retry < 50;
                ++retry
            )
            {
                // %MX0.2
                if (
                    plc.readBool(2) ==
                    requestToggle
                )
                {
                    answered = true;
                    break;
                }

                std::this_thread::sleep_for(
                    std::chrono::milliseconds(2)
                );
            }

            if (!answered)
            {
                std::cerr
                    << "PLC timeout for machine "
                    << machine.getID()
                    << std::endl;

                continue;
            }

            // -------------------------
            // PLC -> C++ CONTROL
            // -------------------------

            // %MD4
            float loadSetpoint =
                plc.readReal(8);

            // %MD5
            float coolingSetpoint =
                plc.readReal(10);

            // %MX0.0
            bool motorEnabled =
                plc.readBool(0);

            // -------------------------
            // MOTOR CONTROL
            // -------------------------

            if (motorEnabled)
            {
                factory.handleCommand(
                    machine.getID(),
                    "START",
                    0
                );
            }
            else
            {
                factory.handleCommand(
                    machine.getID(),
                    "STOP",
                    0
                );
            }

            // -------------------------
            // LOAD CONTROL
            // -------------------------

            factory.handleCommand(
                machine.getID(),
                "SET_LOAD",
                static_cast<int>(
                    loadSetpoint
                )
            );

            // -------------------------
            // COOLING CONTROL
            // -------------------------

            factory.handleCommand(
                machine.getID(),
                "SET_COOLING",
                static_cast<int>(
                    coolingSetpoint
                )
            );
        }

        // =================================================
        // SIMULATION CONTROL
        // =================================================

        // %MD22
        float rawSpeed =
            plc.readReal(44);

        // %MX1.1 = coil 9
        bool paused =
            plc.readBool(9);

        // %MX1.2 = coil 10
        bool autoRepairEnabled =
            plc.readBool(10);

        int simulationSpeed =
            static_cast<int>(
                rawSpeed
            );

        if (simulationSpeed < 1)
        {
            simulationSpeed = 1;
        }

        if (simulationSpeed > 10000)
        {
            simulationSpeed = 10000;
        }

        // Only print when setting changes.
        if (
            autoRepairEnabled !=
            previousAutoRepair
        )
        {
            std::cout
                << "Automatic repair: "
                << (
                    autoRepairEnabled
                        ? "ON"
                        : "OFF"
                )
                << std::endl;

            previousAutoRepair =
                autoRepairEnabled;
        }

        // =================================================
        // PHYSICAL SIMULATION
        // =================================================

        if (!paused)
        {
            for (
                int step = 0;
                step < simulationSpeed;
                ++step
            )
            {
                if (trainingLoadSweep)
                {
                    for (auto& machine : factory.getMachines())
                    {
                        machine.setLoad(trainingLoadFor(
                            machine.getID(), simulatedMinute + 1
                        ));
                    }
                }

                // One update = one simulated minute.
                factory.update();

                ++simulatedMinute;

                // -----------------------------------------
                // TRAINING SAMPLE
                // -----------------------------------------

                // Record state BEFORE possible repair.
                // This means FAILURE remains visible
                // inside the training dataset.
                std::string liveTrainingSamples =
                    trainingBuffer.sample(
                        simulatedMinute,
                        factory.getMachines()
                    );

                if (!liveTrainingSamples.empty())
                {
                    trainingMqtt.publish(
                        "factory/training/live",
                        liveTrainingSamples
                    );
                }

                // -----------------------------------------
                // EXISTING MAINTENANCE JOBS
                // -----------------------------------------

                // Teams already dispatched keep working
                // even if auto-repair is switched OFF later.
                maintenance.update(
                    factory.getMachines(),
                    simulatedMinute
                );

                // -----------------------------------------
                // AUTOMATIC MAINTENANCE REQUEST
                // -----------------------------------------

                if (autoRepairEnabled)
                {
                    for (
                        auto& machine :
                        factory.getMachines()
                    )
                    {
                        // IMPORTANT:
                        // state 3 = actual FAILURE.
                        //
                        // A manually STOPPED machine
                        // does NOT trigger this.
                        if (
                            machine.getStateCode() ==
                            3
                        )
                        {
                            maintenance.requestRepair(
                                machine,
                                simulatedMinute
                            );
                        }
                    }
                }

                // -----------------------------------------
                // FLUSH TRAINING BATCH
                // -----------------------------------------

                if (
                    trainingBuffer.shouldFlush()
                )
                {
                    std::string payload =
                        trainingBuffer.flush();

                    trainingMqtt.publish(
                        "factory/training/batch",
                        payload
                    );
                }
            }
        }

        // =================================================
        // SIMULATION CLOCK -> PLC
        // =================================================

        // %MD23
        plc.writeReal(
            46,
            static_cast<float>(
                simulatedMinute
            )
        );

        // =================================================
        // REAL-TIME OUTER LOOP
        // =================================================

        std::this_thread::sleep_for(
            std::chrono::seconds(1)
        );
    }

    return 0;
}
