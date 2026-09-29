import Phaser from 'phaser';
import type { FactoryBackend } from '../backend/FactoryBackend';
import type { FactoryState } from '../models/FactoryState';
import { PixelButton } from './PixelButton';

const SPEEDS = [0, 1, 10, 60, 600, 10000] as const;

export class TimeControls extends Phaser.GameObjects.Container {
  private readonly timeText: Phaser.GameObjects.Text;
  private readonly statusText: Phaser.GameObjects.Text;
  private readonly buttons = new Map<number, PixelButton>();

  constructor(scene: Phaser.Scene, x: number, y: number, private readonly backend: FactoryBackend) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(2900);

    const panel = scene.add.rectangle(0, 0, 412, 112, 0x12202a, 0.96).setOrigin(0).setStrokeStyle(1, 0x6f8996);
    this.timeText = scene.add.text(12, 10, 'DAY --  --:--', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#e8f3f6',
    });
    this.statusText = scene.add.text(12, 36, 'Demand --%  Output --- u/h  Ambient --°C', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#9ab0ba',
    });

    this.add([panel, this.timeText, this.statusText]);

    SPEEDS.forEach((speed, index) => {
      const label = speed === 0 ? 'PAUSE' : speed === 10000 ? '10Kx' : `${speed}x`;
      const button = new PixelButton(scene, 39 + index * 66, 82, 58, 28, label, () => {
        void this.backend.setSimulationSpeed(speed === 0 ? 0 : speed, speed === 0);
      });
      this.buttons.set(speed, button);
      this.add(button);
    });
  }

  updateState(state: FactoryState): void {
    const date = new Date(state.simulatedTime);
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const speedLabel = state.simulationSpeed === 10000 ? '10Kx' : `${state.simulationSpeed}x`;
    this.timeText.setText(`DAY ${String(state.simulationDay).padStart(2, '0')}  ${hh}:${mm}  ${state.paused ? 'PAUSED' : speedLabel}`);
    this.statusText.setText(
      `Demand ${state.demand.toFixed(0)}%   Output ${state.productionOutput.toFixed(0)} u/h   Ambient ${state.ambientTemperature.toFixed(1)}°C`,
    );

    for (const [speed, button] of this.buttons) {
      button.setActiveStyle(state.paused ? speed === 0 : speed === state.simulationSpeed);
    }
  }
}
