#pragma once

#include <modbus/modbus.h>
#include <string>

class ModbusClient
{
private:
    modbus_t* context;

public:
    ModbusClient(
        const std::string& ip,
        int port
    );

    ~ModbusClient();

    void connect();
    void writeReal(int address, float value);
    float readReal(int address);

    void writeBool(int address, bool value);
    bool readBool(int address);
};