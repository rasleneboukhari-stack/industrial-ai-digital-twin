import Phaser from 'phaser';
import { FACTORY_WORLD } from '../config/factoryConfig';
import { machinePositions } from '../config/machineLayout';
import { machineStatusColor, STATUS_COLORS } from '../config/statusVisuals';
import type { FactoryState } from '../models/FactoryState';

export class MiniMap extends Phaser.GameObjects.Container {
  private readonly dynamic: Phaser.GameObjects.Graphics;
  private factoryState?: FactoryState;
  private playerX = 300;
  private playerY = 640;
  private selectedMachineId?: number;
  private pulseTime = 0;

  private readonly mapX = 10;
  private readonly mapY = 28;
  private readonly mapW = 238;
  private readonly mapH = 134;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(2850);

    const panel = scene.add.rectangle(0, 0, 258, 172, 0x101a20, 0.96).setOrigin(0).setStrokeStyle(1, 0x6b838e);
    const title = scene.add.text(10, 8, 'FACTORY MAP  [M]', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#cfe0e6',
      fontStyle: 'bold',
    });
    const staticGraphics = scene.add.graphics();
    this.drawStatic(staticGraphics);
    this.dynamic = scene.add.graphics();

    this.add([panel, title, staticGraphics, this.dynamic]);
  }

  setFactoryState(state: FactoryState): void {
    this.factoryState = state;
    this.redraw();
  }

  setPlayerPosition(x: number, y: number): void {
    this.playerX = x;
    this.playerY = y;
  }

  setSelectedMachine(machineId?: number): void {
    this.selectedMachineId = machineId;
    this.redraw();
  }

  tick(deltaMs: number): void {
    this.pulseTime += deltaMs;
    this.redraw();
  }

  private drawStatic(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x17242b, 1).fillRect(this.mapX, this.mapY, this.mapW, this.mapH);
    g.lineStyle(1, 0x78919a, 0.65).strokeRect(this.mapX, this.mapY, this.mapW, this.mapH);

    this.zoneRect(g, 440, 110, 560, 390, 0x263c42);
    this.zoneRect(g, 1060, 110, 580, 390, 0x2a3947);
    this.zoneRect(g, 650, 610, 560, 340, 0x34402f);
    this.zoneRect(g, 50, 70, 320, 300, 0x373141);
    this.zoneRect(g, 50, 760, 390, 250, 0x41382f);
    this.zoneRect(g, 1510, 720, 350, 290, 0x303b45);

    g.lineStyle(1, 0xd1ae4c, 0.28);
    g.lineBetween(this.wx(420), this.wy(560), this.wx(1680), this.wy(560));
    g.lineBetween(this.wx(620), this.wy(1030), this.wx(1500), this.wy(1030));
  }

  private redraw(): void {
    const state = this.factoryState;
    if (!state) return;
    const g = this.dynamic;
    g.clear();

    const activeMaintenance = new Set(
      state.maintenance
        .filter((item) => item.status !== 'COMPLETED' && item.status !== 'FAILED')
        .map((item) => item.machineId),
    );

    for (const placement of machinePositions) {
      const machine = state.machines.find((item) => item.id === placement.id);
      if (!machine) continue;
      const color = machineStatusColor(machine, activeMaintenance.has(machine.id));
      const x = this.wx(placement.x);
      const y = this.wy(placement.y);
      const highAlert = state.alerts.some(
        (alert) => alert.machineId === machine.id && alert.status !== 'RESOLVED' && (alert.severity === 'HIGH' || alert.severity === 'CRITICAL'),
      );
      if (highAlert) {
        const pulse = 0.25 + (Math.sin(this.pulseTime / 260) + 1) * 0.16;
        g.lineStyle(1, color, pulse + 0.25).strokeCircle(x, y, 4.5);
      }
      g.fillStyle(color, 1).fillRect(x - 2, y - 2, 4, 4);
      if (this.selectedMachineId === machine.id) {
        g.lineStyle(1, 0xeefcff, 0.95).strokeRect(x - 4, y - 4, 8, 8);
      }
    }

    for (const technician of state.technicians) {
      if (technician.x === undefined || technician.y === undefined) continue;
      const x = this.wx(technician.x);
      const y = this.wy(technician.y);
      g.fillStyle(STATUS_COLORS.technician, 1).fillCircle(x, y, 2.2);
      g.lineStyle(1, 0x102029, 1).strokeCircle(x, y, 2.2);
    }

    const px = this.wx(this.playerX);
    const py = this.wy(this.playerY);
    g.fillStyle(STATUS_COLORS.player, 1);
    g.fillTriangle(px, py - 4, px + 4, py + 3, px - 4, py + 3);
    g.lineStyle(1, 0x3ba7b6, 1).strokeTriangle(px, py - 4, px + 4, py + 3, px - 4, py + 3);
  }

  private zoneRect(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, color: number): void {
    g.fillStyle(color, 0.6).fillRect(this.wx(x), this.wy(y), this.wsx(w), this.wsy(h));
    g.lineStyle(1, 0x71848c, 0.26).strokeRect(this.wx(x), this.wy(y), this.wsx(w), this.wsy(h));
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
