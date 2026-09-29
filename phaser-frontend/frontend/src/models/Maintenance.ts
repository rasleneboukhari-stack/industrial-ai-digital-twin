export type MaintenanceStatus =
  | 'REQUESTED'
  | 'QUEUED'
  | 'EN_ROUTE'
  | 'DIAGNOSING'
  | 'REPAIRING'
  | 'TESTING'
  | 'COMPLETED'
  | 'FAILED';

export type TechnicianStatus =
  | 'AVAILABLE'
  | 'EN_ROUTE'
  | 'DIAGNOSING'
  | 'REPAIRING'
  | 'TESTING'
  | 'RETURNING';

export interface MaintenanceRequest {
  id: string;
  machineId: number;
  status: MaintenanceStatus;
  repairType?: string;
  technicianId?: string;
  progress?: number;
  estimatedCompletion?: string;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  diagnosis?: string;
}

export interface TechnicianState {
  id: string;
  status: TechnicianStatus;
  targetMachineId?: number;
  x?: number;
  y?: number;
}
