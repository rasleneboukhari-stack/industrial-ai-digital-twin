#pragma once

#include <cstddef>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "Machine.hpp"

class TelemetryBuffer
{
public:
    TelemetryBuffer(
        int sampleInterval,
        std::size_t batchSize
    );

    std::string sample(
        long long simulatedMinute,
        const std::vector<Machine>& machines
    );

    bool shouldFlush() const;

    std::string flush();

private:
    int sampleInterval;
    std::size_t batchSize;

    nlohmann::json buffer;
};
