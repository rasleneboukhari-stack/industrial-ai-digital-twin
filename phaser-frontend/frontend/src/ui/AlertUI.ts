import Phaser from 'phaser';
import type { Alert } from '../models/Alert';

export class AlertUI extends Phaser.GameObjects.Container {
  private latestMachineId?: number;
  private readonly icon: Phaser.GameObjects.Rectangle;
  private readonly countText: Phaser.GameObjects.Text;
  private readonly latestText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, x: number, y: number, onOpenMachineAlert: (machineId?: number) => void) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(2900);

    const panel = scene.add.rectangle(0, 0, 190, 38, 0x14212b, 0.82).setOrigin(0).setStrokeStyle(1, 0x536b76);
    panel.setInteractive({ useHandCursor: true }).on('pointerdown', () => {
      scene.game.events.emit('ui-click');
      onOpenMachineAlert(this.latestMachineId);
    });

    this.icon = scene.add.rectangle(8, 10, 18, 18, 0x53cf74).setOrigin(0);
    this.countText = scene.add.text(12, 12, '0', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#101820',
      fontStyle: 'bold',
    });
    this.latestText = scene.add.text(34, 11, 'SYSTEM · clear', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#d8e6ec',
      wordWrap: { width: 150 },
      maxLines: 1,
    });

    this.add([panel, this.icon, this.countText, this.latestText]);
  }

  updateAlerts(alerts: Alert[]): void {
    const unresolved = alerts.filter((alert) => alert.status !== 'RESOLVED');
    const affectedMachines = new Set(unresolved.map((alert) => alert.machineId)).size;
    const critical = unresolved.some((alert) => alert.severity === 'CRITICAL');
    const high = unresolved.some((alert) => alert.severity === 'HIGH');
    this.countText.setText(String(affectedMachines));
    this.icon.setFillStyle(critical ? 0xe35d5d : high ? 0xe98b45 : unresolved.length > 0 ? 0xe6bd52 : 0x55c977);

    const latest = unresolved[0];
    this.latestMachineId = latest?.machineId;
    this.latestText.setText(latest
      ? `SYSTEM · ${affectedMachines} machines`
      : 'SYSTEM · clear');
  }
}
