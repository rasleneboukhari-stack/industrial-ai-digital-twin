import mqtt, { type MqttClient } from 'mqtt';

import type { FactoryState } from '../models/FactoryState';
import type { MachineState } from '../models/MachineState';
import { isAIMessageExpired, isAIMessageSuperseded, type AIMessage } from '../models/AIMessage';
import type { Alert } from '../models/Alert';

const SIMULATOR_CLOCK_ORIGIN = Date.parse('2026-09-21T07:00:00.000Z');

export interface MachineTelemetry {
    id: number;
    temperature: number;
    vibration: number;
    rpm: number;
    load: number;
    current: number;
    cooling: number;
    health: number;
    running: boolean;
    state: 'NORMAL' | 'WARNING' | 'DEGRADING' | 'FAILURE';
    simulatedMinute: number;
    simulationSpeed?: number;
    paused?: boolean;
}

interface SystemAlertMessage extends Omit<Alert, 'timestamp'> {
    onsetSimulatedMinute: number;
    observedSimulatedMinute: number;
}

interface HealthForecast {
    machineId: number;
    simulatedMinute: number;
    horizonMinutes: number;
    predictedHealth: number;
}

type TelemetryListener =
    (telemetry: MachineTelemetry) => void;

type AIMessageListener =
    (message: AIMessage) => void;

type SystemAlertListener =
    (alert: Alert) => void;

export class MqttTelemetryService {
    private client?: MqttClient;
    private started = false;

    private readonly listeners =
        new Set<TelemetryListener>();

    private readonly aiMessageListeners =
        new Set<AIMessageListener>();

    private readonly systemAlertListeners =
        new Set<SystemAlertListener>();

    private readonly latestTelemetry =
        new Map<number, MachineTelemetry>();

    private readonly latestAIMessages =
        new Map<string, AIMessage>();

    private readonly latestSystemAlerts =
        new Map<string, Alert>();

    private readonly latestHealthForecasts =
        new Map<number, HealthForecast>();

    constructor(
        private readonly url =
            import.meta.env.VITE_MQTT_WS_URL ??
            'ws://localhost:9001'
    ) {}

    start(): void {
        if (this.started) return;

        this.started = true;

        this.client = mqtt.connect(this.url, {
            reconnectPeriod: 1500,
            connectTimeout: 5000,
        });

        this.client.on('connect', () => {
            console.log('MQTT telemetry connected');

            this.client?.subscribe(
                [
                    'factory/machine/+/telemetry',
                    'factory/ai/messages',
                    'factory/system/alerts',
                    'factory/ai/health/+',
                ],
                (error) => {
                    if (error) {
                        console.error(
                            'MQTT subscribe failed',
                            error
                        );
                    } else {
                        console.log(
                            'Subscribed to machine telemetry'
                        );
                    }
                }
            );
        });

        this.client.on(
            'message',
            (topic, payload) => {
                try {
                    if (topic.startsWith('factory/ai/health/')) {
                        const machineId = Number(topic.slice('factory/ai/health/'.length));
                        if (!Number.isInteger(machineId) || machineId < 1) return;
                        if (payload.length === 0) {
                            this.latestHealthForecasts.delete(machineId);
                            return;
                        }
                        const forecast = JSON.parse(payload.toString()) as HealthForecast;
                        if (this.isValidHealthForecast(forecast) && forecast.machineId === machineId) {
                            this.latestHealthForecasts.set(machineId, forecast);
                        }
                        return;
                    }

                    if (topic === 'factory/system/alerts') {
                        const alert = JSON.parse(payload.toString()) as SystemAlertMessage;
                        if (!this.isValidSystemAlert(alert)) return;
                        const timestamp = new Date(
                            SIMULATOR_CLOCK_ORIGIN + alert.onsetSimulatedMinute * 60_000
                        ).toISOString();
                        const resolvedAt = alert.status === 'RESOLVED'
                            ? new Date(SIMULATOR_CLOCK_ORIGIN +
                                alert.observedSimulatedMinute * 60_000).toISOString()
                            : undefined;
                        const previousAlert = this.latestSystemAlerts.get(alert.id);
                        this.latestSystemAlerts.set(alert.id, {
                            ...alert, timestamp, resolvedAt,
                        });
                        const current = this.latestSystemAlerts.get(alert.id);
                        if (current && previousAlert?.status !== current.status) {
                            for (const listener of this.systemAlertListeners) listener(current);
                        }
                        if (this.latestSystemAlerts.size > 100) {
                            const oldestId = this.latestSystemAlerts.keys().next().value;
                            if (oldestId !== undefined) this.latestSystemAlerts.delete(oldestId);
                        }
                        return;
                    }

                    if (topic === 'factory/ai/messages') {
                        const message = JSON.parse(
                            payload.toString()
                        ) as AIMessage;

                        if (!this.isValidAIMessage(message)) {
                            return;
                        }

                        const machineTelemetry = message.machineId === undefined
                            ? undefined
                            : this.latestTelemetry.get(message.machineId);
                        const activeSystemEvent = [...this.latestSystemAlerts.values()].some(
                            (alert) => isAIMessageSuperseded(message, alert)
                        );
                        const expired = machineTelemetry !== undefined &&
                            isAIMessageExpired(message, machineTelemetry.simulatedMinute);
                        const presentNow = !activeSystemEvent &&
                            !expired &&
                            (!machineTelemetry ||
                                (machineTelemetry.running && machineTelemetry.state !== 'FAILURE'));

                        const key = message.machineId === undefined
                            ? message.id
                            : `${message.machineId}:${message.eventType ?? message.title}`;
                        this.latestAIMessages.set(
                            key,
                            message
                        );

                        if (this.latestAIMessages.size > 150) {
                            const oldestId = this.latestAIMessages.keys().next().value;
                            if (oldestId !== undefined) {
                                this.latestAIMessages.delete(oldestId);
                            }
                        }

                        if (presentNow) {
                            for (const listener of this.aiMessageListeners) {
                                listener(message);
                            }
                        }

                        return;
                    }

                    const telemetry =
                        JSON.parse(
                            payload.toString()
                        ) as MachineTelemetry;

                    if (!this.isValid(telemetry)) {
                        return;
                    }

                    const previous = this.latestTelemetry.get(telemetry.id);
                    if (previous && telemetry.simulatedMinute < previous.simulatedMinute) {
                        this.latestTelemetry.clear();
                        this.latestAIMessages.clear();
                        this.latestSystemAlerts.clear();
                        this.latestHealthForecasts.clear();
                    }

                    if (!telemetry.running || telemetry.state === 'FAILURE' ||
                        (previous && telemetry.health - previous.health > 10)) {
                        this.latestHealthForecasts.delete(telemetry.id);
                    }

                    this.latestTelemetry.set(
                        telemetry.id,
                        telemetry
                    );

                    for (const listener of this.listeners) {
                        listener(telemetry);
                    }
                }
                catch (error) {
                    console.error(
                        'MQTT telemetry parse error',
                        error
                    );
                }
            }
        );

        this.client.on('error', (error) => {
            console.error(
                'MQTT connection error',
                error
            );
        });
    }

    subscribe(
        listener: TelemetryListener
    ): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    subscribeToAIMessages(
        listener: AIMessageListener
    ): () => void {
        this.aiMessageListeners.add(listener);

        return () => {
            this.aiMessageListeners.delete(listener);
        };
    }

    subscribeToSystemAlerts(listener: SystemAlertListener): () => void {
        this.systemAlertListeners.add(listener);
        return () => this.systemAlertListeners.delete(listener);
    }

    mergeState(
        state: FactoryState
    ): FactoryState {
        const merged =
            structuredClone(state);

        const liveMockMode =
            Boolean(import.meta.env.VITE_MQTT_WS_URL) &&
            import.meta.env.VITE_USE_REAL_BACKEND !== 'true';

        if (liveMockMode && this.latestTelemetry.size > 0) {
            const latest = [...this.latestTelemetry.values()].reduce(
                (newest, telemetry) => telemetry.simulatedMinute > newest.simulatedMinute
                    ? telemetry : newest
            );
            const minute = latest.simulatedMinute;
            merged.simulatedTime = new Date(
                SIMULATOR_CLOCK_ORIGIN + minute * 60_000
            ).toISOString();
            merged.simulationDay = Math.floor((7 * 60 + minute) / 1440) + 1;
            merged.simulationSpeed = latest.simulationSpeed ?? merged.simulationSpeed;
            merged.paused = latest.paused ?? merged.paused;
        }

        for (const machine of merged.machines) {
            if (liveMockMode) {
                machine.predictedHealth = undefined;
                machine.healthForecastMinutesAhead = undefined;
                machine.failureRisk = undefined;
                machine.suspectedFault = undefined;
                machine.recommendedAction = undefined;
                machine.recentAlarms = [];
            }

            const telemetry =
                this.latestTelemetry.get(machine.id);

            if (telemetry) {
                this.applyTelemetry(
                    machine,
                    telemetry
                );
                const forecast = this.latestHealthForecasts.get(machine.id);
                const age = forecast ? telemetry.simulatedMinute - forecast.simulatedMinute : -1;
                if (telemetry.running && telemetry.state !== 'FAILURE' && forecast &&
                    age >= 0 && age < forecast.horizonMinutes) {
                    machine.predictedHealth = forecast.predictedHealth;
                    machine.healthForecastMinutesAhead = forecast.horizonMinutes - age;
                }
            }
        }

        const mqttMessages =
            [...this.latestAIMessages.values()].map((message) => {
                const telemetry = message.machineId === undefined
                    ? undefined : this.latestTelemetry.get(message.machineId);
                return telemetry && isAIMessageExpired(message, telemetry.simulatedMinute)
                    ? { ...message, prominent: false }
                    : message;
            });

        const mqttMessageIds =
            new Set(mqttMessages.map((message) => message.id));

        merged.aiMessages = [
            ...mqttMessages,
            ...(liveMockMode
                ? []
                : (merged.aiMessages ?? []).filter(
                    (message) => !mqttMessageIds.has(message.id)
                )),
        ]
            .sort((a, b) =>
                new Date(b.timestamp).getTime() -
                new Date(a.timestamp).getTime()
            )
            .slice(0, 100);

        if (liveMockMode) {
            merged.alerts = [...this.latestSystemAlerts.values()]
                .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        }

        return merged;
    }

    applyTelemetry(
        machine: MachineState,
        telemetry: MachineTelemetry
    ): void {
        machine.temperature =
            telemetry.temperature;

        machine.vibration =
            telemetry.vibration;

        machine.rpm =
            telemetry.rpm;

        machine.load =
            telemetry.load;

        machine.current =
            telemetry.current;

        machine.health =
            telemetry.health;

        machine.coolingSetpoint =
            telemetry.cooling;

        machine.status =
            telemetry.state === 'FAILURE'
                ? 'FAULT'
                : telemetry.running
                    ? 'RUNNING'
                    : 'STOPPED';

        machine.digitalTwinStatus =
            'ONLINE';

        machine.lastUpdate =
            new Date().toISOString();
    }

    private isValid(
        data: MachineTelemetry
    ): boolean {
        return (
            Number.isInteger(data.id) &&
            data.id > 0 &&
            Number.isFinite(data.temperature) &&
            Number.isFinite(data.vibration) &&
            Number.isFinite(data.rpm) &&
            Number.isFinite(data.load) &&
            Number.isFinite(data.current) &&
            Number.isFinite(data.cooling) &&
            Number.isFinite(data.health) &&
            Number.isInteger(data.simulatedMinute) &&
            data.simulatedMinute >= 0 &&
            (data.simulationSpeed === undefined ||
                Number.isInteger(data.simulationSpeed)) &&
            (data.paused === undefined || typeof data.paused === 'boolean') &&
            typeof data.running === 'boolean'
        );
    }

    private isValidAIMessage(
        message: AIMessage
    ): boolean {
        return (
            typeof message.id === 'string' &&
            message.id.length > 0 &&
            (message.machineId === undefined ||
                (Number.isInteger(message.machineId) && message.machineId > 0)) &&
            ['INFO', 'WARNING', 'CRITICAL'].includes(message.severity) &&
            ['PREDICTION', 'RECOMMENDATION', 'DECISION'].includes(message.kind) &&
            typeof message.title === 'string' &&
            typeof message.message === 'string' &&
            typeof message.timestamp === 'string' &&
            !Number.isNaN(Date.parse(message.timestamp)) &&
            (message.confidence === undefined ||
                (Number.isFinite(message.confidence) &&
                    message.confidence >= 0 && message.confidence <= 1)) &&
            (message.simulatedMinute === undefined ||
                (Number.isInteger(message.simulatedMinute) && message.simulatedMinute >= 0)) &&
            (message.horizonMinutes === undefined ||
                (Number.isInteger(message.horizonMinutes) && message.horizonMinutes > 0))
        );
    }

    private isValidSystemAlert(alert: SystemAlertMessage): boolean {
        return typeof alert.id === 'string' &&
            Number.isInteger(alert.machineId) && alert.machineId > 0 &&
            alert.source === 'SYSTEM' &&
            ['MEDIUM', 'HIGH', 'CRITICAL'].includes(alert.severity) &&
            ['ACTIVE', 'RESOLVED'].includes(alert.status) &&
            typeof alert.title === 'string' &&
            typeof alert.message === 'string' &&
            Number.isInteger(alert.onsetSimulatedMinute) &&
            Number.isInteger(alert.observedSimulatedMinute) &&
            alert.onsetSimulatedMinute >= 0 &&
            alert.observedSimulatedMinute >= alert.onsetSimulatedMinute;
    }

    private isValidHealthForecast(forecast: HealthForecast): boolean {
        return Number.isInteger(forecast.machineId) && forecast.machineId > 0 &&
            Number.isInteger(forecast.simulatedMinute) && forecast.simulatedMinute >= 0 &&
            forecast.horizonMinutes === 300 &&
            Number.isFinite(forecast.predictedHealth) &&
            forecast.predictedHealth >= 0 && forecast.predictedHealth <= 100;
    }
}

export const mqttTelemetry =
    new MqttTelemetryService();
