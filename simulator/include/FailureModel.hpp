#ifndef FAILURE_MODEL_HPP
#define FAILURE_MODEL_HPP
#include <string>

enum class FailureProfile
{
    HEALTHY,
    BEARING,
    LUBRICATION,
    COOLING,
    MOTOR,
    MIXED
};

class FailureModel
{
private:
    FailureProfile profile;

    double bearingWear;
    double lubrication;
    double coolingEfficiency;
    double friction;
    double motorCondition;
    double bearingVariation;
    double lubricationVariation;
    double coolingVariation;
    double motorVariation;

public:
    explicit FailureModel(int machineId);

    void update(
        double load,
        double temperature,
        double rpm,
        bool stopped
    );

    double getBearingWear() const;
    double getLubrication() const;
    double getCoolingEfficiency() const;
    double getFriction() const;
    double getMotorCondition() const;

    double getHealth() const;

    double getVibrationEffect() const;
    double getCurrentEffect() const;
    double getHeatEffect() const;

    FailureProfile getProfile() const;
    std::string getProfileName() const;
};

#endif