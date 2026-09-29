export type MachineOperatingStatus = 'RUNNING' | 'STOPPED' | 'FAULT' | 'OFFLINE';
export type FailureRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type DigitalTwinStatus = 'ONLINE' | 'STALE' | 'OFFLINE';

export interface MachineState {
  id: number;
  health?: number;
  temperature: number;
  vibration: number;
  rpm: number;
  load: number;
  current: number;
  status: MachineOperatingStatus;
  coolingSetpoint: number;
  predictedHealth?: number;
  healthForecastMinutesAhead?: number;
  failureRisk?: FailureRisk;
  suspectedFault?: string;
  lastUpdate?: string;
  digitalTwinStatus?: DigitalTwinStatus;
  recommendedAction?: string;
  recentAlarms?: string[];
  maintenanceHistory?: string[];
}

export function healthForecastLabel(machine: MachineState): string {
  const minutes = machine.healthForecastMinutesAhead;
  if (minutes === undefined) return 'Health forecast';
  return minutes < 60
    ? `Health in ${Math.max(1, Math.round(minutes))}m`
    : `Health in ${(minutes / 60).toFixed(1)}h`;
}
