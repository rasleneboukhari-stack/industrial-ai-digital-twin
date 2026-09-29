import Phaser from 'phaser';
import { machineStatusColor, STATUS_COLORS } from '../config/statusVisuals';
import type { MachineState } from '../models/MachineState';

export class MachineView {
  readonly container: Phaser.GameObjects.Container;
  readonly id: number;

  private readonly base: Phaser.GameObjects.Image;
  private readonly fanA: Phaser.GameObjects.Image;
  private readonly fanB: Phaser.GameObjects.Image;
  private readonly lamp: Phaser.GameObjects.Rectangle;
  private readonly label: Phaser.GameObjects.Text;
  private readonly product: Phaser.GameObjects.Rectangle;
  private readonly selection: Phaser.GameObjects.Graphics;
  private readonly heatPixels: Phaser.GameObjects.Rectangle[];
  private readonly faultMark: Phaser.GameObjects.Text;
  private readonly maintenanceMark: Phaser.GameObjects.Text;
  private state: MachineState;
  private visualTime = 0;
  private selected = false;
  private underMaintenance = false;

  constructor(scene: Phaser.Scene, x: number, y: number, state: MachineState) {
    this.id = state.id;
    this.state = structuredClone(state);

    this.selection = scene.add.graphics();
    this.selection.lineStyle(1, 0xeefcff, 0.9);
    this.selection.strokeRect(-53, -37, 106, 74);
    this.selection.setVisible(false);

    this.base = scene.add.image(0, 0, 'machine');
    this.fanA = scene.add.image(-24, -7, 'fan').setScale(1.05);
    this.fanB = scene.add.image(24, -7, 'fan').setScale(1.05);
    this.lamp = scene.add.rectangle(35, -23, 7, 7, STATUS_COLORS.healthy).setStrokeStyle(1, 0x101820);
    this.product = scene.add.rectangle(-35, 21, 10, 5, 0xbfd58a);
    this.label = scene.add
      .text(0, 42, `M${String(state.id).padStart(2, '0')}`, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#dbe9ee',
        backgroundColor: '#132028',
        padding: { x: 3, y: 1 },
      })
      .setOrigin(0.5);

    this.faultMark = scene.add.text(-43, -28, '!', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#ffe7e7',
      backgroundColor: '#b94242',
      padding: { x: 2, y: 0 },
    }).setOrigin(0.5).setVisible(false);

    this.maintenanceMark = scene.add.text(-42, -27, 'T', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#e2f8ff',
      backgroundColor: '#417a8e',
      padding: { x: 2, y: 1 },
    }).setOrigin(0.5).setVisible(false);

    this.heatPixels = [
      scene.add.rectangle(-18, -32, 2, 3, 0xf0a04b, 0.6),
      scene.add.rectangle(2, -34, 2, 3, 0xf0a04b, 0.55),
      scene.add.rectangle(22, -31, 2, 3, 0xf0a04b, 0.5),
    ];

    this.container = scene.add.container(x, y, [
      this.selection,
      this.base,
      this.fanA,
      this.fanB,
      this.product,
      this.lamp,
      ...this.heatPixels,
      this.faultMark,
      this.maintenanceMark,
      this.label,
    ]);
    this.container.setDepth(y);
    this.applyState(state);
  }

  setState(state: MachineState): void {
    this.state = structuredClone(state);
    this.applyState(state);
  }

  setSelected(selected: boolean): void {
    this.selected = selected;
    this.selection.setVisible(selected);
  }

  setMaintenance(active: boolean): void {
    this.underMaintenance = active;
    this.applyState(this.state);
  }

  update(deltaMs: number): void {
    this.visualTime += deltaMs / 1000;
    const running = this.state.status === 'RUNNING';

    if (running) {
      const rpmFactor = Phaser.Math.Clamp(this.state.rpm / 3000, 0.08, 1.3);
      this.base.setScale(1 + Math.sin(this.visualTime * 11 * rpmFactor) * 0.006, 1);
      const travel = ((this.visualTime * (10 + this.state.load * 0.34)) % 64) - 32;
      this.product.setX(travel);
      this.product.setVisible(this.state.load > 8);
    } else {
      this.base.setScale(1);
      this.product.setVisible(false);
    }

    // Cooling fans are presentation only and may continue after STOP while cooling remains active.
    if (this.state.status !== 'OFFLINE' && this.state.coolingSetpoint > 0) {
      const fanFactor = Phaser.Math.Clamp(this.state.coolingSetpoint / 100, 0.05, 1.2);
      this.fanA.rotation += 0.05 * fanFactor * (deltaMs / 16.67);
      this.fanB.rotation -= 0.05 * fanFactor * (deltaMs / 16.67);
    }

    const shake = running && this.state.vibration > 0.48 ? Math.min(1.8, (this.state.vibration - 0.48) * 3.5) : 0;
    this.base.setX(shake === 0 ? 0 : Math.sin(this.visualTime * 38) * shake);

    const hot = this.state.temperature >= 78 && this.state.status !== 'OFFLINE';
    this.heatPixels.forEach((pixel, index) => {
      pixel.setVisible(hot);
      if (!hot) return;
      const cycle = (this.visualTime * 12 + index * 9) % 22;
      pixel.setY(-28 - cycle);
      pixel.setAlpha(Math.max(0.1, 0.65 - cycle / 35));
    });

    if (this.selected) {
      const alpha = 0.55 + (Math.sin(this.visualTime * 4) + 1) * 0.18;
      this.selection.setAlpha(alpha);
    }
  }

  distanceTo(x: number, y: number): number {
    return Phaser.Math.Distance.Between(this.container.x, this.container.y, x, y);
  }

  getState(): MachineState {
    return structuredClone(this.state);
  }

  private applyState(state: MachineState): void {
    const color = machineStatusColor(state, this.underMaintenance);
    this.lamp.setFillStyle(color);
    this.base.setAlpha(state.status === 'OFFLINE' ? 0.6 : 1);
    this.fanA.setAlpha(state.status === 'OFFLINE' ? 0.3 : 1);
    this.fanB.setAlpha(state.status === 'OFFLINE' ? 0.3 : 1);
    this.faultMark.setVisible(state.status === 'FAULT');
    this.maintenanceMark.setVisible(this.underMaintenance && state.status !== 'FAULT');
  }
}
