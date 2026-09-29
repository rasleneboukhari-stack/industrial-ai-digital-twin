#ifndef MAINTENANCE_MANAGER_HPP
#define MAINTENANCE_MANAGER_HPP

#include <unordered_map>
#include <vector>

#include "Machine.hpp"

class MaintenanceManager
{
private:
    long long repairDurationMinutes;

    // machine_id -> simulated minute when repair finishes
    std::unordered_map<int, long long> activeRepairs;

public:
    explicit MaintenanceManager(
        long long repairDurationMinutes
    );

    void requestRepair(
        const Machine& machine,
        long long simulatedMinute
    );

    void update(
        std::vector<Machine>& machines,
        long long simulatedMinute
    );

    bool hasActiveRepair(
        int machineId
    ) const;
};

#endif