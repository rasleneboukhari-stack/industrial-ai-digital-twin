#include "MaintenanceManager.hpp"

#include <iostream>
#include <algorithm>

MaintenanceManager::MaintenanceManager(
    long long repairDurationMinutes
)
    : repairDurationMinutes(
        std::max(
            1LL,
            repairDurationMinutes
        )
    )
{
}

void MaintenanceManager::requestRepair(
    const Machine& machine,
    long long simulatedMinute
)
{
    // Only a REAL machine failure gets repaired.
    // Manual STOP does not count.
    if (machine.getStateCode() != 3)
    {
        return;
    }

    int machineId =
        machine.getID();

    // Team already dispatched.
    if (
        activeRepairs.find(machineId) !=
        activeRepairs.end()
    )
    {
        return;
    }

    long long finishMinute =
        simulatedMinute +
        repairDurationMinutes;

    activeRepairs[machineId] =
        finishMinute;

    std::cout
        << "Maintenance team dispatched to M"
        << machineId
        << " at simulated minute "
        << simulatedMinute
        << " | expected completion: "
        << finishMinute
        << std::endl;
}

void MaintenanceManager::update(
    std::vector<Machine>& machines,
    long long simulatedMinute
)
{
    std::vector<int> completed;

    for (
        const auto& repair :
        activeRepairs
    )
    {
        int machineId =
            repair.first;

        long long finishMinute =
            repair.second;

        if (
            simulatedMinute <
            finishMinute
        )
        {
            continue;
        }

        for (auto& machine : machines)
        {
            if (
                machine.getID() !=
                machineId
            )
            {
                continue;
            }

            // Only repair if it is still actually faulty.
            if (
                machine.getStateCode() ==
                3
            )
            {
                machine.repair();

                std::cout
                    << "Maintenance completed on M"
                    << machineId
                    << " at simulated minute "
                    << simulatedMinute
                    << std::endl;
            }

            break;
        }

        completed.push_back(
            machineId
        );
    }

    for (int machineId : completed)
    {
        activeRepairs.erase(
            machineId
        );
    }
}

bool MaintenanceManager::hasActiveRepair(
    int machineId
) const
{
    return
        activeRepairs.find(machineId) !=
        activeRepairs.end();
}