#include "TelemetryBuffer.hpp"

TelemetryBuffer::TelemetryBuffer(
    int sampleInterval,
    std::size_t batchSize
)
    : sampleInterval(
        sampleInterval > 0
            ? sampleInterval
            : 1
    ),
      batchSize(
        batchSize > 0
            ? batchSize
            : 1
    ),
      buffer(
        nlohmann::json::array()
    )
{
}

std::string TelemetryBuffer::sample(
    long long simulatedMinute,
    const std::vector<Machine>& machines
)
{
    // Only capture at the configured
    // simulated-time interval.
    if (
        simulatedMinute %
        sampleInterval != 0
    )
    {
        return "";
    }

    nlohmann::json liveSamples =
        nlohmann::json::array();

    for (const auto& machine : machines)
    {
        nlohmann::json sample = {
            {
                "simulated_minute",
                simulatedMinute
            },
            {
                "machine_id",
                machine.getID()
            },
            {
                "temperature",
                machine.getTemperature()
            },
            {
                "vibration",
                machine.getVibration()
            },
            {
                "rpm",
                machine.getRPM()
            },
            {
                "load",
                machine.getLoad()
            },
            {
                "current",
                machine.getCurrent()
            },
            {
                "health",
                machine.getHealth()
            },
            {
                "running",
                machine.isRunning()
            },
            {
                "state_code",
                machine.getStateCode()
            }
        };

        buffer.push_back(sample);
        liveSamples.push_back(std::move(sample));
    }

    return liveSamples.dump();
}

bool TelemetryBuffer::shouldFlush() const
{
    return buffer.size() >= batchSize;
}

std::string TelemetryBuffer::flush()
{
    if (buffer.empty())
    {
        return "[]";
    }

    std::string payload =
        buffer.dump();

    buffer =
        nlohmann::json::array();

    return payload;
}
