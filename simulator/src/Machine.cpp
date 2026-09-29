#include "Machine.hpp"

#include <algorithm>
#include <sstream>
#include <iostream>

Machine::Machine(int machine_id)
    : failureModel(machine_id),
      rng(
          static_cast<unsigned int>(
              1000 + machine_id
          )
      ),
      processRng(
          static_cast<unsigned int>(
              2000 + machine_id
          )
      ),
      loadDisturbance(0.0)
{
    id = machine_id;

    temperature = 60.0;
    vibration = 0.2;
    rpm = 3000.0;
    load = 50.0;
    current = 3.0;

    loadSetpoint = 50.0;
    coolingSetpoint = 50.0;

    health = 100.0;
    stopped = false;

    state = MachineState::NORMAL;
}

int Machine::getID() const
{
    return id;
}

double Machine::getTemperature() const
{
    std::normal_distribution<double> noise(
        0.0,
        0.25
    );

    return temperature + noise(rng);
}

double Machine::getVibration() const
{
    std::normal_distribution<double> noise(
        0.0,
        0.005
    );

    return std::max(
        0.0,
        vibration + noise(rng)
    );
}

double Machine::getRPM() const
{
    std::normal_distribution<double> noise(
        0.0,
        5.0
    );

    return std::max(
        0.0,
        rpm + noise(rng)
    );
}

double Machine::getCurrent() const
{
    std::normal_distribution<double> noise(
        0.0,
        0.03
    );

    return std::max(
        0.0,
        current + noise(rng)
    );
}

double Machine::getLoad() const
{
    return load;
}


double Machine::getHealth() const
{
    return health;
}

bool Machine::isRunning() const
{
    return !stopped;
}

int Machine::getStateCode() const
{
    switch (state)
    {
        case MachineState::NORMAL:
            return 0;

        case MachineState::WARNING:
            return 1;

        case MachineState::DEGRADING:
            return 2;

        case MachineState::FAILURE:
            return 3;
    }

    return 0;
}

void Machine::updateState()
{
    if (health > 70.0) {
        state = MachineState::NORMAL;
    }
    else if (health > 40.0) {
        state = MachineState::WARNING;
    }
    else if (health > 10.0) {
        state = MachineState::DEGRADING;
    }
    else {
        state = MachineState::FAILURE;
    }
}

void Machine::update(double ambientTemperature)
{
    if (stopped)
    {
        load = 0.0;
        rpm = 0.0;
        current = 0.0;
        vibration = 0.02;

        double coolingEfficiency =
            failureModel.getCoolingEfficiency() / 100.0;

        double passiveCooling =
            (temperature - ambientTemperature) * 0.02;

        double activeCooling =
            coolingSetpoint * 0.002 * coolingEfficiency;

        temperature -=
            passiveCooling +
            activeCooling;

        if (temperature < ambientTemperature)
        {
            temperature = ambientTemperature;
        }

        health = failureModel.getHealth();

        updateState();
        return;
    }

    std::normal_distribution<double> processNoise(
        0.0,
        0.8
    );

    // Slowly changing process demand
    loadDisturbance =
        0.96 * loadDisturbance
        + processNoise(processRng);

    loadDisturbance =
        std::clamp(
            loadDisturbance,
            -10.0,
            10.0
        );

    double targetLoad =
        std::clamp(
            loadSetpoint + loadDisturbance,
            0.0,
            100.0
        );

    // Machine does not instantly jump to a new load
    load +=
        (targetLoad - load) * 0.15;
    double loadRatio =
        load / 100.0;

    double coolingRatio =
        coolingSetpoint / 100.0;

    double coolingEfficiency =
        failureModel.getCoolingEfficiency() / 100.0;

    rpm =
        800.0 +
        3000.0 * loadRatio;

    current =
        2.0 +
        12.0 * loadRatio;

    double heatGeneration =
        0.8 * loadRatio;

    double temperatureDifference =
        std::max(0.0, temperature - ambientTemperature);

    double passiveCooling =
        temperatureDifference * 0.01
        + temperatureDifference * temperatureDifference * 0.0001;

    double activeCooling =
        0.4 *
        coolingRatio *
        coolingEfficiency;

    temperature +=
        heatGeneration
        - passiveCooling
        - activeCooling;

    if (temperature < ambientTemperature)
    {
        temperature = ambientTemperature;
    }

    // Base mechanical vibration
    vibration =
        0.10 +
        0.004 * load;

    // Update hidden component degradation
    failureModel.update(
        load,
        temperature,
        rpm,
        stopped
    );

    // Degradation affects observable sensor values
    vibration +=
        failureModel.getVibrationEffect();

    current +=
        failureModel.getCurrentEffect();

    temperature +=
        failureModel.getHeatEffect();

    // Health is derived from hidden component condition
    health =
        failureModel.getHealth();

    static int debugCounter = 0;

    updateState();
}

void Machine::setLoad(double value)
{
    loadSetpoint = std::clamp(value, 0.0, 100.0);
}

void Machine::setCooling(double value)
{
    coolingSetpoint = std::clamp(value, 0.0, 100.0);
}

void Machine::reduceLoad(double value)
{
    loadSetpoint -= value;

    if (loadSetpoint < 0.0) {
        loadSetpoint = 0.0;
    }
}

void Machine::stop()
{
    stopped = true;

    load = 0.0;
    rpm = 0.0;
    current = 0.0;
}

void Machine::start()
{
    stopped = false;
}

void Machine::repair()
{
    temperature = 25.0;
    vibration = 0.0;
    rpm = 0.0;
    current = 0.0;

    health = 100.0;
    state = MachineState::NORMAL;

    stopped = false;

    loadSetpoint = 50.0;
    coolingSetpoint = 50.0;

    loadDisturbance = 0.0;   // add this

    // New failure cycle
    failureModel = FailureModel(id);
}


void Machine::simulateFailure()
{
    // Later:
    // bearing wear
    // lubrication
    // cooling degradation
    // friction
    // motor degradation
}

std::string Machine::toJSON()
{
    std::stringstream data;

    data << "{";
    data << "\"id\":" << id << ",";
    data << "\"temperature\":" << temperature << ",";
    data << "\"vibration\":" << vibration << ",";
    data << "\"rpm\":" << rpm << ",";
    data << "\"load\":" << load << ",";
    data << "\"current\":" << current << ",";
    data << "\"cooling\":" << coolingSetpoint << ",";
    data << "\"health\":" << health << ",";
    data << "\"running\":" << (stopped ? "false" : "true") << ",";
    data << "\"state\":\"" << stateToString(state) << "\"";
    data << "}";

    return data.str();
}

std::string stateToString(MachineState state)
{
    switch (state) {
        case MachineState::NORMAL:
            return "NORMAL";
        case MachineState::WARNING:
            return "WARNING";
        case MachineState::DEGRADING:
            return "DEGRADING";
        case MachineState::FAILURE:
            return "FAILURE";
    }

    return "UNKNOWN";
}
