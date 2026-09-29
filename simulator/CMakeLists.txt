cmake_minimum_required(VERSION 3.20)

project(industrial_simulator)

set(CMAKE_CXX_STANDARD 17)

include_directories(include)


find_package(PahoMqttCpp REQUIRED)
find_package(nlohmann_json REQUIRED)
find_library(MODBUS_LIBRARY modbus REQUIRED)

add_executable(
        industrial_simulator

        src/main.cpp
        src/Machine.cpp
        src/Sensor.cpp
        src/FailureModel.cpp
        src/Factory.cpp
        src/MQTTClient.cpp
        src/ModbusClient.cpp
        src/TelemetryBuffer.cpp
        src/MaintenanceManager.cpp
)


target_link_libraries(
        industrial_simulator
        nlohmann_json::nlohmann_json
        ${MODBUS_LIBRARY}

        paho-mqttpp3
        paho-mqtt3as
)