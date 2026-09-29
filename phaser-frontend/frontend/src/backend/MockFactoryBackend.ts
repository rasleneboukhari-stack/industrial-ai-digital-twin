import type { FactoryBackend, MachineCommand, CommandResult } from './FactoryBackend';
import type { FactoryState } from '../models/FactoryState';
import type { MachineState } from '../models/MachineState';
import type { Alert } from '../models/Alert';
import type { AIMessage } from '../models/AIMessage';
import type { FactoryEvent } from '../models/FactoryEvent';
import type { MaintenanceRequest, TechnicianState } from '../models/Maintenance';
import { machinePositions } from '../config/machineLayout';

const cloneState = (state: FactoryState): FactoryState => structuredClone(state);
const iso = (date: Date) => date.toISOString();
const MINUTE = 60;

interface MaintenanceRuntime {
  phaseStartedAtMs: number;
  repairDurationSeconds: number;
  route: Array<{ x: number; y: number }>;
}

export class MockFactoryBackend implements FactoryBackend {
  private state: FactoryState;
  private listeners = new Set<(state: FactoryState) => void>();
  private timer: number | undefined;
  private lastRealTime = performance.now();
  private mockElapsedSeconds = 0;
  private readonly startTimeMs: number;
  private readonly loadTargets = new Map<number, number>();
  private readonly maintenanceRuntime = new Map<string, MaintenanceRuntime>();
  private readonly technicianReturnStart = new Map<string, number>();
  private readonly faultFlags = new Map<number, string>();
  private eventSequence = 100;

  constructor() {
    const start = new Date('2026-09-21T07:00:00.000Z');
    this.startTimeMs = start.getTime();
    const machines = Array.from({ length: 18 }, (_, index) => this.createMachine(index + 1, start));

    this.faultFlags.set(3, 'Cooling performance degraded');
    this.faultFlags.set(4, 'Mechanical vibration trend');
    this.faultFlags.set(7, 'Bearing degradation');

    const alerts: Alert[] = [
      {
        id: 'alert-m07-bearing',
        machineId: 7,
        source: 'AI',
        severity: 'HIGH',
        title: 'Predicted bearing degradation',
        message: 'Vibration and current trend are elevated under sustained load.',
        timestamp: iso(start),
        recommendation: 'REDUCE_LOAD',
        status: 'ACTIVE',
      },
      {
        id: 'alert-m03-temperature',
        machineId: 3,
        source: 'SYSTEM',
        severity: 'MEDIUM',
        title: 'Temperature above normal envelope',
        message: 'Machine temperature is elevated while production remains active.',
        timestamp: iso(start),
        recommendation: 'SET_COOLING',
        status: 'ACTIVE',
      },
    ];

    const aiMessages: AIMessage[] = [
      {
        id: 'ai-m07-bearing-prediction',
        machineId: 7,
        severity: 'WARNING',
        kind: 'PREDICTION',
        title: 'Bearing degradation predicted',
        message: 'Machine 07 shows an abnormal vibration and current trend. Failure risk is increasing under sustained load.',
        recommendedAction: 'REDUCE_LOAD to 55–60%',
        confidence: 0.87,
        timestamp: iso(start),
        prominent: true,
      },
    ];

    const events: FactoryEvent[] = [
      { id: 'event-1', timestamp: iso(start), message: 'Factory mock scenario initialized.' },
      { id: 'event-2', timestamp: iso(start), message: 'M07 AI failure risk raised to HIGH.', machineId: 7 },
    ];

    const technicians: TechnicianState[] = [
      { id: 'T01', status: 'AVAILABLE', x: 220, y: 880 },
      { id: 'T02', status: 'AVAILABLE', x: 300, y: 880 },
    ];

    this.state = {
      simulatedTime: iso(start),
      simulationDay: 1,
      simulationSpeed: 60,
      paused: false,
      demand: 74,
      productionOutput: 860,
      ambientTemperature: 24,
      operatingMode: 'MANUAL',
      machines,
      alerts,
      aiMessages,
      events,
      maintenance: [],
      technicians,
    };

    this.timer = window.setInterval(() => this.tick(), 200);
  }

  async getFactoryState(): Promise<FactoryState> {
    return cloneState(this.state);
  }

  async getMachine(machineId: number): Promise<MachineState> {
    const machine = this.state.machines.find((item) => item.id === machineId);
    if (!machine) throw new Error(`Machine M${String(machineId).padStart(2, '0')} not found`);
    return structuredClone(machine);
  }

  subscribeToUpdates(callback: (state: FactoryState) => void): () => void {
    this.listeners.add(callback);
    callback(cloneState(this.state));
    return () => this.listeners.delete(callback);
  }

  async acknowledgeAlert(alertId: string): Promise<void> {
    const alert = this.state.alerts.find((item) => item.id === alertId);
    if (!alert || alert.status === 'RESOLVED') return;
    alert.acknowledgedAt = this.state.simulatedTime;
    if (alert.status === 'ACTIVE') alert.status = 'ACKNOWLEDGED';
    this.addEvent(`Operator acknowledged alert for M${String(alert.machineId).padStart(2, '0')}.`, alert.machineId);
    this.emit();
  }

  async sendCommand(
      machineId: number,
      command: MachineCommand,
      value?: number
  ): Promise<CommandResult> {

    if (command === 'REQUEST_MAINTENANCE') {
      return {
        accepted: false,
        message: 'Maintenance backend not connected yet'
      };
    }

    const baseUrl =
        import.meta.env.VITE_COMMAND_API_URL ??
        'http://localhost:8080/api';

    const response = await fetch(
        `${baseUrl}/machines/${machineId}/commands`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            command,
            value
          })
        }
    );

    if (!response.ok) {
      return {
        accepted: false,
        message: `Command failed: ${response.status}`
      };
    }

    return await response.json() as CommandResult;
  }
  async setSimulationSpeed(
      speed: number,
      paused: boolean
  ): Promise<void> {
    const allowed =
        [1, 10, 60, 600, 10000];

    if (
        !paused &&
        !allowed.includes(speed)
    ) {
      throw new Error(
          `Unsupported simulation speed ${speed}`
      );
    }

    const baseUrl =
        import.meta.env.VITE_COMMAND_API_URL ??
        'http://localhost:8081/api';

    const response = await fetch(
        `${baseUrl}/simulation/speed`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
                'application/json'
          },
          body: JSON.stringify({
            speed,
            paused
          })
        }
    );

    if (!response.ok) {
      throw new Error(
          `Speed change failed: ${response.status}`
      );
    }

    this.state.paused = paused;

    this.state.simulationSpeed =
        paused ? 0 : speed;

    this.addEvent(
        paused
            ? 'Simulation paused.'
            : `Simulation speed set to ${speed}x.`
    );

    this.emit();
  }

  destroy(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.listeners.clear();
  }

  private validateCommand(machine: MachineState, command: MachineCommand): string | undefined {
    const activeMaintenance = this.activeMaintenanceFor(machine.id);

    if (machine.status === 'OFFLINE') return 'Machine is offline; executable commands are unavailable.';
    if (activeMaintenance && command !== 'REQUEST_MAINTENANCE') return 'Machine is under active maintenance.';

    if (command === 'STOP' && machine.status !== 'RUNNING') return 'Machine is not running.';
    if (command === 'START') {
      if (machine.status === 'RUNNING') return 'Machine is already running.';
      if (machine.status === 'FAULT') return 'Faulted machine cannot be started.';
      if (activeMaintenance) return 'Maintenance must complete before START.';
    }
    if ((command === 'REDUCE_LOAD' || command === 'SET_COOLING') && machine.status !== 'RUNNING') {
      return `${command} is only available while the machine is running.`;
    }
    if (command === 'REQUEST_MAINTENANCE') {
      if (activeMaintenance) return 'Maintenance is already active for this machine.';
      if (machine.status === 'RUNNING') return 'Machine must be stopped before mechanical maintenance.';
    }
    return undefined;
  }

  private tick(): void {
    const now = performance.now();
    const realDeltaSeconds = Math.max(0, (now - this.lastRealTime) / 1000);
    this.lastRealTime = now;

    if (this.state.paused || this.state.simulationSpeed <= 0) return;

    const simulatedDeltaSeconds = realDeltaSeconds * this.state.simulationSpeed;
    this.mockElapsedSeconds += simulatedDeltaSeconds;

    const clock = new Date(this.state.simulatedTime);
    clock.setTime(clock.getTime() + simulatedDeltaSeconds * 1000);
    this.state.simulatedTime = iso(clock);
    this.state.simulationDay = Math.floor((clock.getTime() - this.startTimeMs) / 86_400_000) + 1;

    const hour = clock.getUTCHours() + clock.getUTCMinutes() / 60;
    this.state.demand = this.demandForHour(hour);
    this.state.ambientTemperature = Number((24 + Math.sin(this.mockElapsedSeconds / 7200) * 2.2).toFixed(1));

    const unavailable = this.state.machines.filter((machine) => machine.status !== 'RUNNING').length;
    const capacityPenalty = unavailable * 0.025;
    this.state.productionOutput = Math.round(this.state.demand * 11.6 * Math.max(0.55, 1 - capacityPenalty));

    for (const machine of this.state.machines) {
      this.updateMockMachine(machine, simulatedDeltaSeconds, unavailable);
      machine.lastUpdate = this.state.simulatedTime;
    }

    this.updateMaintenance();
    this.emit();
  }

  private updateMockMachine(machine: MachineState, simulatedDeltaSeconds: number, unavailableCount: number): void {
    if (machine.status === 'OFFLINE' || machine.status === 'FAULT') return;

    if (machine.status === 'STOPPED') {
      const equilibrium = this.state.ambientTemperature + 2;
      const coolingFactor = 1 - Math.exp(-simulatedDeltaSeconds / 1200);
      machine.temperature = Number((machine.temperature + (equilibrium - machine.temperature) * coolingFactor).toFixed(1));
      machine.vibration = 0.02;
      machine.rpm = 0;
      machine.load = 0;
      machine.current = 0;
      this.applyStoppedRecommendation(machine);
      return;
    }

    const phase = this.mockElapsedSeconds / 12 + machine.id * 0.73;
    const wave = Math.sin(phase) * 0.5 + Math.sin(phase * 0.27) * 0.5;
    const demandInfluence = Math.max(0, this.state.demand - 60) * 0.12;
    const redistribution = Math.min(18, unavailableCount * 2.4);

    const commandedLoad = this.loadTargets.get(machine.id);
    if (commandedLoad !== undefined) {
      machine.load = commandedLoad;
    } else if (machine.id !== 7) {
      const target = this.state.demand + redistribution + (machine.id % 4) * 2;
      machine.load = Number(Math.min(97, Math.max(35, machine.load * 0.86 + target * 0.14)).toFixed(1));
    }

    machine.rpm = Math.round(850 + machine.load * 19 + wave * 35);
    machine.current = Number((6 + machine.load * 0.18 + Math.abs(wave) * 0.7).toFixed(1));
    machine.temperature = Number((39 + machine.load * 0.38 + demandInfluence - machine.coolingSetpoint * 0.08 + wave * 1.1).toFixed(1));
    machine.vibration = Number((0.12 + machine.load * 0.002 + Math.abs(wave) * 0.05).toFixed(2));

    if (machine.id === 3 && this.faultFlags.has(3)) {
      machine.temperature = Number((86 - machine.coolingSetpoint * 0.10 + Math.abs(wave) * 4).toFixed(1));
      machine.failureRisk = 'MEDIUM';
      machine.suspectedFault = 'Cooling performance degraded';
      machine.recommendedAction = 'SET_COOLING';
    }

    if (machine.id === 4 && this.faultFlags.has(4)) {
      machine.vibration = Number((0.58 + Math.abs(wave) * 0.17).toFixed(2));
      machine.failureRisk = 'MEDIUM';
      machine.suspectedFault = 'Mechanical vibration trend';
      machine.recommendedAction = 'REDUCE_LOAD';
    }

    if (machine.id === 7 && this.faultFlags.has(7)) {
      if (commandedLoad === undefined) machine.load = Math.max(machine.load, 88);
      machine.rpm = Math.round(850 + machine.load * 19 + wave * 45);
      machine.current = Number((6 + machine.load * 0.20 + Math.abs(wave) * 1.2).toFixed(1));
      machine.temperature = Number((52 + machine.load * 0.38 - machine.coolingSetpoint * 0.08 + Math.abs(wave) * 3.1).toFixed(1));
      machine.vibration = Number((0.30 + machine.load * 0.0043 + Math.abs(wave) * 0.10).toFixed(2));
      machine.failureRisk = 'HIGH';
      machine.predictedHealth = 42;
      machine.suspectedFault = 'Bearing degradation';
      machine.recommendedAction = 'REDUCE_LOAD';
    }
  }

  private createMachine(id: number, start: Date): MachineState {
    const baseLoad = 52 + (id % 5) * 6;
    const machine: MachineState = {
      id,
      temperature: 55 + (id % 4) * 2,
      vibration: 0.18 + (id % 3) * 0.03,
      rpm: 850 + baseLoad * 19,
      load: baseLoad,
      current: Number((6 + baseLoad * 0.18).toFixed(1)),
      status: 'RUNNING',
      coolingSetpoint: 55,
      predictedHealth: 88 - (id % 6) * 3,
      failureRisk: 'LOW',
      suspectedFault: 'None detected',
      lastUpdate: iso(start),
      digitalTwinStatus: 'ONLINE',
      recommendedAction: 'NONE',
      recentAlarms: [],
      maintenanceHistory: ['Preventive inspection — 12 simulated days ago'],
    };

    if (id === 2) {
      machine.load = 92;
      machine.rpm = 2600;
      machine.current = 23.6;
    }
    if (id === 3) {
      machine.temperature = 82;
      machine.failureRisk = 'MEDIUM';
      machine.suspectedFault = 'Cooling performance degraded';
      machine.recommendedAction = 'SET_COOLING';
      machine.recentAlarms = ['Temperature warning'];
    }
    if (id === 4) {
      machine.vibration = 0.69;
      machine.failureRisk = 'MEDIUM';
      machine.suspectedFault = 'Mechanical vibration trend';
      machine.recommendedAction = 'REDUCE_LOAD';
      machine.recentAlarms = ['Vibration warning'];
    }
    if (id === 7) {
      machine.load = 91;
      machine.rpm = 2470;
      machine.temperature = 83.4;
      machine.vibration = 0.72;
      machine.current = 24.3;
      machine.predictedHealth = 42;
      machine.failureRisk = 'HIGH';
      machine.suspectedFault = 'Bearing degradation';
      machine.recommendedAction = 'REDUCE_LOAD';
      machine.recentAlarms = ['Vibration anomaly', 'Current trend elevated'];
    }
    return machine;
  }

  private applyStoppedRecommendation(machine: MachineState): void {
    if (this.faultFlags.has(machine.id) || machine.failureRisk === 'HIGH' || machine.failureRisk === 'CRITICAL') {
      machine.recommendedAction = 'REQUEST_MAINTENANCE';
    } else if (!this.activeMaintenanceFor(machine.id)) {
      machine.recommendedAction = 'START';
    }
  }

  private applyRunningRecommendation(machine: MachineState): void {
    if (this.faultFlags.has(machine.id)) {
      machine.recommendedAction = machine.id === 3 ? 'SET_COOLING' : 'REDUCE_LOAD';
    } else {
      machine.recommendedAction = 'NONE';
    }
  }

  private markAlertMitigated(machineId: number): void {
    for (const alert of this.state.alerts.filter((item) => item.machineId === machineId && item.status !== 'RESOLVED')) {
      alert.status = 'MITIGATED';
      alert.recommendation = 'REQUEST_MAINTENANCE';
      alert.detail = 'Machine stopped. Underlying fault remains unresolved.';
    }
  }

  private createMaintenanceRequest(machine: MachineState): void {
    const repairType = this.repairTypeFor(machine.id);
    const request: MaintenanceRequest = {
      id: `maint-${machine.id}-${this.eventSequence++}`,
      machineId: machine.id,
      status: 'REQUESTED',
      repairType,
      progress: 0,
      requestedAt: this.state.simulatedTime,
    };
    this.state.maintenance.unshift(request);
    machine.maintenanceHistory = [
      `Maintenance queued at ${this.shortTime(this.state.simulatedTime)}`,
      ...(machine.maintenanceHistory ?? []),
    ].slice(0, 6);
    this.addEvent(`Maintenance requested for M${String(machine.id).padStart(2, '0')}.`, machine.id);
  }

  private updateMaintenance(): void {
    const nowMs = new Date(this.state.simulatedTime).getTime();

    for (const request of this.state.maintenance) {
      if (request.status === 'COMPLETED' || request.status === 'FAILED') continue;

      if (request.status === 'REQUESTED') {
        request.status = 'QUEUED';
        this.addEvent(`Maintenance queued for M${String(request.machineId).padStart(2, '0')}.`, request.machineId);
      }

      if (request.status === 'QUEUED') {
        const technician = this.state.technicians.find((item) => item.status === 'AVAILABLE');
        if (technician) this.assignTechnician(request, technician, nowMs);
        continue;
      }

      const runtime = this.maintenanceRuntime.get(request.id);
      const technician = request.technicianId
        ? this.state.technicians.find((item) => item.id === request.technicianId)
        : undefined;
      if (!runtime || !technician) continue;

      const elapsedSeconds = Math.max(0, (nowMs - runtime.phaseStartedAtMs) / 1000);

      if (request.status === 'EN_ROUTE') {
        const duration = 12 * MINUTE;
        const progress = Math.min(1, elapsedSeconds / duration);
        const point = this.pointAlongRoute(runtime.route, progress);
        technician.x = point.x;
        technician.y = point.y;
        request.progress = Math.round(progress * 12);
        if (progress >= 1) {
          request.status = 'DIAGNOSING';
          technician.status = 'DIAGNOSING';
          runtime.phaseStartedAtMs = nowMs;
          this.addEvent(`${technician.id} arrived at M${String(request.machineId).padStart(2, '0')}.`, request.machineId);
        }
        continue;
      }

      if (request.status === 'DIAGNOSING') {
        request.progress = 12 + Math.min(13, Math.round((elapsedSeconds / (15 * MINUTE)) * 13));
        if (elapsedSeconds >= 15 * MINUTE) {
          request.status = 'REPAIRING';
          technician.status = 'REPAIRING';
          request.diagnosis = this.faultFlags.get(request.machineId) ?? 'No persistent fault confirmed';
          runtime.phaseStartedAtMs = nowMs;
          this.addEvent(`${technician.id} diagnosis: ${request.diagnosis}.`, request.machineId);
          this.addEvent(`${request.repairType ?? 'Repair'} started on M${String(request.machineId).padStart(2, '0')}.`, request.machineId);
        }
        continue;
      }

      if (request.status === 'REPAIRING') {
        const phaseProgress = Math.min(1, elapsedSeconds / runtime.repairDurationSeconds);
        request.progress = 25 + Math.round(phaseProgress * 60);
        if (phaseProgress >= 1) {
          request.status = 'TESTING';
          technician.status = 'TESTING';
          runtime.phaseStartedAtMs = nowMs;
          this.addEvent(`${request.repairType ?? 'Repair'} completed on M${String(request.machineId).padStart(2, '0')}.`, request.machineId);
        }
        continue;
      }

      if (request.status === 'TESTING') {
        request.progress = 85 + Math.min(14, Math.round((elapsedSeconds / (10 * MINUTE)) * 14));
        if (elapsedSeconds >= 10 * MINUTE) {
          this.completeMaintenance(request, technician, nowMs);
        }
      }
    }

    for (const technician of this.state.technicians) {
      if (technician.status !== 'RETURNING') continue;
      const started = this.technicianReturnStart.get(technician.id) ?? nowMs;
      const elapsed = (nowMs - started) / 1000;
      const request = this.state.maintenance.find((item) => item.technicianId === technician.id && item.status === 'COMPLETED');
      const runtime = request ? this.maintenanceRuntime.get(request.id) : undefined;
      if (!runtime) continue;
      const reverseRoute = [...runtime.route].reverse();
      const progress = Math.min(1, elapsed / (12 * MINUTE));
      const point = this.pointAlongRoute(reverseRoute, progress);
      technician.x = point.x;
      technician.y = point.y;
      if (progress >= 1) {
        technician.status = 'AVAILABLE';
        technician.targetMachineId = undefined;
        technician.x = technician.id === 'T01' ? 220 : 300;
        technician.y = 880;
        this.technicianReturnStart.delete(technician.id);
      }
    }
  }

  private assignTechnician(request: MaintenanceRequest, technician: TechnicianState, nowMs: number): void {
    request.status = 'EN_ROUTE';
    request.technicianId = technician.id;
    request.startedAt = this.state.simulatedTime;
    technician.status = 'EN_ROUTE';
    technician.targetMachineId = request.machineId;

    const route = this.maintenanceRouteFor(request.machineId, technician);
    const repairDurationSeconds = this.repairDurationFor(request.repairType);
    const totalSeconds = 12 * MINUTE + 15 * MINUTE + repairDurationSeconds + 10 * MINUTE;
    request.estimatedCompletion = iso(new Date(nowMs + totalSeconds * 1000));
    this.maintenanceRuntime.set(request.id, { phaseStartedAtMs: nowMs, repairDurationSeconds, route });
    this.addEvent(`${technician.id} assigned to M${String(request.machineId).padStart(2, '0')}.`, request.machineId);
  }

  private completeMaintenance(request: MaintenanceRequest, technician: TechnicianState, nowMs: number): void {
    request.status = 'COMPLETED';
    request.progress = 100;
    request.completedAt = this.state.simulatedTime;
    technician.status = 'RETURNING';
    this.technicianReturnStart.set(technician.id, nowMs);

    const machine = this.state.machines.find((item) => item.id === request.machineId);
    const repairedFault = this.faultFlags.get(request.machineId);
    if (machine) {
      this.faultFlags.delete(machine.id);
      if (machine.status === 'FAULT') machine.status = 'STOPPED';
      machine.failureRisk = 'LOW';
      machine.predictedHealth = 92;
      machine.suspectedFault = 'None detected';
      machine.recommendedAction = machine.status === 'STOPPED' ? 'START' : 'NONE';
      machine.recentAlarms = [];
      machine.maintenanceHistory = [
        `${request.repairType ?? 'Repair'} completed at ${this.shortTime(this.state.simulatedTime)}`,
        ...(machine.maintenanceHistory ?? []),
      ].slice(0, 6);
    }

    for (const alert of this.state.alerts.filter((item) => item.machineId === request.machineId && item.status !== 'RESOLVED')) {
      alert.status = 'RESOLVED';
      alert.resolvedAt = this.state.simulatedTime;
      alert.recommendation = 'NONE';
      alert.detail = 'Maintenance completed and validation passed.';
    }

    this.addEvent(`Machine validation passed for M${String(request.machineId).padStart(2, '0')}.`, request.machineId);
    this.addEvent(`M${String(request.machineId).padStart(2, '0')} ready for restart.`, request.machineId);

    if (repairedFault) {
      this.addAIMessage({
        machineId: request.machineId,
        severity: 'INFO',
        kind: 'PREDICTION',
        title: 'Post-maintenance signal normalized',
        message: `The prior ${repairedFault.toLowerCase()} signal is no longer active after maintenance validation.`,
        recommendedAction: 'Review telemetry before restart',
        confidence: 0.91,
        prominent: true,
      });
    }
  }

  private activeMaintenanceFor(machineId: number): MaintenanceRequest | undefined {
    return this.state.maintenance.find(
      (item) => item.machineId === machineId && item.status !== 'COMPLETED' && item.status !== 'FAILED',
    );
  }

  private repairTypeFor(machineId: number): string {
    const fault = this.faultFlags.get(machineId) ?? '';
    if (fault.includes('Bearing')) return 'REPLACE_BEARING';
    if (fault.includes('Cooling')) return 'REPAIR_COOLING_SYSTEM';
    if (fault.includes('vibration') || fault.includes('friction')) return 'LUBRICATE_DRIVE';
    return 'INSPECT_AND_SERVICE';
  }

  private repairDurationFor(repairType?: string): number {
    switch (repairType) {
      case 'REPLACE_BEARING':
        return 2 * 60 * MINUTE;
      case 'REPAIR_COOLING_SYSTEM':
        return 60 * MINUTE;
      case 'LUBRICATE_DRIVE':
        return 35 * MINUTE;
      default:
        return 25 * MINUTE;
    }
  }

  private maintenanceRouteFor(machineId: number, technician: TechnicianState): Array<{ x: number; y: number }> {
    const placement = machinePositions.find((item) => item.id === machineId);
    const start = { x: technician.x ?? 260, y: technician.y ?? 880 };
    if (!placement) return [start, { x: 300, y: 1030 }, { x: 600, y: 600 }];

    if (placement.zone === 'A') {
      return [
        start,
        { x: 290, y: 1030 },
        { x: 470, y: 1030 },
        { x: 470, y: placement.y + 90 },
        { x: placement.x, y: placement.y + 90 },
      ];
    }
    if (placement.zone === 'B') {
      return [
        start,
        { x: 290, y: 1030 },
        { x: 1040, y: 1030 },
        { x: 1040, y: placement.y + 90 },
        { x: placement.x, y: placement.y + 90 },
      ];
    }
    return [
      start,
      { x: 290, y: 1030 },
      { x: 620, y: 1030 },
      { x: 620, y: placement.y + 90 },
      { x: placement.x, y: placement.y + 90 },
    ];
  }

  private pointAlongRoute(route: Array<{ x: number; y: number }>, progress: number): { x: number; y: number } {
    if (route.length < 2) return route[0] ?? { x: 260, y: 880 };
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < route.length; i += 1) {
      const dx = route[i].x - route[i - 1].x;
      const dy = route[i].y - route[i - 1].y;
      const length = Math.hypot(dx, dy);
      lengths.push(length);
      total += length;
    }

    let remaining = Math.max(0, Math.min(1, progress)) * total;
    for (let i = 0; i < lengths.length; i += 1) {
      const length = lengths[i];
      if (remaining <= length || i === lengths.length - 1) {
        const t = length === 0 ? 0 : Math.min(1, remaining / length);
        return {
          x: route[i].x + (route[i + 1].x - route[i].x) * t,
          y: route[i].y + (route[i + 1].y - route[i].y) * t,
        };
      }
      remaining -= length;
    }
    return route[route.length - 1];
  }

  private demandForHour(hour: number): number {
    if (hour < 7) return 35;
    if (hour < 9) return 48;
    if (hour < 12) return 68;
    if (hour < 15) return 84;
    if (hour < 18) return 92;
    if (hour < 22) return 62;
    return 38;
  }

  private addAIMessage(message: Omit<AIMessage, 'id' | 'timestamp'>): void {
    const entry: AIMessage = {
      ...message,
      id: `ai-${this.eventSequence++}`,
      timestamp: this.state.simulatedTime,
    };
    this.state.aiMessages.unshift(entry);
    this.state.aiMessages = this.state.aiMessages.slice(0, 30);
  }

  private addEvent(message: string, machineId?: number): void {
    this.state.events.unshift({
      id: `event-${this.eventSequence++}`,
      timestamp: this.state.simulatedTime,
      message,
      machineId,
    });
    this.state.events = this.state.events.slice(0, 60);
  }

  private shortTime(value: string): string {
    const date = new Date(value);
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  }

  private emit(): void {
    const snapshot = cloneState(this.state);
    for (const listener of this.listeners) listener(snapshot);
  }
}
