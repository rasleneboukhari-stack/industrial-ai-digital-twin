import Phaser from 'phaser';
import type { FactoryBackend } from '../backend/FactoryBackend';
import type { FactoryState } from '../models/FactoryState';
import { isAIMessageExpired, isAIMessageSuperseded, type AIMessage } from '../models/AIMessage';
import { AlertUI } from '../ui/AlertUI';
import { AIAssistantUI } from '../ui/AIAssistantUI';
import { AIMessageManager } from '../ui/AIMessageManager';
import { AudioControls } from '../ui/AudioControls';
import { AudioManager } from '../ui/AudioManager';
import { FactoryMap } from '../ui/FactoryMap';
import { FactoryOverview } from '../ui/FactoryOverview';
import { MachinePanel } from '../ui/MachinePanel';
import { MiniMap } from '../ui/MiniMap';
import { PhoneUI, type PhoneTab } from '../ui/PhoneUI';
import { TimeControls } from '../ui/TimeControls';
import { mqttTelemetry } from '../services/MqttTelemetryService';

export class UIScene extends Phaser.Scene {
  private backend!: FactoryBackend;
  private latestState?: FactoryState;
  private unsubscribe?: () => void;
  private unsubscribeTelemetry?: () => void;
  private unsubscribeAIMessages?: () => void;
  private unsubscribeSystemAlerts?: () => void;
  private timeControls!: TimeControls;
  private alertUI!: AlertUI;
  private aiAssistant!: AIAssistantUI;
  private aiMessageManager!: AIMessageManager;
  private phone!: PhoneUI;
  private machinePanel!: MachinePanel;
  private overview!: FactoryOverview;
  private miniMap!: MiniMap;
  private factoryMap!: FactoryMap;
  private audio!: AudioManager;
  private audioControls!: AudioControls;
  private hint!: Phaser.GameObjects.Text;
  private escapeKey!: Phaser.Input.Keyboard.Key;
  private upKey!: Phaser.Input.Keyboard.Key;
  private downKey!: Phaser.Input.Keyboard.Key;
  private selectedMachineId = 7;

  private autoRepairEnabled = false;
  private autoRepairBusy = false;

  private autoRepairButton!: Phaser.GameObjects.Rectangle;
  private autoRepairLabel!: Phaser.GameObjects.Text;


  private readonly onInspectMachine = (machineId: number) => this.openMachine(machineId);
  private readonly onTogglePhone = () => this.togglePhone();
  private readonly onToggleFactoryMap = () => this.toggleFactoryMap();
  private readonly onOpenOverview = () => this.openOverview();
  private readonly onInteractionHint = (message: string) => this.hint.setText(message);
  private readonly onPlayerPosition = (x: number, y: number) => {
    this.miniMap?.setPlayerPosition(x, y);
    this.factoryMap?.setPlayerPosition(x, y);
    this.audio?.setPlayerPosition(x, y);
  };
  private readonly onPlayerMotion = (moving: boolean) => this.audio?.setWalking(moving);
  private readonly onWheel = (
    _pointer: Phaser.Input.Pointer,
    _gameObjects: Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number,
  ) => {
    if (this.phone?.isOpen() && deltaY !== 0) this.phone.navigate(deltaY > 0 ? 1 : -1);
  };

  constructor() {
    super('UIScene');
  }
  private applyFactoryState(state: FactoryState): void {
    this.latestState = state;

    this.timeControls.updateState(state);

    this.alertUI.updateAlerts(
        state.alerts.filter(
            (alert) => alert.source === 'SYSTEM'
        )
    );

    this.phone.setFactoryState(state);
    this.machinePanel.setFactoryState(state);
    this.overview.setFactoryState(state);
    this.miniMap.setFactoryState(state);
    this.factoryMap.setFactoryState(state);
    this.audio.setState(state);

    const currentMinute = Math.floor((Date.parse(state.simulatedTime) -
      Date.parse('2026-09-21T07:00:00.000Z')) / 60_000);
    const activeAIMessage = this.aiMessageManager.getActive();
    if (activeAIMessage?.machineId !== undefined &&
        isAIMessageExpired(activeAIMessage, currentMinute)) {
      this.aiMessageManager.discardForMachine(activeAIMessage.machineId);
    }
    const currentWarnings = (state.aiMessages ?? []).filter((message) => {
      if (message.kind !== 'PREDICTION' || isAIMessageExpired(message, currentMinute)) return false;
      const machine = state.machines.find((item) => item.id === message.machineId);
      return machine?.status === 'RUNNING' &&
        !state.alerts.some((alert) => isAIMessageSuperseded(message, alert));
    });
    this.aiAssistant.setWarningSummary(currentWarnings, state.aiMessages ?? [], currentMinute);
    this.aiMessageManager.ingest((state.aiMessages ?? []).map((message) =>
      state.machines.some((machine) => machine.id === message.machineId &&
        (machine.status === 'FAULT' || machine.status === 'STOPPED')) ||
      state.alerts.some((alert) => isAIMessageSuperseded(message, alert)) ||
      isAIMessageExpired(message, currentMinute)
        ? { ...message, prominent: false }
        : message
    ));
  }


  create(): void {
    this.backend = this.registry.get('factoryBackend') as FactoryBackend;
    this.audio = new AudioManager(this);

    this.timeControls = new TimeControls(this, 16, 16, this.backend);
    this.createAutoRepairControl();
    this.audioControls = new AudioControls(this, 16, 134, this.audio);
    this.alertUI = new AlertUI(this, 0, 16, (machineId) => {
      if (machineId !== undefined) {
        this.selectMachine(machineId);
        this.phone.setSelectedMachine(machineId);
        this.openPhone('AI');
      } else {
        this.openPhone('ALERTS');
      }
    });
    this.miniMap = new MiniMap(this, 0, 88);
    this.phone = new PhoneUI(
      this,
      this.backend,
      () => {
        this.audio.playPhoneClose();
        this.syncOverlayState();
      },
      (machineId) => this.selectMachine(machineId),
    );
    this.aiAssistant = new AIAssistantUI(this, (message?: AIMessage) => {
      if (message?.machineId !== undefined) {
        this.selectMachine(message.machineId);
        this.phone.setSelectedMachine(message.machineId);
      }
      this.openPhone('AI');
      if (message) this.phone.focusAIMessage(message.id);
    });
    this.aiMessageManager = new AIMessageManager(
      (message, done) => this.aiAssistant.present(message, done),
      (messageId) => this.aiAssistant.invalidate(messageId),
    );
    this.machinePanel = new MachinePanel(this, this.backend, () => this.syncOverlayState());
    this.overview = new FactoryOverview(this, () => this.syncOverlayState());
    this.factoryMap = new FactoryMap(
      this,
      () => this.closeFactoryMap(),
      (machineId) => this.openMachine(machineId),
    );
    this.hint = this.add
      .text(0, 0, 'WASD / ARROWS MOVE  ·  E INTERACT  ·  P PHONE  ·  M MAP', {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#d8e6ec',
        backgroundColor: '#101a20dd',
        padding: { x: 10, y: 6 },
      })
      .setOrigin(0.5)
      .setDepth(3000);

    if (!this.input.keyboard) throw new Error('Keyboard input is unavailable');
    this.escapeKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.upKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.downKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);

    this.selectMachine(7);
    this.layout();

    mqttTelemetry.start();

    this.unsubscribe = this.backend.subscribeToUpdates((state) => {
      const mergedState = mqttTelemetry.mergeState(state);
      this.applyFactoryState(mergedState);
    });

    this.unsubscribeTelemetry = mqttTelemetry.subscribe((telemetry) => {
      if (!this.latestState) return;

      if (!telemetry.running || telemetry.state === 'FAILURE') {
        this.aiMessageManager.discardForMachine(telemetry.id);
        this.aiAssistant.invalidateMachine(telemetry.id);
      }

      const machine = this.latestState.machines.find(
          (item) => item.id === telemetry.id
      );

      if (!machine) return;

      this.applyFactoryState(mqttTelemetry.mergeState(this.latestState));
    });

    this.unsubscribeAIMessages = mqttTelemetry.subscribeToAIMessages((_message) => {
      if (!this.latestState) return;
      this.applyFactoryState(mqttTelemetry.mergeState(this.latestState));
    });

    this.unsubscribeSystemAlerts = mqttTelemetry.subscribeToSystemAlerts((alert) => {
      if (alert.status === 'ACTIVE') {
        this.aiMessageManager.discardForMachine(alert.machineId);
        this.aiAssistant.invalidateMachine(alert.machineId);
      }
      if (this.latestState) {
        this.applyFactoryState(mqttTelemetry.mergeState(this.latestState));
      }
    });

    this.game.events.on('inspect-machine', this.onInspectMachine);
    this.game.events.on('toggle-phone', this.onTogglePhone);
    this.game.events.on('toggle-factory-map', this.onToggleFactoryMap);
    this.game.events.on('open-factory-overview', this.onOpenOverview);
    this.game.events.on('interaction-hint', this.onInteractionHint);
    this.game.events.on('player-position', this.onPlayerPosition);
    this.game.events.on('player-motion', this.onPlayerMotion);
    this.input.on('wheel', this.onWheel);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.unsubscribeTelemetry?.();
      this.unsubscribeAIMessages?.();
      this.unsubscribeSystemAlerts?.();
      this.game.events.off('inspect-machine', this.onInspectMachine);
      this.game.events.off('toggle-phone', this.onTogglePhone);
      this.game.events.off('toggle-factory-map', this.onToggleFactoryMap);
      this.game.events.off('open-factory-overview', this.onOpenOverview);
      this.game.events.off('interaction-hint', this.onInteractionHint);
      this.game.events.off('player-position', this.onPlayerPosition);
      this.game.events.off('player-motion', this.onPlayerMotion);
      this.input.off('wheel', this.onWheel);
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
    });
  }

  update(_time: number, delta: number): void {
    this.miniMap.tick(delta);
    this.aiAssistant.update(delta);
    this.audio.update(delta);

    if (Phaser.Input.Keyboard.JustDown(this.escapeKey)) this.closeForegroundUi();
    if (this.phone.isOpen() && Phaser.Input.Keyboard.JustDown(this.upKey)) this.phone.navigate(-1);
    if (this.phone.isOpen() && Phaser.Input.Keyboard.JustDown(this.downKey)) this.phone.navigate(1);
  }

  private openMachine(machineId: number): void {
    const machine = this.latestState?.machines.find((item) => item.id === machineId);
    if (!machine || !this.latestState) return;
    this.closeOtherOverlays('machine');
    this.phone.setSelectedMachine(machineId);
    this.selectMachine(machineId);
    this.machinePanel.show(machine, this.latestState, this.scale.width / 2, this.scale.height / 2);
    this.syncOverlayState();
  }

  private togglePhone(): void {
    if (this.phone.isOpen()) {
      this.phone.close();
      return;
    }
    this.openPhone('ALERTS');
  }

  private openPhone(tab: PhoneTab): void {
    this.closeOtherOverlays('phone');
    this.phone.open(tab);
    this.audio.playPhoneOpen();
    this.syncOverlayState();
  }

  private toggleFactoryMap(): void {
    if (this.factoryMap.visible) {
      this.closeFactoryMap();
      return;
    }
    if (!this.latestState) return;
    this.closeOtherOverlays('map');
    this.factoryMap.show(this.latestState, this.scale.width / 2, this.scale.height / 2);
    this.syncOverlayState();
  }

  private closeFactoryMap(): void {
    this.factoryMap.hide();
    this.syncOverlayState();
  }

  private openOverview(): void {
    if (!this.latestState) return;
    this.closeOtherOverlays('overview');
    this.overview.show(this.latestState, this.scale.width / 2, this.scale.height / 2);
    this.syncOverlayState();
  }

  private closeForegroundUi(): void {
    // Required priority: machine panel -> expanded map -> phone -> factory overview.
    if (this.machinePanel.visible) {
      this.machinePanel.hide();
      return;
    }
    if (this.factoryMap.visible) {
      this.closeFactoryMap();
      return;
    }
    if (this.phone.isOpen()) {
      this.phone.close();
      return;
    }
    if (this.overview.visible) this.overview.hide();
  }

  private closeOtherOverlays(keep: 'machine' | 'phone' | 'map' | 'overview'): void {
    if (keep !== 'machine' && this.machinePanel.visible) this.machinePanel.hide();
    if (keep !== 'map' && this.factoryMap.visible) this.factoryMap.hide();
    if (keep !== 'phone' && this.phone.isOpen()) this.phone.close();
    if (keep !== 'overview' && this.overview.visible) this.overview.hide();
  }

  private selectMachine(machineId: number): void {
    this.selectedMachineId = machineId;
    this.miniMap?.setSelectedMachine(machineId);
    this.factoryMap?.setSelectedMachine(machineId);
    this.game.events.emit('selected-machine-changed', machineId);
  }

  private syncOverlayState(): void {
    const foregroundOpen = this.machinePanel.visible || this.factoryMap.visible || this.phone.isOpen() || this.overview.visible;
    this.game.events.emit('ui-block-changed', foregroundOpen);
    this.hint.setVisible(!foregroundOpen);
    this.miniMap.setVisible(!foregroundOpen);
    this.alertUI.setVisible(!foregroundOpen);
    this.audioControls.setVisible(!this.factoryMap.visible && !this.machinePanel.visible && !this.overview.visible);
    this.aiAssistant.setSuppressed(foregroundOpen);
  }

  private createAutoRepairControl(): void {
    this.autoRepairButton = this.add
        .rectangle(
            550,
            35,
            150,
            30,
            0x24343c,
            0.96,
        )
        .setStrokeStyle(
            1,
            0x6d7e86,
            1,
        )
        .setDepth(4000)
        .setInteractive({
          useHandCursor: true,
        });

    this.autoRepairLabel = this.add
        .text(
            550,
            35,
            'AUTO REPAIR: OFF',
            {
              fontFamily: 'monospace',
              fontSize: '10px',
              color: '#b5c2c7',
            },
        )
        .setOrigin(0.5)
        .setDepth(4001);

    this.autoRepairButton.on(
        'pointerdown',
        () => {
          void this.toggleAutoRepair();
        },
    );
  }


  private async toggleAutoRepair(): Promise<void> {
    if (this.autoRepairBusy) {
      return;
    }

    this.autoRepairBusy = true;

    const next =
        !this.autoRepairEnabled;

    this.renderAutoRepairControl(
        next,
        true,
    );

    const baseUrl =
        import.meta.env.VITE_COMMAND_API_URL ??
        'http://localhost:8081/api';

    try {
      const response =
          await fetch(
              `${baseUrl}/simulation/auto-repair`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  enabled: next,
                }),
              },
          );

      if (!response.ok) {
        throw new Error(
            `Auto repair request failed: ${response.status}`,
        );
      }

      this.autoRepairEnabled =
          next;

      this.renderAutoRepairControl(
          this.autoRepairEnabled,
          false,
      );
    }
    catch (error) {
      console.error(
          'Failed to change auto repair',
          error,
      );

      this.renderAutoRepairControl(
          this.autoRepairEnabled,
          false,
      );
    }
    finally {
      this.autoRepairBusy =
          false;
    }
  }


  private renderAutoRepairControl(
      enabled: boolean,
      pending: boolean,
  ): void {
    if (pending) {
      this.autoRepairLabel.setText(
          'AUTO REPAIR: ...',
      );

      this.autoRepairLabel.setColor(
          '#d9c86c',
      );

      return;
    }

    if (enabled) {
      this.autoRepairButton.setFillStyle(
          0x24483f,
          0.96,
      );

      this.autoRepairButton.setStrokeStyle(
          1,
          0x65d1bd,
          1,
      );

      this.autoRepairLabel.setText(
          'AUTO REPAIR: ON',
      );

      this.autoRepairLabel.setColor(
          '#65d1bd',
      );
    }
    else {
      this.autoRepairButton.setFillStyle(
          0x24343c,
          0.96,
      );

      this.autoRepairButton.setStrokeStyle(
          1,
          0x6d7e86,
          1,
      );

      this.autoRepairLabel.setText(
          'AUTO REPAIR: OFF',
      );

      this.autoRepairLabel.setColor(
          '#b5c2c7',
      );
    }
  }
  private layout(): void {
    if (!this.timeControls) return;
    const width = this.scale.width;
    const height = this.scale.height;

    this.timeControls.setPosition(16, 16);
    this.audioControls.setPosition(16, 134);
    this.autoRepairButton.setPosition(550, 35);
    this.autoRepairLabel.setPosition(550, 35);

    this.alertUI.setPosition(Math.max(16, width - 206), 16);
    this.miniMap.setPosition(Math.max(12, width - 274), 90);
    this.aiAssistant.setPosition(Math.max(466, width - 84), Math.max(300, height - 184));
    this.phone.setPosition(Math.max(12, width - 398), Math.max(58, Math.min(74, height - 654)));
    this.hint.setPosition(width / 2, height - 28);

    if (this.machinePanel.visible) this.machinePanel.setPosition(width / 2, height / 2);
    if (this.overview.visible) this.overview.setPosition(width / 2, height / 2);
    if (this.factoryMap.visible) this.factoryMap.setPosition(width / 2, height / 2);
  }
}
