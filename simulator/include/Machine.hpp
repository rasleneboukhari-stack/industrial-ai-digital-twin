#ifndef MACHINE_HPP
#define MACHINE_HPP
#include <random>
#include "FailureModel.hpp"
#include <string>

enum class MachineState
{
    NORMAL,
    WARNING,
    DEGRADING,
    FAILURE
};

class Machine
{
private:
    int id;

    double temperature;
    double vibration;
    double rpm;
    double load;
    double current;

    double loadSetpoint;
    double coolingSetpoint;

    double health;
    bool stopped;
    mutable std::mt19937 rng;
    std::mt19937 processRng;
    double loadDisturbance;

    MachineState state;
    FailureModel failureModel;

public:
    explicit Machine(int machine_id);

    void update(double ambientTemperature);
    void updateState();
    void simulateFailure();

    std::string toJSON();

    // GETTERS
    int getID() const;
    double getTemperature() const;
    double getVibration() const;
    double getRPM() const;
    double getLoad() const;
    double getCurrent() const;
    double getHealth() const;

    bool isRunning() const;
    int getStateCode() const;

    MachineState getState();

    // CONTROL
    void setLoad(double value);
    void setCooling(double value);
    void reduceLoad(double value);
    void repair();
    void stop();
    void start();
};

std::string stateToString(MachineState state);

#endif