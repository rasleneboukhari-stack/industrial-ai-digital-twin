#ifndef FACTORY_HPP
#define FACTORY_HPP

#include <string>
#include <vector>

#include "Machine.hpp"

class Factory
{
private:
    std::vector<Machine> machines;

    double ambientTemperature;

public:
    Factory();

    void addMachine(const Machine& machine);

    void update();
    void printStatus();

    std::vector<Machine>& getMachines();

    double getAmbientTemperature() const;
    void setAmbientTemperature(double value);

    void handleCommand(
        int machineID,
        const std::string& command,
        int value
    );
};

#endif