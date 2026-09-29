import type { Alert } from './Alert';
import type { AIMessage } from './AIMessage';
import type { FactoryEvent } from './FactoryEvent';
import type { MachineState } from './MachineState';
import type { MaintenanceRequest, TechnicianState } from './Maintenance';

export interface FactoryState {
  simulatedTime: string;
  simulationDay: number;
  simulationSpeed: number;
  paused: boolean;
  demand: number;
  productionOutput: number;
  ambientTemperature: number;
  operatingMode: 'MANUAL' | 'AUTONOMOUS';
  machines: MachineState[];
  alerts: Alert[];
  aiMessages: AIMessage[];
  events: FactoryEvent[];
  maintenance: MaintenanceRequest[];
  technicians: TechnicianState[];
}
