import Phaser from 'phaser';
import type { FactoryState } from '../models/FactoryState';
import { PixelButton } from './PixelButton';

export class FactoryOverview extends Phaser.GameObjects.Container {
  private readonly bodyText: Phaser.GameObjects.Text;
  private factoryState?: FactoryState;

  constructor(scene: Phaser.Scene, private readonly onClose: () => void) {
    super(scene, 0, 0);
    scene.add.existing(this);
    this.setDepth(3100);

    const panel = scene.add.rectangle(0, 0, 740, 520, 0x101c24, 0.985).setOrigin(0.5).setStrokeStyle(2, 0x829aa5);
    const title = scene.add.text(-345, -235, 'CONTROL ROOM — FACTORY OVERVIEW', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#e5f0f4',
      fontStyle: 'bold',
    });
    this.bodyText = scene.add.text(-345, -195, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#cbdce3',
      lineSpacing: 4,
      wordWrap: { width: 680 },
    });
    const close = new PixelButton(scene, 330, -230, 36, 28, 'X', () => this.hide(), 0x55343b);

    this.add([panel, title, this.bodyText, close]);
    this.setVisible(false);
  }

  show(state: FactoryState, x: number, y: number): void {
    this.factoryState = state;
    this.setPosition(x, y);
    this.setVisible(true);
    this.render();
  }

  hide(): void {
    if (!this.visible) return;
    this.setVisible(false);
    this.onClose();
  }

  setFactoryState(state: FactoryState): void {
    this.factoryState = state;
    if (this.visible) this.render();
  }

  private render(): void {
    if (!this.factoryState) return;
    const state = this.factoryState;
    const running = state.machines.filter((machine) => machine.status === 'RUNNING').length;
    const stopped = state.machines.filter((machine) => machine.status === 'STOPPED').length;
    const fault = state.machines.filter((machine) => machine.status === 'FAULT').length;
    const offline = state.machines.filter((machine) => machine.status === 'OFFLINE').length;
    const warnings = state.machines.filter((machine) => machine.failureRisk === 'MEDIUM').length;
    const highRisk = state.machines.filter((machine) => machine.failureRisk === 'HIGH' || machine.failureRisk === 'CRITICAL').length;
    const riskiest = [...state.machines].sort((a, b) => this.riskScore(b.failureRisk) - this.riskScore(a.failureRisk))[0];
    const date = new Date(state.simulatedTime);
    const time = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
    const speed = state.paused ? 'PAUSED' : state.simulationSpeed === 10000 ? '10Kx' : `${state.simulationSpeed}x`;

    const recent = state.events
      .slice(0, 8)
      .map((event) => `${this.shortTime(event.timestamp)}  ${event.message}`)
      .join('\n');

    this.bodyText.setText([
      `Simulation           DAY ${String(state.simulationDay).padStart(2, '0')}  ${time}  ${speed}`,
      `Operating mode       ${state.operatingMode}`,
      `Production demand    ${state.demand.toFixed(0)} %`,
      `Factory output       ${state.productionOutput.toFixed(0)} units/h`,
      `Ambient temperature  ${state.ambientTemperature.toFixed(1)} °C`,
      '',
      `RUNNING ${String(running).padStart(2)}    STOPPED ${String(stopped).padStart(2)}    FAULT ${String(fault).padStart(2)}    OFFLINE ${String(offline).padStart(2)}`,
      `Warnings ${String(warnings).padStart(2)}  High/Critical risk ${String(highRisk).padStart(2)}`,
      `Highest risk         M${String(riskiest?.id ?? 0).padStart(2, '0')} (${riskiest?.failureRisk ?? 'N/A'})`,
      `Maintenance active   ${state.maintenance.filter((item) => item.status !== 'COMPLETED' && item.status !== 'FAILED').length}`,
      '',
      'RECENT EVENTS',
      '-------------',
      recent || 'No recent events',
    ]);
  }

  private riskScore(risk?: string): number {
    return { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[risk ?? 'LOW'] ?? 0;
  }

  private shortTime(value: string): string {
    const date = new Date(value);
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  }
}
