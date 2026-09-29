import type { Alert } from './Alert';

export type AIMessageSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AIMessageKind = 'PREDICTION' | 'RECOMMENDATION' | 'DECISION';

export interface AIRecommendedCommand {
  command: 'SET_COOLING' | 'REDUCE_LOAD' | 'STOP';
  /** Direct backend value, such as a 90% cooling setpoint. */
  value?: number;
  /** Desired final value when the backend command expects a delta. */
  targetValue?: number;
  label: string;
}

/**
 * Presentation contract for messages produced by the predictive-maintenance / AI backend.
 * The Phaser frontend renders these values only; it does not calculate predictions or decisions.
 */
export interface AIMessage {
  id: string;
  machineId?: number;
  severity: AIMessageSeverity;
  kind: AIMessageKind;
  eventType?: 'temperature' | 'vibration' | 'current_excess' | 'rapid_health_loss' | 'failure';
  title: string;
  message: string;
  recommendedAction?: string;
  recommendedCommand?: AIRecommendedCommand;
  sourcePredictionId?: string;
  confidence?: number;
  timestamp: string;
  /** Simulator minute at the input window, and the prediction horizon. */
  simulatedMinute?: number;
  horizonMinutes?: number;
  /**
   * When false, retain the message in the AI history without opening the prominent assistant dialogue.
   * Backends may omit this field; messages are prominent by default.
   */
  prominent?: boolean;
}

export function isAIMessageExpired(message: AIMessage, currentMinute: number): boolean {
  return message.simulatedMinute !== undefined &&
    message.horizonMinutes !== undefined &&
    currentMinute >= message.simulatedMinute + message.horizonMinutes;
}

export function isAIMessageSuperseded(message: AIMessage, alert: Alert): boolean {
  if (message.machineId !== alert.machineId || alert.source !== 'SYSTEM' ||
      alert.status === 'RESOLVED') return false;
  const observedByPrediction: Record<string, string> = {
    'Temperature risk within 24 hours': 'Temperature operating limit reached',
    'Vibration risk within 24 hours': 'Vibration operating limit reached',
    'Current risk at this load within 24 hours': 'Current excess observed',
    'Failure risk within 48 hours': 'Machine failure active',
  };
  const observedByEventType: Record<NonNullable<AIMessage['eventType']>, string> = {
    temperature: 'Temperature operating limit reached',
    vibration: 'Vibration operating limit reached',
    current_excess: 'Current excess observed',
    rapid_health_loss: '',
    failure: 'Machine failure active',
  };
  if (message.eventType) return observedByEventType[message.eventType] === alert.title;
  return observedByPrediction[message.title] === alert.title;
}
