#include "Factory.hpp"

#include <iostream>

Factory::Factory()
{
    ambientTemperature = 25.0;
}

void Factory::addMachine(const Machine& machine)
{
    machines.push_back(machine);
}

void Factory::update()
{
    for (auto& machine : machines)
    {
        machine.update(ambientTemperature);
    }
}

void Factory::printStatus()
{
    for (auto& machine : machines)
    {
        std::cout << machine.toJSON() << std::endl;
    }
}

std::vector<Machine>& Factory::getMachines()
{
    return machines;
}

double Factory::getAmbientTemperature() const
{
    return ambientTemperature;
}

void Factory::setAmbientTemperature(double value)
{
    ambientTemperature = value;
}

void Factory::handleCommand(
    int machineID,
    const std::string& command,
    int value
)
{
    for (auto& machine : machines)
    {
        if (machine.getID() != machineID)
        {
            continue;
        }

        if (command == "SET_LOAD")
        {
            machine.setLoad(value);
        }
        else if (command == "REDUCE_LOAD")
        {
            machine.reduceLoad(value);
        }
        else if (command == "SET_COOLING")
        {
            machine.setCooling(value);
        }
        else if (command == "STOP")
        {
            machine.stop();
        }
        else if (command == "START")
        {
            machine.start();
        }
        else
        {
            std::cout
                << "Unknown command: "
                << command
                << std::endl;
        }

        return;
    }

    std::cout
        << "Machine "
        << machineID
        << " not found"
        << std::endl;
}