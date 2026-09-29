import Phaser from 'phaser';
import type { TechnicianState } from '../models/Maintenance';

export class TechnicianView {
  readonly id: string;
  readonly container: Phaser.GameObjects.Container;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly label: Phaser.GameObjects.Text;
  private readonly task: Phaser.GameObjects.Text;
  private targetX: number;
  private targetY: number;
  private state: TechnicianState;

  constructor(scene: Phaser.Scene, state: TechnicianState) {
    this.id = state.id;
    this.state = structuredClone(state);
    this.targetX = state.x ?? 260;
    this.targetY = state.y ?? 880;

    this.sprite = scene.add.sprite(0, 0, 'worker', 0).setScale(2).setTint(0x93ddff);
    this.label = scene.add.text(0, 29, state.id, {
      fontFamily: 'monospace',
      fontSize: '9px',
      color: '#9fe5ff',
      backgroundColor: '#102029cc',
      padding: { x: 2, y: 1 },
    }).setOrigin(0.5);
    this.task = scene.add.text(0, -30, '', {
      fontFamily: 'monospace',
      fontSize: '8px',
      color: '#b8d8e5',
      backgroundColor: '#102029bb',
      padding: { x: 2, y: 1 },
    }).setOrigin(0.5);

    this.container = scene.add.container(this.targetX, this.targetY, [this.sprite, this.label, this.task]);
    this.container.setDepth(this.targetY + 5);
    this.applyState();
  }

  setState(state: TechnicianState): void {
    this.state = structuredClone(state);
    this.targetX = state.x ?? this.targetX;
    this.targetY = state.y ?? this.targetY;
    this.applyState();
  }

  update(deltaMs: number): void {
    const dx = this.targetX - this.container.x;
    const dy = this.targetY - this.container.y;
    const distance = Math.hypot(dx, dy);
    const smoothing = 1 - Math.exp(-deltaMs / 120);
    this.container.x += dx * smoothing;
    this.container.y += dy * smoothing;
    this.container.setDepth(this.container.y + 5);

    const moving = distance > 2 && (this.state.status === 'EN_ROUTE' || this.state.status === 'RETURNING');
    if (!moving) {
      this.sprite.anims.stop();
      return;
    }

    if (Math.abs(dx) > Math.abs(dy)) this.sprite.play(dx < 0 ? 'walk-left' : 'walk-right', true);
    else this.sprite.play(dy < 0 ? 'walk-up' : 'walk-down', true);
  }

  private applyState(): void {
    const showTask = this.state.status !== 'AVAILABLE';
    this.task.setVisible(showTask);
    this.task.setText(
      this.state.targetMachineId
        ? `${this.state.status.replace('_', ' ')} · M${String(this.state.targetMachineId).padStart(2, '0')}`
        : this.state.status,
    );

    if (this.state.status === 'REPAIRING') this.sprite.setTint(0x7fcfff);
    else if (this.state.status === 'TESTING') this.sprite.setTint(0xb0e8ff);
    else this.sprite.setTint(0x93ddff);
  }
}
