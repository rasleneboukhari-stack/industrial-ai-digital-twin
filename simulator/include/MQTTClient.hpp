#ifndef MQTTCLIENT_HPP
#define MQTTCLIENT_HPP

#include <string>
#include <mqtt/client.h>
#include <functional>


class MQTTClient : public virtual mqtt::callback
{

private:

    std::string serverAddress;
    std::string clientID;

    mqtt::async_client client;
    std::function<void(int, std::string, int)> commandHandler;


public:

    MQTTClient(
        std::string server,
        std::string id
    );

    void connect();

    void publish(
        std::string topic,
        std::string message
    );
    void subscribe(const std::string& topic);
    void message_arrived(mqtt::const_message_ptr msg) override;
    void setCommandHandler(
    std::function<void(int, std::string, int)> handler
);


};


#endif