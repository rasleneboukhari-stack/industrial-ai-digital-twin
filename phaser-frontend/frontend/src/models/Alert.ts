import type { FailureRisk } from './MachineState';

export type AlertSource = 'SYSTEM' | 'AI';
export type AlertLifecycle = 'ACTIVE' | 'ACKNOWLEDGED' | 'MITIGATED' | 'RESOLVED';

export interface Alert {
  id: string;
  machineId: number;
  source: AlertSource;
  severity: FailureRisk;
  title: string;
  message: string;
  timestamp: string;
  recommendation?: string;
  status: AlertLifecycle;
  acknowledgedAt?: string;
  resolvedAt?: string;
  detail?: string;
}
