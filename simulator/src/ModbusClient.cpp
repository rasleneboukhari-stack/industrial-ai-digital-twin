#include "ModbusClient.hpp"

#include <iostream>
#include <stdexcept>
#include <cstring>
#include <cstdint>

ModbusClient::ModbusClient(
    const std::string& ip,
    int port
)
{
    context = modbus_new_tcp(
        ip.c_str(),
        port
    );

    if (context == nullptr) {
        throw std::runtime_error(
            "Failed to create Modbus context"
        );
    }

    modbus_set_slave(context, 1);
}

ModbusClient::~ModbusClient()
{
    if (context != nullptr) {
        modbus_close(context);
        modbus_free(context);
    }
}

void ModbusClient::connect()
{
    if (modbus_connect(context) == -1) {
        throw std::runtime_error(
            modbus_strerror(errno)
        );
    }

    std::cout << "Modbus connected to PLC" << std::endl;
}

void ModbusClient::writeReal(int address, float value)
{
    uint32_t bits;

    std::memcpy(
        &bits,
        &value,
        sizeof(float)
    );

    uint16_t registers[2];

    registers[0] =
        static_cast<uint16_t>((bits >> 16) & 0xFFFF);

    registers[1] =
        static_cast<uint16_t>(bits & 0xFFFF);

    if (modbus_write_registers(
            context,
            address,
            2,
            registers
        ) == -1)
    {
        throw std::runtime_error(
            modbus_strerror(errno)
        );
    }
}


float ModbusClient::readReal(int address)
{
    uint16_t registers[2];

    if (modbus_read_registers(
            context,
            address,
            2,
            registers
        ) == -1)
    {
        throw std::runtime_error(
            modbus_strerror(errno)
        );
    }

    return modbus_get_float_abcd(
        registers
    );
}


void ModbusClient::writeBool(int address, bool value)
{
    if (modbus_write_bit(
            context,
            address,
            value
        ) == -1)
    {
        throw std::runtime_error(
            modbus_strerror(errno)
        );
    }
}


bool ModbusClient::readBool(int address)
{
    uint8_t value;

    if (modbus_read_bits(
            context,
            address,
            1,
            &value
        ) == -1)
    {
        throw std::runtime_error(
            modbus_strerror(errno)
        );
    }

    return value != 0;
}