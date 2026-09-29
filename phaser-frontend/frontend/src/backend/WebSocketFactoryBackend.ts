import type { FactoryBackend, MachineCommand, CommandResult } from './FactoryBackend';
import type { FactoryState } from '../models/FactoryState';
import type { MachineState } from '../models/MachineState';

export class WebSocketFactoryBackend implements FactoryBackend {
  private socket?: WebSocket;
  private listeners = new Set<(state: FactoryState) => void>();
  private latestState?: FactoryState;
  private reconnectTimer?: number;

  constructor(
    private readonly wsUrl: string,
    private readonly httpBaseUrl: string,
  ) {
    this.connect();
  }

  async getFactoryState(): Promise<FactoryState> {
    if (this.latestState) return structuredClone(this.latestState);
    const response = await fetch(`${this.httpBaseUrl}/factory/state`);
    if (!response.ok) throw new Error(`Failed to load factory state: ${response.status}`);
    return this.normalizeState((await response.json()) as FactoryState);
  }

  async getMachine(machineId: number): Promise<MachineState> {
    const cached = this.latestState?.machines.find((machine) => machine.id === machineId);
    if (cached) return structuredClone(cached);

    const response = await fetch(`${this.httpBaseUrl}/machines/${machineId}`);
    if (!response.ok) throw new Error(`Failed to load machine ${machineId}: ${response.status}`);
    return (await response.json()) as MachineState;
  }

  async sendCommand(machineId: number, command: MachineCommand, value?: number): Promise<CommandResult> {
    const response = await fetch(`${this.httpBaseUrl}/machines/${machineId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, value }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      return { accepted: false, message: message || `Command rejected: ${response.status}` };
    }
    const payload = (await response.json().catch(() => null)) as Partial<CommandResult> | null;
    return {
      accepted: payload?.accepted ?? true,
      message: payload?.message ?? `${command} acknowledged`,
    };
  }

  async acknowledgeAlert(alertId: string): Promise<void> {
    const response = await fetch(`${this.httpBaseUrl}/alerts/${encodeURIComponent(alertId)}/acknowledge`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error(`Alert acknowledgement rejected: ${response.status}`);
  }

  async setSimulationSpeed(speed: number, paused: boolean): Promise<void> {
    const response = await fetch(`${this.httpBaseUrl}/simulation/speed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed, paused }),
    });
    if (!response.ok) throw new Error(`Simulation speed request rejected: ${response.status}`);
  }

  subscribeToUpdates(callback: (state: FactoryState) => void): () => void {
    this.listeners.add(callback);
    if (this.latestState) callback(structuredClone(this.latestState));
    return () => this.listeners.delete(callback);
  }

  destroy(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.listeners.clear();
  }

  private normalizeState(state: FactoryState): FactoryState {
    return {
      ...state,
      alerts: state.alerts ?? [],
      aiMessages: state.aiMessages ?? [],
      events: state.events ?? [],
      maintenance: state.maintenance ?? [],
      technicians: state.technicians ?? [],
    };
  }

  private connect(): void {
    this.socket = new WebSocket(this.wsUrl);

    this.socket.addEventListener('message', (event) => {
      try {
        const state = this.normalizeState(JSON.parse(event.data) as FactoryState);
        this.latestState = state;
        for (const listener of this.listeners) listener(structuredClone(state));
      } catch (error) {
        console.error('Invalid factory WebSocket payload', error);
      }
    });

    this.socket.addEventListener('close', () => {
      this.reconnectTimer = window.setTimeout(() => this.connect(), 1500);
    });

    this.socket.addEventListener('error', (event) => {
      console.error('Factory WebSocket error', event);
    });
  }
}
