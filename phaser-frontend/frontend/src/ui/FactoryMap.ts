import Phaser from 'phaser';
import { FACTORY_WORLD } from '../config/factoryConfig';
import { machinePositions } from '../config/machineLayout';
import { machineStatusColor, STATUS_COLORS } from '../config/statusVisuals';
import type { FactoryState } from '../models/FactoryState';
import { PixelButton } from './PixelButton';

interface Marker {
  dot: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
}

export class FactoryMap extends Phaser.GameObjects.Container {
  private factoryState?: FactoryState;
  private selectedMachineId?: number;
  private playerX = 300;
  private playerY = 640;
  private readonly machineMarkers = new Map<number, Marker>();
  private readonly technicianMarkers = new Map<string, Marker>();
  private readonly playerMarker: Phaser.GameObjects.Rectangle;
  private readonly subtitle: Phaser.GameObjects.Text;

  private readonly mapX = -430;
  private readonly mapY = -230;
  private readonly mapW = 760;
  private readonly mapH = 428;

  constructor(
    scene: Phaser.Scene,
    onClose: () => void,
    private readonly onSelectMachine: (machineId: number) => void,
  ) {
    super(scene, 0, 0);
    scene.add.existing(this);
    this.setDepth(3200);

    const panel = scene.add.rectangle(0, 0, 960, 620, 0x0d171d, 0.985).setOrigin(0.5).setStrokeStyle(2, 0x8299a4);
    const title = scene.add.text(-430, -286, 'FACTORY OVERVIEW MAP', {
      fontFamily: 'monospace',
      fontSize: '19px',
      color: '#e5f0f4',
      fontStyle: 'bold',
    });
    this.subtitle = scene.add.text(-430, -258, 'M toggles map · click a machine to select · no fast travel', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#88a0aa',
    });
    const close = new PixelButton(scene, 430, -282, 42, 28, 'X', onClose, 0x55343b);

    const mapBg = scene.add.rectangle(this.mapX, this.mapY, this.mapW, this.mapH, 0x16242b, 1).setOrigin(0).setStrokeStyle(1, 0x657d87);
    this.add([panel, title, this.subtitle, close, mapBg]);

    this.addZone('ZONE A', 440, 110, 560, 390, 0x263c42);
    this.addZone('ZONE B', 1060, 110, 580, 390, 0x2a3947);
    this.addZone('ZONE C', 650, 610, 560, 340, 0x34402f);
    this.addZone('CONTROL ROOM', 50, 70, 320, 300, 0x373141, 9);
    this.addZone('MAINTENANCE', 50, 760, 390, 250, 0x41382f, 9);
    this.addZone('SERVER / ELECTRICAL', 1510, 720, 350, 290, 0x303b45, 9);

    for (const placement of machinePositions) {
      const x = this.wx(placement.x);
      const y = this.wy(placement.y);
      const dot = scene.add.rectangle(x, y, 12, 9, 0x55c977).setStrokeStyle(1, 0x152229).setInteractive({ useHandCursor: true });
      const label = scene.add.text(x + 8, y - 6, `M${String(placement.id).padStart(2, '0')}`, {
        fontFamily: 'monospace',
        fontSize: '8px',
        color: '#c9d9df',
      });
      dot.on('pointerdown', () => this.onSelectMachine(placement.id));
      this.machineMarkers.set(placement.id, { dot, label });
      this.add([dot, label]);
    }

    this.playerMarker = scene.add.rectangle(this.wx(300), this.wy(640), 10, 10, STATUS_COLORS.player).setRotation(Math.PI / 4).setStrokeStyle(1, 0x3ba7b6);
    this.add(this.playerMarker);

    this.createLegend(scene);
    this.setVisible(false);
  }

  show(state: FactoryState, x: number, y: number): void {
    this.factoryState = state;
    this.setPosition(x, y);
    this.setVisible(true);
    this.render();
  }

  hide(): void {
    this.setVisible(false);
  }

  toggle(state: FactoryState | undefined, x: number, y: number): void {
    if (this.visible) {
      this.hide();
      return;
    }
    if (state) this.show(state, x, y);
  }

  setFactoryState(state: FactoryState): void {
    this.factoryState = state;
    if (this.visible) this.render();
  }

  setPlayerPosition(x: number, y: number): void {
    this.playerX = x;
    this.playerY = y;
    if (this.visible) this.renderPlayer();
  }

  setSelectedMachine(machineId?: number): void {
    this.selectedMachineId = machineId;
    if (this.visible) this.render();
  }

  private render(): void {
    if (!this.factoryState) return;
    const activeMaintenance = new Set(
      this.factoryState.maintenance
        .filter((item) => item.status !== 'COMPLETED' && item.status !== 'FAILED')
        .map((item) => item.machineId),
    );

    for (const machine of this.factoryState.machines) {
      const marker = this.machineMarkers.get(machine.id);
      if (!marker) continue;
      marker.dot.setFillStyle(machineStatusColor(machine, activeMaintenance.has(machine.id)));
      marker.dot.setStrokeStyle(this.selectedMachineId === machine.id ? 2 : 1, this.selectedMachineId === machine.id ? 0xeefcff : 0x152229);
      marker.dot.setScale(this.selectedMachineId === machine.id ? 1.25 : 1);
      marker.label.setColor(this.selectedMachineId === machine.id ? '#ffffff' : '#c9d9df');
    }

    for (const tech of this.factoryState.technicians) {
      if (tech.x === undefined || tech.y === undefined) continue;
      let marker = this.technicianMarkers.get(tech.id);
      if (!marker) {
        const dot = this.scene.add.rectangle(0, 0, 8, 8, STATUS_COLORS.technician).setRotation(Math.PI / 4).setStrokeStyle(1, 0x17313c);
        const label = this.scene.add.text(0, 0, tech.id, { fontFamily: 'monospace', fontSize: '8px', color: '#8edfff' });
        marker = { dot, label };
        this.technicianMarkers.set(tech.id, marker);
        this.add([dot, label]);
      }
      const x = this.wx(tech.x);
      const y = this.wy(tech.y);
      marker.dot.setPosition(x, y);
      marker.label.setPosition(x + 7, y - 5).setText(tech.id);
    }

    this.renderPlayer();
    this.subtitle.setText(
      `DAY ${String(this.factoryState.simulationDay).padStart(2, '0')} · ${this.factoryState.operatingMode} · Demand ${this.factoryState.demand.toFixed(0)}% · click machine for inspection`,
    );
  }

  private renderPlayer(): void {
    this.playerMarker.setPosition(this.wx(this.playerX), this.wy(this.playerY));
  }

  private addZone(label: string, x: number, y: number, w: number, h: number, color: number, fontSize = 10): void {
    const rect = this.scene.add.rectangle(this.wx(x), this.wy(y), this.wsx(w), this.wsy(h), color, 0.7).setOrigin(0).setStrokeStyle(1, 0x71848c, 0.5);
    const text = this.scene.add.text(this.wx(x) + 5, this.wy(y) + 4, label, {
      fontFamily: 'monospace',
      fontSize: `${fontSize}px`,
      color: '#9fb3bc',
      backgroundColor: '#101a20aa',
      padding: { x: 2, y: 1 },
    });
    this.add([rect, text]);
  }

  private createLegend(scene: Phaser.Scene): void {
    const entries: Array<[string, number]> = [
      ['Healthy', STATUS_COLORS.healthy],
      ['Warning', STATUS_COLORS.warning],
      ['High Risk', STATUS_COLORS.high],
      ['Fault', STATUS_COLORS.critical],
      ['Stopped', STATUS_COLORS.stopped],
      ['Offline', STATUS_COLORS.offline],
      ['Maintenance', STATUS_COLORS.maintenance],
    ];
    const startX = 352;
    const startY = -202;
    const legendTitle = scene.add.text(startX, startY - 24, 'LEGEND', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#cbdbe1',
      fontStyle: 'bold',
    });
    this.add(legendTitle);
    entries.forEach(([label, color], index) => {
      const y = startY + index * 28;
      const dot = scene.add.circle(startX + 5, y + 5, 5, color).setStrokeStyle(1, 0x111c22);
      const text = scene.add.text(startX + 18, y - 1, label, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#aebfc6',
      });
      this.add([dot, text]);
    });
    const operator = scene.add.rectangle(startX + 5, 20, 8, 8, STATUS_COLORS.player).setRotation(Math.PI / 4);
    const operatorText = scene.add.text(startX + 18, 14, 'Operator', { fontFamily: 'monospace', fontSize: '10px', color: '#aebfc6' });
    const tech = scene.add.rectangle(startX + 5, 48, 8, 8, STATUS_COLORS.technician).setRotation(Math.PI / 4);
    const techText = scene.add.text(startX + 18, 42, 'Technician', { fontFamily: 'monospace', fontSize: '10px', color: '#aebfc6' });
    this.add([operator, operatorText, tech, techText]);
  }

  private wx(value: number): number {
    return this.mapX + (value / FACTORY_WORLD.width) * this.mapW;
  }

  private wy(value: number): number {
    return this.mapY + (value / FACTORY_WORLD.height) * this.mapH;
  }

  private wsx(value: number): number {
    return (value / FACTORY_WORLD.width) * this.mapW;
  }

  private wsy(value: number): number {
    return (value / FACTORY_WORLD.height) * this.mapH;
  }
}
