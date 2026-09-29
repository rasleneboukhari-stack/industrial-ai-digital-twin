import type { FactoryState } from '../models/FactoryState';
import type { MachineState } from '../models/MachineState';

export type MachineCommand =
  | 'SET_COOLING'
  | 'REDUCE_LOAD'
  | 'STOP'
  | 'START'
  | 'REQUEST_MAINTENANCE';

export interface CommandResult {
  accepted: boolean;
  message: string;
}

export interface FactoryBackend {
  getFactoryState(): Promise<FactoryState>;
  getMachine(machineId: number): Promise<MachineState>;
  sendCommand(machineId: number, command: MachineCommand, value?: number): Promise<CommandResult>;
  acknowledgeAlert(alertId: string): Promise<void>;
  setSimulationSpeed(speed: number, paused: boolean): Promise<void>;
  subscribeToUpdates(callback: (state: FactoryState) => void): () => void;
  destroy(): void;
}
