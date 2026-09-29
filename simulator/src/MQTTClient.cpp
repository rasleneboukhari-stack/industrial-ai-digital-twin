#include "MQTTClient.hpp"
#include <iostream>
#include <string>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

MQTTClient::MQTTClient(
    std::string server,
    std::string id
)
:
client(server, id)
{
    serverAddress = server;
    clientID = id;
    client.set_callback(*this);
}



void MQTTClient::connect()
{
    try
    {
        client.connect()->wait();

        std::cout << "MQTT connected\n";
    }

    catch(const mqtt::exception& e)
    {
        std::cout << "MQTT connection failed: "
                  << e.what()
                  << std::endl;
    }
}



void MQTTClient::publish(
    std::string topic,
    std::string message
)
{

    auto msg = mqtt::make_message(
        topic,
        message
    );


    client.publish(msg)->wait();

}

void MQTTClient::subscribe(const std::string& topic) {
    client.subscribe(topic, 1)->wait();
}

void MQTTClient::message_arrived(mqtt::const_message_ptr msg)
{
    std::string topic = msg->get_topic();

    std::string prefix = "factory/machine/";
    std::string suffix = "/command";

    std::string idString =
        topic.substr(
            prefix.length(),
            topic.length() - prefix.length() - suffix.length()
        );

    int machineID = std::stoi(idString);

    std::string payload = msg->to_string();

    json commandJson = json::parse(payload);

    std::string command = commandJson["command"];
    int value = commandJson.value("value", 0);

    std::cout << "Machine ID: " << machineID << std::endl;
    std::cout << "Command: " << command << std::endl;
    std::cout << "Value: " << value << std::endl;
}

void MQTTClient::setCommandHandler(
    std::function<void(int, std::string, int)> handler
)
{
    commandHandler = handler;
}