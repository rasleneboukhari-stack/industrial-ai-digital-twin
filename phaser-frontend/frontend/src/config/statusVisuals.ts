import type { MachineState } from '../models/MachineState';

export const STATUS_COLORS = {
  healthy: 0x55c977,
  warning: 0xe6bd52,
  high: 0xe98b45,
  critical: 0xe35d5d,
  stopped: 0x6f8998,
  offline: 0x515c62,
  maintenance: 0x5f9fb8,
  player: 0xe7fbff,
  technician: 0x7fd6ff,
};

export function machineStatusColor(machine: MachineState, underMaintenance = false): number {
  if (underMaintenance) return STATUS_COLORS.maintenance;
  if (machine.status === 'OFFLINE') return STATUS_COLORS.offline;
  if (machine.status === 'FAULT') return STATUS_COLORS.critical;
  if (machine.status === 'STOPPED') return STATUS_COLORS.stopped;
  if (machine.failureRisk === 'CRITICAL') return STATUS_COLORS.critical;
  if (machine.failureRisk === 'HIGH') return STATUS_COLORS.high;
  if (
    machine.failureRisk === 'MEDIUM' ||
    machine.temperature >= 78 ||
    machine.vibration >= 0.55
  ) {
    return STATUS_COLORS.warning;
  }
  return STATUS_COLORS.healthy;
}
