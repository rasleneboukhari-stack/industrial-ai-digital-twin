#include "FailureModel.hpp"

#include <algorithm>
#include <random>


namespace
{
    // Reproducible random generator.
    // Same simulation run -> same sequence of failure profiles.
    std::mt19937& failureRng()
    {
        static std::mt19937 rng(424242);
        return rng;
    }
}


FailureModel::FailureModel(int machineId)
{
    // machineId is intentionally no longer used to decide
    // the failure profile.
    (void)machineId;

    bearingWear = 0.0;
    lubrication = 100.0;
    coolingEfficiency = 100.0;
    friction = 0.0;
    motorCondition = 100.0;


    // ---------------------------------------------------------
    // RANDOM FAILURE PROFILE FOR THIS LIFECYCLE
    // ---------------------------------------------------------

    std::uniform_int_distribution<int> profileDistribution(
        0,
        5
    );

    profile = static_cast<FailureProfile>(
        profileDistribution(failureRng())
    );


    // ---------------------------------------------------------
    // SMALL PHYSICAL VARIATION BETWEEN LIFECYCLES
    //
    // Two machines with the same failure profile should not
    // degrade in exactly the same way.
    // ---------------------------------------------------------

    std::uniform_real_distribution<double> variation(
        0.90,
        1.10
    );

    bearingVariation =
        variation(failureRng());

    lubricationVariation =
        variation(failureRng());

    coolingVariation =
        variation(failureRng());

    motorVariation =
        variation(failureRng());
}


void FailureModel::update(
    double load,
    double temperature,
    double rpm,
    bool stopped
)
{
    if (stopped)
        return;


    double loadRatio =
        load / 100.0;

    double rpmRatio =
        rpm / 4000.0;


    // ---------------------------------------------------------
    // FAILURE PROFILE MULTIPLIERS
    // ---------------------------------------------------------

    double bearingMultiplier = 1.0;
    double lubricationMultiplier = 1.0;
    double coolingMultiplier = 1.0;
    double motorMultiplier = 1.0;


    switch (profile)
    {
        case FailureProfile::HEALTHY:
            // Normal wear only
            break;

        case FailureProfile::BEARING:
            bearingMultiplier = 5.0;
            break;

        case FailureProfile::LUBRICATION:
            lubricationMultiplier = 5.0;
            break;

        case FailureProfile::COOLING:
            coolingMultiplier = 5.0;
            break;

        case FailureProfile::MOTOR:
            motorMultiplier = 5.0;
            break;

        case FailureProfile::MIXED:
            bearingMultiplier = 2.0;
            lubricationMultiplier = 2.0;
            coolingMultiplier = 2.0;
            motorMultiplier = 2.0;
            break;
    }


    // ---------------------------------------------------------
    // BEARING WEAR
    //
    // Higher load and RPM increase bearing degradation.
    // ---------------------------------------------------------

    double bearingRate =
        0.0002
        + 0.0008 * loadRatio
        + 0.0005 * rpmRatio;


    bearingWear +=
        bearingRate
        * bearingMultiplier
        * bearingVariation;


    // ---------------------------------------------------------
    // LUBRICATION DEGRADATION
    //
    // Load increases degradation.
    // High temperature accelerates lubricant breakdown.
    // ---------------------------------------------------------

    double lubricationLoss =
        0.0003
        + 0.0007 * loadRatio;


    if (temperature > 65.0)
    {
        lubricationLoss +=
            (temperature - 65.0)
            * 0.00003;
    }


    lubrication -=
        lubricationLoss
        * lubricationMultiplier
        * lubricationVariation;


    // ---------------------------------------------------------
    // COOLING SYSTEM DEGRADATION
    //
    // Cooling slowly degrades naturally.
    // High temperatures accelerate degradation.
    // ---------------------------------------------------------

    double coolingLoss =
        0.00005;


    if (temperature > 70.0)
    {
        coolingLoss +=
            (temperature - 70.0)
            * 0.00005;
    }


    coolingEfficiency -=
        coolingLoss
        * coolingMultiplier
        * coolingVariation;


    // ---------------------------------------------------------
    // FRICTION
    //
    // Friction is NOT an independent random failure.
    // It results from bearing wear and lubrication loss.
    // ---------------------------------------------------------

    double targetFriction =
        bearingWear * 0.35
        + (100.0 - lubrication) * 0.45;


    // Smooth response instead of instant jump
    friction +=
        (targetFriction - friction)
        * 0.02;


    // ---------------------------------------------------------
    // MOTOR CONDITION
    //
    // High load damages the motor faster.
    // Very high temperature accelerates motor degradation.
    // ---------------------------------------------------------

    double motorLoss =
        0.0002
        + 0.0005 * loadRatio;


    if (temperature > 80.0)
    {
        motorLoss +=
            (temperature - 80.0)
            * 0.00005;
    }


    motorCondition -=
        motorLoss
        * motorMultiplier
        * motorVariation;


    // ---------------------------------------------------------
    // LIMIT PHYSICAL STATE
    // ---------------------------------------------------------

    bearingWear =
        std::clamp(
            bearingWear,
            0.0,
            100.0
        );


    lubrication =
        std::clamp(
            lubrication,
            0.0,
            100.0
        );


    coolingEfficiency =
        std::clamp(
            coolingEfficiency,
            0.0,
            100.0
        );


    friction =
        std::clamp(
            friction,
            0.0,
            100.0
        );


    motorCondition =
        std::clamp(
            motorCondition,
            0.0,
            100.0
        );
}


double FailureModel::getBearingWear() const
{
    return bearingWear;
}


double FailureModel::getLubrication() const
{
    return lubrication;
}


double FailureModel::getCoolingEfficiency() const
{
    return coolingEfficiency;
}


double FailureModel::getFriction() const
{
    return friction;
}


double FailureModel::getMotorCondition() const
{
    return motorCondition;
}


double FailureModel::getHealth() const
{
    double health =
        100.0
        - bearingWear * 0.30
        - (100.0 - lubrication) * 0.15
        - (100.0 - coolingEfficiency) * 0.20
        - friction * 0.15
        - (100.0 - motorCondition) * 0.20;


    return std::clamp(
        health,
        0.0,
        100.0
    );
}


double FailureModel::getVibrationEffect() const
{
    return
        bearingWear * 0.01
        + friction * 0.008
        + (100.0 - lubrication) * 0.004;
}


double FailureModel::getCurrentEffect() const
{
    return
        friction * 0.03
        + (100.0 - motorCondition) * 0.02;
}


double FailureModel::getHeatEffect() const
{
    return
        friction * 0.01
        + (100.0 - coolingEfficiency) * 0.015;
}


FailureProfile FailureModel::getProfile() const
{
    return profile;
}


std::string FailureModel::getProfileName() const
{
    switch (profile)
    {
        case FailureProfile::HEALTHY:
            return "HEALTHY";

        case FailureProfile::BEARING:
            return "BEARING";

        case FailureProfile::LUBRICATION:
            return "LUBRICATION";

        case FailureProfile::COOLING:
            return "COOLING";

        case FailureProfile::MOTOR:
            return "MOTOR";

        case FailureProfile::MIXED:
            return "MIXED";
    }

    return "UNKNOWN";
}