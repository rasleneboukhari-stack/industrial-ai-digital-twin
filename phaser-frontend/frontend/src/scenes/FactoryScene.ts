import Phaser from 'phaser';
import type { FactoryBackend } from '../backend/FactoryBackend';
import { FACTORY_WORLD } from '../config/factoryConfig';
import { machinePositions } from '../config/machineLayout';
import { MachineView } from '../entities/MachineView';
import { Player } from '../entities/Player';
import { TechnicianView } from '../entities/TechnicianView';
import { mqttTelemetry } from '../services/MqttTelemetryService';
import type { FactoryState } from '../models/FactoryState';

export class FactoryScene extends Phaser.Scene {
  private backend!: FactoryBackend;
  private player!: Player;
  private obstacles!: Phaser.Physics.Arcade.StaticGroup;
  private readonly machineViews = new Map<number, MachineView>();
  private readonly technicianViews = new Map<string, TechnicianView>();
  private latestState?: FactoryState;
  private unsubscribe?: () => void;
  private unsubscribeTelemetry?: () => void;
  private interactKey!: Phaser.Input.Keyboard.Key;
  private phoneKey!: Phaser.Input.Keyboard.Key;
  private mapKey!: Phaser.Input.Keyboard.Key;
  private nearbyMachineId?: number;
  private selectedMachineId?: number;
  private readonly controlConsole = new Phaser.Math.Vector2(220, 190);
  private uiBlocked = false;
  private readonly ventilationFans: Phaser.GameObjects.Image[] = [];
  private readonly cabinetLights: Phaser.GameObjects.Rectangle[] = [];
  private readonly conveyorItems: Phaser.GameObjects.Rectangle[] = [];
  private ambienceTime = 0;


  private readonly onUiBlockChanged = (blocked: boolean) => {
    this.uiBlocked = blocked;
  };
  private readonly onSelectedMachineChanged = (machineId?: number) => {
    this.selectedMachineId = machineId;
    for (const [id, machine] of this.machineViews) machine.setSelected(id === machineId);
  };

  constructor() {
    super('FactoryScene');
  }

  create(): void {
    this.backend = this.registry.get('factoryBackend') as FactoryBackend;
    this.physics.world.setBounds(0, 0, FACTORY_WORLD.width, FACTORY_WORLD.height);
    this.cameras.main.setBounds(0, 0, FACTORY_WORLD.width, FACTORY_WORLD.height);
    this.cameras.main.setZoom(1.35);
    this.cameras.main.roundPixels = true;

    this.buildWorld();
    this.obstacles = this.physics.add.staticGroup();
    this.buildCollisions();

    this.player = new Player(this, 300, 640);
    this.physics.add.collider(this.player, this.obstacles);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);

    if (!this.input.keyboard) throw new Error('Keyboard input is unavailable');
    this.interactKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.phoneKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.P);
    this.mapKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M);

    mqttTelemetry.start();

    this.unsubscribe = this.backend.subscribeToUpdates((state) => {
      const mergedState =
          mqttTelemetry.mergeState(state);

      this.latestState = mergedState;

      this.syncMachines(mergedState);
      this.syncTechnicians(mergedState);
    });

    this.unsubscribeTelemetry =
        mqttTelemetry.subscribe((telemetry) => {
          if (!this.latestState) return;

          const machine =
              this.latestState.machines.find(
                  (item) => item.id === telemetry.id
              );

          if (!machine) return;

          mqttTelemetry.applyTelemetry(
              machine,
              telemetry
          );

          this.syncMachines(
              this.latestState
          );
        });

    this.game.events.on('ui-block-changed', this.onUiBlockChanged);
    this.game.events.on('selected-machine-changed', this.onSelectedMachineChanged);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.unsubscribeTelemetry?.();
      this.game.events.off('ui-block-changed', this.onUiBlockChanged);
      this.game.events.off('selected-machine-changed', this.onSelectedMachineChanged);

    });
  }

  update(_time: number, delta: number): void {
    this.player.update(!this.uiBlocked);
    for (const machine of this.machineViews.values()) machine.update(delta);
    for (const technician of this.technicianViews.values()) technician.update(delta);
    this.updateFactoryAmbience(delta);

    this.game.events.emit('player-position', this.player.x, this.player.y);
    this.game.events.emit('player-motion', this.player.isMoving());

    if (!this.uiBlocked) this.updateInteractionTarget();

    if (!this.uiBlocked && Phaser.Input.Keyboard.JustDown(this.interactKey)) {
      if (this.nearbyMachineId !== undefined) {
        this.game.events.emit('inspect-machine', this.nearbyMachineId);
      } else if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this.controlConsole.x, this.controlConsole.y) < 115) {
        this.game.events.emit('open-factory-overview');
      }
    }

    if (Phaser.Input.Keyboard.JustDown(this.phoneKey)) this.game.events.emit('toggle-phone');
    if (Phaser.Input.Keyboard.JustDown(this.mapKey)) this.game.events.emit('toggle-factory-map');
  }

  private buildWorld(): void {
    this.add.tileSprite(FACTORY_WORLD.width / 2, FACTORY_WORLD.height / 2, FACTORY_WORLD.width, FACTORY_WORLD.height, 'floor').setDepth(-100);

    this.add.tileSprite(FACTORY_WORLD.width / 2, 16, FACTORY_WORLD.width, 32, 'wall').setDepth(30);
    this.add.tileSprite(FACTORY_WORLD.width / 2, FACTORY_WORLD.height - 16, FACTORY_WORLD.width, 32, 'wall').setDepth(30);
    this.add.tileSprite(16, FACTORY_WORLD.height / 2, 32, FACTORY_WORLD.height, 'wall').setDepth(30);
    this.add.tileSprite(FACTORY_WORLD.width - 16, FACTORY_WORLD.height / 2, 32, FACTORY_WORLD.height, 'wall').setDepth(30);

    this.drawRoom(50, 70, 320, 300, 'CONTROL ROOM');
    this.add.image(220, 190, 'console').setScale(2).setDepth(150);
    this.add.image(100, 145, 'cabinet').setScale(1.5).setDepth(145);
    this.add.image(100, 235, 'cabinet').setScale(1.5).setDepth(235);
    this.add.rectangle(260, 115, 78, 30, 0x1a303b, 1).setStrokeStyle(1, 0x5f7782).setDepth(116);
    this.add.text(225, 108, 'PLC / HMI', { fontFamily: 'monospace', fontSize: '8px', color: '#65d1bd' }).setDepth(118);

    this.drawRoom(50, 760, 390, 250, 'MAINTENANCE');
    this.add.image(125, 865, 'pallet').setScale(1.5).setDepth(865);
    this.add.image(205, 860, 'crate').setScale(1.6).setDepth(860);
    this.add.image(260, 860, 'crate').setScale(1.6).setDepth(860);
    this.add.image(355, 850, 'cabinet').setScale(1.5).setDepth(850);
    this.add.rectangle(290, 930, 150, 16, 0x6d5a3a, 1).setStrokeStyle(1, 0x2b2520).setDepth(930);
    this.add.text(235, 917, 'TOOL BENCH', { fontFamily: 'monospace', fontSize: '8px', color: '#c5b18a' }).setDepth(932);

    this.drawRoom(1510, 720, 350, 290, 'SERVER / ELECTRICAL');
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        const x = 1580 + col * 90;
        const y = 820 + row * 90;
        this.add.image(x, y, 'cabinet').setScale(1.5).setDepth(y);
        this.cabinetLights.push(this.add.rectangle(x + 15, y - 18, 3, 3, 0x65d1bd).setDepth(y + 2));
      }
    }

    this.add.text(490, 120, 'ZONE A — MACHINING', this.zoneTextStyle()).setDepth(50);
    this.add.text(1130, 120, 'ZONE B — DRIVE LINE', this.zoneTextStyle()).setDepth(50);
    this.add.text(690, 610, 'ZONE C — PROCESSING', this.zoneTextStyle()).setDepth(50);

    // Floor lane markings improve zone readability without changing the machine layout.
    const lane = this.add.graphics().setDepth(-10);
    lane.lineStyle(3, 0xcba83f, 0.45);
    lane.lineBetween(430, 560, 1665, 560);
    lane.lineBetween(620, 665, 620, 970);
    lane.lineBetween(1270, 665, 1270, 970);
    lane.lineStyle(2, 0x6b7b80, 0.38);
    lane.lineBetween(1040, 100, 1040, 540);

    for (const placement of machinePositions) {
      this.add.tileSprite(placement.x, placement.y + 48, 132, 16, 'hazard').setDepth(placement.y - 2);
    }

    for (let x = 480; x <= 1640; x += 170) {
      this.add.image(x, 555, 'pallet').setScale(1.35).setDepth(555);
    }

    this.add.text(458, 1015, 'LOADING / MATERIAL FLOW', this.zoneTextStyle()).setDepth(50);
    for (let x = 520; x <= 1420; x += 150) {
      this.add.image(x, 980, x % 300 === 0 ? 'crate' : 'pallet').setScale(1.35).setDepth(980);
    }

    // Ventilation and background production activity are presentation only.
    for (const [x, y] of [[450, 160], [1660, 155], [1400, 660], [1460, 900]] as const) {
      const fan = this.add.image(x, y, 'fan').setScale(1.8).setAlpha(0.72).setDepth(y - 5);
      this.ventilationFans.push(fan);
    }

    for (let i = 0; i < 8; i += 1) {
      this.conveyorItems.push(
        this.add.rectangle(500 + i * 150, 586, 14, 7, i % 2 ? 0xaebd8a : 0x9ab9c0).setDepth(587),
      );
    }

    this.add.text(120, 365, 'E  CONTROL ROOM CONSOLE', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#859ba5',
    });
  }

  private drawRoom(x: number, y: number, width: number, height: number, label: string): void {
    this.add.rectangle(x + width / 2, y + height / 2, width, height, 0x26343b, 0.38).setDepth(-20);
    this.add.tileSprite(x + width / 2, y, width, 16, 'wall').setDepth(20);
    this.add.tileSprite(x + width / 2, y + height, width, 16, 'wall').setDepth(20);
    this.add.tileSprite(x, y + height / 2, 16, height, 'wall').setDepth(20);
    this.add.tileSprite(x + width, y + height / 2, 16, height, 'wall').setDepth(20);
    this.add.text(x + 18, y + 18, label, this.zoneTextStyle()).setDepth(40);
  }

  private buildCollisions(): void {
    this.addObstacle(FACTORY_WORLD.width / 2, 16, FACTORY_WORLD.width, 32);
    this.addObstacle(FACTORY_WORLD.width / 2, FACTORY_WORLD.height - 16, FACTORY_WORLD.width, 32);
    this.addObstacle(16, FACTORY_WORLD.height / 2, 32, FACTORY_WORLD.height);
    this.addObstacle(FACTORY_WORLD.width - 16, FACTORY_WORLD.height / 2, 32, FACTORY_WORLD.height);

    this.addObstacle(210, 70, 320, 18);
    this.addObstacle(50, 220, 18, 300);
    this.addObstacle(370, 220, 18, 300);
    this.addObstacle(120, 370, 140, 18);
    this.addObstacle(330, 370, 80, 18);

    this.addObstacle(245, 760, 390, 18);
    this.addObstacle(50, 885, 18, 250);
    this.addObstacle(440, 885, 18, 250);
    this.addObstacle(140, 1010, 180, 18);
    this.addObstacle(400, 1010, 80, 18);

    this.addObstacle(1685, 720, 350, 18);
    this.addObstacle(1510, 865, 18, 290);
    this.addObstacle(1860, 865, 18, 290);
    this.addObstacle(1605, 1010, 190, 18);
    this.addObstacle(1815, 1010, 90, 18);

    for (const placement of machinePositions) this.addObstacle(placement.x, placement.y, 104, 72);
  }

  private addObstacle(x: number, y: number, width: number, height: number): void {
    const obstacle = this.obstacles.create(x, y, 'wall') as Phaser.Physics.Arcade.Image;
    obstacle.setVisible(false).setDisplaySize(width, height).refreshBody();
  }

  private syncMachines(state: FactoryState): void {
    const activeMaintenance = new Set(
      state.maintenance
        .filter((item) => item.status !== 'COMPLETED' && item.status !== 'FAILED')
        .map((item) => item.machineId),
    );

    for (const machineState of state.machines) {
      const existing = this.machineViews.get(machineState.id);
      if (existing) {
        existing.setState(machineState);
        existing.setMaintenance(activeMaintenance.has(machineState.id));
        existing.setSelected(this.selectedMachineId === machineState.id);
        continue;
      }

      const placement = machinePositions.find((item) => item.id === machineState.id);
      if (!placement) continue;
      const view = new MachineView(this, placement.x, placement.y, machineState);
      view.setMaintenance(activeMaintenance.has(machineState.id));
      view.setSelected(this.selectedMachineId === machineState.id);
      this.machineViews.set(machineState.id, view);
    }
  }

  private syncTechnicians(state: FactoryState): void {
    for (const technicianState of state.technicians) {
      const existing = this.technicianViews.get(technicianState.id);
      if (existing) {
        existing.setState(technicianState);
        continue;
      }
      this.technicianViews.set(technicianState.id, new TechnicianView(this, technicianState));
    }
  }

  private updateFactoryAmbience(deltaMs: number): void {
    this.ambienceTime += deltaMs / 1000;
    for (const [index, fan] of this.ventilationFans.entries()) {
      fan.rotation += (index % 2 === 0 ? 1 : -1) * 0.018 * (deltaMs / 16.67);
    }
    for (const [index, light] of this.cabinetLights.entries()) {
      light.setAlpha(0.35 + (Math.sin(this.ambienceTime * (2.5 + index * 0.12) + index) + 1) * 0.28);
    }

    const demand = this.latestState?.demand ?? 50;
    const speed = 18 + demand * 0.45;
    for (const item of this.conveyorItems) {
      item.x += speed * (deltaMs / 1000);
      if (item.x > 1660) item.x = 470;
    }
  }

  private updateInteractionTarget(): void {
    let closestId: number | undefined;
    let closestDistance = FACTORY_WORLD.interactionDistance;

    for (const machine of this.machineViews.values()) {
      const distance = machine.distanceTo(this.player.x, this.player.y);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestId = machine.id;
      }
    }

    this.nearbyMachineId = closestId;

    if (closestId !== undefined) {
      this.game.events.emit('interaction-hint', `E INSPECT M${String(closestId).padStart(2, '0')}  ·  P PHONE  ·  M MAP`);
      return;
    }

    const consoleDistance = Phaser.Math.Distance.Between(this.player.x, this.player.y, this.controlConsole.x, this.controlConsole.y);
    if (consoleDistance < 115) {
      this.game.events.emit('interaction-hint', 'E FACTORY OVERVIEW  ·  P PHONE  ·  M MAP');
      return;
    }

    this.game.events.emit('interaction-hint', 'WASD / ARROWS MOVE  ·  E INTERACT  ·  P PHONE  ·  M MAP');
  }

  private zoneTextStyle(): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#9fb2bb',
      backgroundColor: '#18252c',
      padding: { x: 5, y: 3 },
    };
  }

}
