import Phaser from 'phaser';
import type { FactoryBackend, MachineCommand } from '../backend/FactoryBackend';
import type { Alert } from '../models/Alert';
import { isAIMessageExpired, isAIMessageSuperseded, type AIMessage } from '../models/AIMessage';
import type { FactoryState } from '../models/FactoryState';
import { healthForecastLabel, type MachineState } from '../models/MachineState';
import type { MaintenanceRequest } from '../models/Maintenance';
import { PixelButton } from './PixelButton';

export type PhoneTab = 'ALERTS' | 'MACHINES' | 'SELECTED' | 'AI' | 'MAINTENANCE' | 'EVENTS';

type ContextAction = { label: string; run: () => void; enabled?: boolean; reason?: string; danger?: boolean; active?: boolean };

export class PhoneUI extends Phaser.GameObjects.Container {
  private factoryState?: FactoryState;
  private selectedMachineId = 7;
  private tab: PhoneTab = 'ALERTS';
  private readonly screenTitle: Phaser.GameObjects.Text;
  private readonly bodyText: Phaser.GameObjects.Text;
  private readonly footer: Phaser.GameObjects.Text;
  private readonly commandStatus: Phaser.GameObjects.Text;
  private readonly alertSourceBadge: Phaser.GameObjects.Text;
  private readonly contextButtons: PixelButton[] = [];
  private readonly tabButtons = new Map<PhoneTab, PixelButton>();
  private contextActions: ContextAction[] = [];
  private readonly pageByTab = new Map<PhoneTab, number>();
  private focusedAIMessageId?: string;
  private aiHorizonFilter: 'ALL' | '24H' | '48H' = 'ALL';
  private pendingCommand = false;
  private commandFeedback = '';
  private commandFeedbackColor = '#91a9b4';

  private readonly confirmLayer: Phaser.GameObjects.Container;
  private readonly confirmText: Phaser.GameObjects.Text;
  private confirmAction?: () => void;

  constructor(
    scene: Phaser.Scene,
    private readonly backend: FactoryBackend,
    private readonly onClose: () => void,
    private readonly onSelectMachine: (machineId: number) => void,
  ) {
    super(scene, 0, 0);
    scene.add.existing(this);
    this.setDepth(3300);

    const shadow = scene.add.rectangle(8, 8, 382, 640, 0x000000, 0.35).setOrigin(0);
    const shell = scene.add.rectangle(0, 0, 382, 640, 0x1a2a33, 1).setOrigin(0).setStrokeStyle(3, 0x687f8a);
    const screen = scene.add.rectangle(18, 54, 346, 548, 0x0d171d, 1).setOrigin(0).setStrokeStyle(1, 0x425863);
    const topLabel = scene.add.text(18, 16, 'FACTORY CONSOLE', {
      fontFamily: 'monospace',
      fontSize: '15px',
      color: '#d9e8ee',
      fontStyle: 'bold',
    });
    const close = new PixelButton(scene, 342, 28, 34, 28, 'X', () => this.close(), 0x55343b);

    this.screenTitle = scene.add.text(32, 150, 'ALERTS', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#7fe3b2',
      fontStyle: 'bold',
    });
    this.alertSourceBadge = scene.add.text(278, 150, '', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#d7e6ec',
      backgroundColor: '#334750',
      padding: { x: 5, y: 2 },
      fontStyle: 'bold',
    }).setOrigin(1, 0).setVisible(false);
    this.bodyText = scene.add.text(32, 178, '', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#d1e0e6',
      lineSpacing: 3,
      wordWrap: { width: 314, useAdvancedWrap: true },
    });
    this.commandStatus = scene.add.text(32, 528, '', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#91a9b4',
      wordWrap: { width: 314, useAdvancedWrap: true },
      maxLines: 2,
    });
    this.footer = scene.add.text(32, 570, '↑/↓ pages · P closes console', {
      fontFamily: 'monospace',
      fontSize: '9px',
      color: '#788e99',
      wordWrap: { width: 314, useAdvancedWrap: true },
      maxLines: 2,
    });

    this.add([shadow, shell, screen, topLabel, close, this.screenTitle, this.alertSourceBadge, this.bodyText, this.commandStatus, this.footer]);

    const tabs: Array<{ tab: PhoneTab; label: string }> = [
      { tab: 'ALERTS', label: 'ALERT' },
      { tab: 'MACHINES', label: 'MACH' },
      { tab: 'SELECTED', label: 'MACHINE' },
      { tab: 'AI', label: 'AI' },
      { tab: 'MAINTENANCE', label: 'MAINT' },
      { tab: 'EVENTS', label: 'EVENTS' },
    ];
    tabs.forEach(({ tab, label }, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const button = new PixelButton(scene, 82 + column * 109, 81 + row * 35, 104, 30, label, () => {
        this.tab = tab;
        if (tab === 'AI') {
          this.focusedAIMessageId = undefined;
          this.pageByTab.set('AI', 0);
        }
        this.render();
      });
      this.tabButtons.set(tab, button);
      this.add(button);
    });

    const up = new PixelButton(scene, 319, 151, 28, 24, '↑', () => this.navigate(-1));
    const down = new PixelButton(scene, 350, 151, 28, 24, '↓', () => this.navigate(1));
    this.add([up, down]);

    [0, 1, 2].forEach((index) => {
      const button = new PixelButton(scene, 78 + index * 112, 492, index === 2 ? 94 : 104, 30, '', () => this.runContextAction(index));
      button.setVisible(false);
      this.contextButtons.push(button);
      this.add(button);
    });

    this.confirmLayer = scene.add.container(191, 326).setDepth(20).setVisible(false);
    const confirmBg = scene.add.rectangle(0, 0, 316, 220, 0x17242d, 0.995).setStrokeStyle(2, 0xd5a857);
    const confirmTitle = scene.add.text(-135, -88, 'WARNING / CONFIRM', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#f0c766',
      fontStyle: 'bold',
    });
    this.confirmText = scene.add.text(-135, -55, '', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#d9e5e9',
      wordWrap: { width: 270, useAdvancedWrap: true },
    });
    const cancel = new PixelButton(scene, -70, 78, 110, 30, 'CANCEL', () => this.hideConfirmation());
    const confirm = new PixelButton(scene, 70, 78, 110, 30, 'CONFIRM', () => {
      const action = this.confirmAction;
      this.hideConfirmation();
      action?.();
    }, 0x55343b);
    this.confirmLayer.add([confirmBg, confirmTitle, this.confirmText, cancel, confirm]);
    this.add(this.confirmLayer);

    this.setVisible(false);
  }

  setFactoryState(state: FactoryState): void {
    this.factoryState = state;
    this.render();
  }

  setSelectedMachine(machineId: number): void {
    this.selectedMachineId = machineId;
    this.onSelectMachine(machineId);
    this.render();
  }

  getSelectedMachineId(): number {
    return this.selectedMachineId;
  }

  open(tab: PhoneTab = this.tab): void {
    this.tab = tab;
    this.setVisible(true);
    this.render();
  }

  focusAIMessage(messageId: string): void {
    this.aiHorizonFilter = 'ALL';
    this.focusedAIMessageId = messageId;
    this.tab = 'AI';
    this.render();
  }

  close(): void {
    if (!this.visible) return;
    this.hideConfirmation();
    this.setVisible(false);
    this.onClose();
  }

  toggle(): boolean {
    if (this.visible) {
      this.close();
      return false;
    }
    this.open();
    return true;
  }

  isOpen(): boolean {
    return this.visible;
  }

  navigate(delta: number): void {
    if (!this.visible || !this.factoryState || this.confirmLayer.visible) return;
    const current = this.pageByTab.get(this.tab) ?? 0;
    const max = this.maxPageForTab();
    const next = Phaser.Math.Clamp(current + delta, 0, max);
    this.pageByTab.set(this.tab, next);
    if (this.tab === 'AI') this.focusedAIMessageId = this.allAIMessages()[next]?.id;
    this.render();
  }

  private render(): void {
    if (!this.factoryState || !this.visible) return;
    this.screenTitle
      .setText(this.tab === 'SELECTED' ? 'SELECTED MACHINE' : this.tab)
      .setColor('#7fe3b2');
    for (const [tab, button] of this.tabButtons) {
      button.setActiveStyle(tab === this.tab);
    }
    this.contextActions = [];
    this.contextButtons.forEach((button) => button.setVisible(false));
    this.alertSourceBadge.setVisible(false);
    this.commandStatus
      .setColor(this.pendingCommand ? '#f0c766' : this.commandFeedbackColor)
      .setText(this.pendingCommand ? 'SENDING… waiting for backend acknowledgement' : this.commandFeedback);

    switch (this.tab) {
      case 'ALERTS':
        this.renderAlerts();
        break;
      case 'MACHINES':
        this.renderMachines();
        break;
      case 'SELECTED':
        this.renderSelected();
        break;
      case 'AI':
        this.renderAI();
        break;
      case 'MAINTENANCE':
        this.renderMaintenance();
        break;
      case 'EVENTS':
        this.renderEvents();
        break;
    }
    this.renderContextButtons();
  }

  private renderAlerts(): void {
    if (!this.factoryState) return;
    // SYSTEM operational alerts stay in the existing alert UI. AI communication is rendered separately.
    const alerts = this.systemAlerts();
    if (alerts.length === 0) {
      this.bodyText.setText('No SYSTEM alerts recorded.');
      this.footer.setText('SYSTEM alerts are deterministic operational conditions from the backend.');
      return;
    }

    const page = Phaser.Math.Clamp(this.pageByTab.get('ALERTS') ?? 0, 0, alerts.length - 1);
    this.pageByTab.set('ALERTS', page);
    const alert = alerts[page];
    const acknowledged = alert.acknowledgedAt ? 'YES' : 'NO';
    const liveSystemAlert = alert.id.startsWith('system-');

    this.alertSourceBadge
      .setText(alert.source)
      .setColor('#d7e6ec')
      .setBackgroundColor('#334750')
      .setVisible(true);

    const severityColor = alert.severity === 'CRITICAL'
      ? '#ef6b68'
      : alert.severity === 'HIGH'
        ? '#f09a52'
        : alert.severity === 'MEDIUM'
          ? '#f0c766'
          : '#7fe3b2';
    this.screenTitle.setColor(severityColor);

    this.bodyText.setText([
      `ALERT ${page + 1}/${alerts.length} · FILTER SYSTEM`,
      '',
      `[ ${alert.source} ]`,
      `M${String(alert.machineId).padStart(2, '0')}  ${alert.severity}`,
      `${alert.title}`,
      '',
      this.wrap(alert.message, 46),
      '',
      `Lifecycle: ${alert.status}`,
      liveSystemAlert ? 'Tracking: live telemetry' : `Acknowledged: ${acknowledged}`,
      `Recommended: ${alert.recommendation ?? 'Review'}`,
      alert.detail ? `\n${this.wrap(alert.detail, 46)}` : '',
    ].filter(Boolean).join('\n'));

    this.contextActions = [
      {
        label: liveSystemAlert ? 'LIVE EVENT' : alert.acknowledgedAt ? 'ACKED' : 'ACKNOWLEDGE',
        enabled: !liveSystemAlert && !alert.acknowledgedAt && alert.status !== 'RESOLVED',
        run: () => this.acknowledgeAlert(alert),
      },
      {
        label: `OPEN M${String(alert.machineId).padStart(2, '0')}`,
        run: () => {
          this.selectedMachineId = alert.machineId;
          this.onSelectMachine(alert.machineId);
          this.tab = 'AI';
          this.render();
        },
      },
    ];
    this.footer.setText(liveSystemAlert
      ? '↑/↓ changes event · resolves when telemetry clears.'
      : '↑/↓ changes SYSTEM alert · ACK means seen, not fixed.');
  }

  private renderMachines(): void {
    if (!this.factoryState) return;
    const perPage = 7;
    const maxPage = Math.max(0, Math.ceil(this.factoryState.machines.length / perPage) - 1);
    const page = Phaser.Math.Clamp(this.pageByTab.get('MACHINES') ?? 0, 0, maxPage);
    this.pageByTab.set('MACHINES', page);
    const rows = this.factoryState.machines.slice(page * perPage, page * perPage + perPage).map((machine) => {
      const id = `M${String(machine.id).padStart(2, '0')}`;
      const selected = machine.id === this.selectedMachineId ? '>' : ' ';
      const risk = machine.failureRisk ?? '--';
      return `${selected}${id} ${machine.status.padEnd(7)} ${String(machine.load.toFixed(0)).padStart(3)}% ${risk}`;
    });
    this.bodyText.setText([
      `PAGE ${page + 1}/${maxPage + 1}`,
      ' ID   STATE    LOAD  AI RISK',
      '-----------------------------',
      ...rows,
      '',
      `Selected: M${String(this.selectedMachineId).padStart(2, '0')}`,
    ].join('\n'));

    this.contextActions = [
      { label: 'PREV M', run: () => this.selectRelativeMachine(-1) },
      { label: 'OPEN', run: () => { this.tab = 'SELECTED'; this.render(); } },
      { label: 'NEXT M', run: () => this.selectRelativeMachine(1) },
    ];
    this.footer.setText('↑/↓ changes list page · PREV/NEXT changes selected machine.');
  }

  private renderSelected(): void {
    const machine = this.selectedMachine();
    if (!machine) {
      this.bodyText.setText('Selected machine is unavailable.');
      return;
    }
    const maintenance = this.maintenanceFor(machine.id);
    this.bodyText.setText(this.machineSummary(machine, maintenance));
    this.contextActions = this.machineActions(machine, maintenance);
    this.footer.setText('Commands go through FactoryBackend; visuals wait for returned state.');
  }

  private renderAI(): void {
    if (!this.factoryState) {
      this.bodyText.setText('Factory AI messages are unavailable.');
      return;
    }

    const messages = this.allAIMessages();
    const maxPage = Math.max(0, messages.length - 1);
    const focusedPage = this.focusedAIMessageId
      ? messages.findIndex((message) => message.id === this.focusedAIMessageId)
      : -1;
    const page = Phaser.Math.Clamp(
      focusedPage >= 0 ? focusedPage : (this.pageByTab.get('AI') ?? 0), 0, maxPage
    );
    this.pageByTab.set('AI', page);
    const aiMessage = messages[page];
    const machine = aiMessage?.machineId === undefined
      ? this.selectedMachine()
      : this.factoryState.machines.find((item) => item.id === aiMessage.machineId);
    if (!machine) {
      this.bodyText.setText('Machine data for this AI message is unavailable.');
      return;
    }
    const maintenance = this.maintenanceFor(machine.id);
    const activeSystemEvent = aiMessage
      ? this.systemAlerts().find((alert) => isAIMessageSuperseded(aiMessage, alert))
      : undefined;

    if (aiMessage) {
      const currentMinute = Math.floor(
        (Date.parse(this.factoryState.simulatedTime) - Date.parse('2026-09-21T07:00:00.000Z')) / 60_000
      );
      const expired = isAIMessageExpired(aiMessage, currentMinute);
      const confidence = aiMessage.confidence === undefined
        ? ''
        : ` · CONF ${this.formatConfidence(aiMessage.confidence)}`;
      this.bodyText.setText([
        `AI ${this.aiHorizonFilter} ${page + 1}/${messages.length} · FACTORY`,
        `${aiMessage.kind} · ${aiMessage.severity}`,
        `${aiMessage.machineId === undefined ? 'FACTORY' : `MACHINE M${String(machine.id).padStart(2, '0')}`}${confidence}`,
        activeSystemEvent || machine.status === 'FAULT' || machine.status === 'STOPPED' || expired
          ? `HISTORY · ${activeSystemEvent?.title ?? (expired ? 'forecast window passed' : `machine now ${machine.status}`)}`
          : 'FORECAST · outcome not yet observed',
        '',
        this.wrap(aiMessage.title, 46),
        '',
        this.wrap(aiMessage.message, 46),
        '',
        aiMessage.recommendedAction ? `Recommended: ${this.wrap(aiMessage.recommendedAction, 34)}` : '',
        `Logged: ${this.shortTime(aiMessage.timestamp)} UTC`,
        '',
        'MACHINE AI CONTEXT',
        `Failure risk: ${machine.failureRisk ?? 'UNKNOWN'}`,
        `${healthForecastLabel(machine)}: ${machine.predictedHealth?.toFixed(0) ?? '--'}%`,
        maintenance ? `Maintenance: ${maintenance.status}` : '',
      ].filter(Boolean).join('\n'));
    } else {
      this.bodyText.setText([
        `MACHINE M${String(machine.id).padStart(2, '0')}`,
        '',
        `No ${this.aiHorizonFilter} AI message in recent history.`,
        '24h: temperature, vibration, current and health-decline events.',
        '48h: machine failure event.',
        '',
        'MACHINE AI CONTEXT',
        `Failure risk: ${machine.failureRisk ?? 'UNKNOWN'}`,
        `${healthForecastLabel(machine)}: ${machine.predictedHealth?.toFixed(0) ?? '--'}%`,
        `Suspected mechanism: ${this.wrap(machine.suspectedFault ?? 'None', 32)}`,
        `Recommended: ${machine.recommendedAction ?? 'NONE'}`,
      ].join('\n'));
    }

    this.contextActions = (['ALL', '24H', '48H'] as const).map((filter) => ({
      label: filter === 'ALL' ? 'ALL AI' : filter,
      active: this.aiHorizonFilter === filter,
      run: () => {
        this.aiHorizonFilter = filter;
        this.focusedAIMessageId = undefined;
        this.pageByTab.set('AI', 0);
        this.render();
      },
    }));
    this.footer.setText('Factory AI log · 24H sensor events · 48H failure · ↑/↓ history.');
  }

  private renderMaintenance(): void {
    if (!this.factoryState) return;
    const entries = this.factoryState.maintenance;
    const machine = this.selectedMachine();
    const current = machine ? this.maintenanceFor(machine.id) : undefined;
    const active = entries.filter((item) => item.status !== 'COMPLETED' && item.status !== 'FAILED');
    const page = Phaser.Math.Clamp(this.pageByTab.get('MAINTENANCE') ?? 0, 0, Math.max(0, entries.length - 1));
    this.pageByTab.set('MAINTENANCE', page);
    const request = entries[page];

    const technicians = this.factoryState.technicians
      .map((tech) => `${tech.id}  ${tech.status}${tech.targetMachineId ? ` → M${String(tech.targetMachineId).padStart(2, '0')}` : ''}`)
      .join('\n');

    this.bodyText.setText(request ? [
      `MAINTENANCE ${page + 1}/${entries.length}`,
      '',
      `M${String(request.machineId).padStart(2, '0')}  ${request.repairType ?? 'SERVICE'}`,
      `Status: ${request.status}`,
      `Technician: ${request.technicianId ?? 'WAITING'}`,
      `Progress: ${request.progress ?? 0}%`,
      `ETA: ${request.estimatedCompletion ? this.shortTime(request.estimatedCompletion) : '--:--'} sim`,
      request.diagnosis ? `Diagnosis: ${this.wrap(request.diagnosis, 42)}` : '',
      '',
      'TECHNICIANS',
      technicians || 'No technicians',
      '',
      `Active jobs: ${active.length}`,
    ].filter(Boolean).join('\n') : [
      'No maintenance requests yet.',
      '',
      'TECHNICIANS',
      technicians || 'No technicians',
      '',
      `Selected: M${String(this.selectedMachineId).padStart(2, '0')}`,
    ].join('\n'));

    if (machine && !current && machine.status !== 'OFFLINE') {
      if (machine.status === 'RUNNING') {
        this.contextActions = [{
          label: 'STOP + MAINT',
          run: () => this.confirmStopAndMaintenance(machine),
          danger: true,
        }];
      } else {
        this.contextActions = [{
          label: 'REQUEST MAINT',
          run: () => this.sendMachineCommand(machine, 'REQUEST_MAINTENANCE'),
        }];
      }
    }
    this.footer.setText('Maintenance uses simulated time. Machine remains stopped after completion.');
  }

  private renderEvents(): void {
    if (!this.factoryState) return;
    const perPage = 6;
    const maxPage = Math.max(0, Math.ceil(this.factoryState.events.length / perPage) - 1);
    const page = Phaser.Math.Clamp(this.pageByTab.get('EVENTS') ?? 0, 0, maxPage);
    this.pageByTab.set('EVENTS', page);
    const events = this.factoryState.events.slice(page * perPage, page * perPage + perPage);
    this.bodyText.setText([
      `EVENTS PAGE ${page + 1}/${maxPage + 1}`,
      '',
      ...events.flatMap((event) => [
        `${this.shortTime(event.timestamp)}${event.machineId ? ` M${String(event.machineId).padStart(2, '0')}` : ''}`,
        this.wrap(event.message, 46),
        '',
      ]),
    ].join('\n'));
    this.footer.setText('Includes operator requests, backend acknowledgements, maintenance and state consequences.');
  }

  private machineActions(machine: MachineState, maintenance?: MaintenanceRequest): ContextAction[] {
    if (this.pendingCommand) return [];
    if (machine.status === 'OFFLINE') {
      this.commandStatus.setColor('#8ca3af').setText('MACHINE OFFLINE · commands unavailable.');
      return [];
    }
    if (maintenance && maintenance.status !== 'COMPLETED' && maintenance.status !== 'FAILED') {
      this.commandStatus.setColor('#8ca3af').setText(`MAINTENANCE ${maintenance.status} · START unavailable.`);
      return [];
    }
    if (machine.status === 'RUNNING') {
      return [
        { label: 'REDUCE LOAD', run: () => this.sendMachineCommand(machine, 'REDUCE_LOAD', Math.max(0, Math.round(machine.load - 55))) },
        { label: 'COOLING 90', run: () => this.sendMachineCommand(machine, 'SET_COOLING', 90) },
        { label: 'STOP', run: () => this.sendMachineCommand(machine, 'STOP'), danger: true },
      ];
    }
    if (machine.status === 'STOPPED') {
      return [
        {
          label: 'START',
          run: () => this.requestStart(machine),
        },
        {
          label: 'REQUEST MAINT',
          run: () => this.sendMachineCommand(machine, 'REQUEST_MAINTENANCE'),
        },
      ];
    }
    if (machine.status === 'FAULT') {
      return [{ label: 'REQUEST MAINT', run: () => this.sendMachineCommand(machine, 'REQUEST_MAINTENANCE') }];
    }
    return [];
  }

  private renderContextButtons(): void {
    this.contextButtons.forEach((button, index) => {
      const action = this.contextActions[index];
      if (!action) {
        button.setVisible(false);
        return;
      }
      button.setVisible(true);
      button.setLabel(action.label);
      button.setActiveStyle(action.active === true);
      button.setEnabled(!this.pendingCommand && action.enabled !== false, action.reason);
    });
  }

  private runContextAction(index: number): void {
    const action = this.contextActions[index];
    if (!action || this.pendingCommand || action.enabled === false) return;
    action.run();
  }

  private sendMachineCommand(machine: MachineState, command: MachineCommand, value?: number): void {
    if (this.pendingCommand) return;
    if (command === 'REDUCE_LOAD' && value === 0) {
      this.commandFeedback = 'LOAD ALREADY AT OR BELOW 55%.';
      this.commandFeedbackColor = '#7fe3b2';
      this.commandStatus.setColor(this.commandFeedbackColor).setText(this.commandFeedback);
      return;
    }
    this.pendingCommand = true;
    this.commandFeedback = '';
    this.commandStatus.setColor('#f0c766').setText(`SENDING ${command}…`);
    this.renderContextButtons();
    void this.backend.sendCommand(machine.id, command, value)
      .then((result) => {
        this.commandFeedbackColor = result.accepted ? '#7fe3b2' : '#ef8a7f';
        this.commandFeedback = result.accepted ? `COMMAND ACKNOWLEDGED · ${result.message}` : `COMMAND REJECTED · ${result.message}`;
        this.commandStatus.setColor(this.commandFeedbackColor).setText(this.commandFeedback);
      })
      .catch((error: unknown) => {
        this.commandFeedbackColor = '#ef8a7f';
        this.commandFeedback = `COMMAND REJECTED · ${String(error)}`;
        this.commandStatus.setColor(this.commandFeedbackColor).setText(this.commandFeedback);
      })
      .finally(() => {
        this.pendingCommand = false;
        this.render();
      });
  }

  private requestStart(machine: MachineState): void {
    const risk = machine.failureRisk ?? 'LOW';
    if (risk === 'HIGH' || risk === 'CRITICAL') {
      this.showConfirmation(
        `M${String(machine.id).padStart(2, '0')} still has ${risk} predicted failure risk.\n\nStart machine anyway?\n\nThe backend/PLC may still reject START.`,
        () => this.sendMachineCommand(machine, 'START'),
      );
      return;
    }
    this.sendMachineCommand(machine, 'START');
  }

  private confirmStopAndMaintenance(machine: MachineState): void {
    this.showConfirmation(
      `Mechanical maintenance requires M${String(machine.id).padStart(2, '0')} to be stopped.\n\nSend STOP, wait for acknowledgement, then request a technician?`,
      () => {
        if (this.pendingCommand) return;
        this.pendingCommand = true;
        this.commandFeedback = '';
        this.commandStatus.setColor('#f0c766').setText('SENDING STOP…');
        void this.backend.sendCommand(machine.id, 'STOP')
          .then(async (stopResult) => {
            if (!stopResult.accepted) {
              this.commandFeedbackColor = '#ef8a7f';
              this.commandFeedback = `STOP REJECTED · ${stopResult.message}`;
              this.commandStatus.setColor(this.commandFeedbackColor).setText(this.commandFeedback);
              return;
            }
            this.commandStatus.setColor('#7fe3b2').setText('STOP ACKNOWLEDGED · requesting technician…');
            const maintenanceResult = await this.backend.sendCommand(machine.id, 'REQUEST_MAINTENANCE');
            this.commandFeedbackColor = maintenanceResult.accepted ? '#7fe3b2' : '#ef8a7f';
            this.commandFeedback = maintenanceResult.accepted
              ? 'MAINTENANCE REQUEST ACKNOWLEDGED'
              : `MAINTENANCE REJECTED · ${maintenanceResult.message}`;
            this.commandStatus.setColor(this.commandFeedbackColor).setText(this.commandFeedback);
          })
          .catch((error: unknown) => {
            this.commandFeedbackColor = '#ef8a7f';
            this.commandFeedback = `REQUEST FAILED · ${String(error)}`;
            this.commandStatus.setColor(this.commandFeedbackColor).setText(this.commandFeedback);
          })
          .finally(() => {
            this.pendingCommand = false;
            this.render();
          });
      },
    );
  }

  private acknowledgeAlert(alert: Alert): void {
    void this.backend.acknowledgeAlert(alert.id)
      .then(() => {
        this.commandFeedbackColor = '#7fe3b2';
        this.commandFeedback = 'ALERT ACKNOWLEDGED · problem remains until resolved.';
        this.commandStatus.setColor(this.commandFeedbackColor).setText(this.commandFeedback);
      })
      .catch((error: unknown) => {
        this.commandFeedbackColor = '#ef8a7f';
        this.commandFeedback = `ACKNOWLEDGEMENT FAILED · ${String(error)}`;
        this.commandStatus.setColor(this.commandFeedbackColor).setText(this.commandFeedback);
      });
  }

  private selectRelativeMachine(delta: number): void {
    if (!this.factoryState) return;
    const ids = this.factoryState.machines.map((machine) => machine.id).sort((a, b) => a - b);
    const currentIndex = Math.max(0, ids.indexOf(this.selectedMachineId));
    const nextIndex = (currentIndex + delta + ids.length) % ids.length;
    this.selectedMachineId = ids[nextIndex];
    this.onSelectMachine(this.selectedMachineId);
    this.render();
  }

  private selectedMachine(): MachineState | undefined {
    return this.factoryState?.machines.find((machine) => machine.id === this.selectedMachineId);
  }

  private maintenanceFor(machineId: number): MaintenanceRequest | undefined {
    return this.factoryState?.maintenance.find((item) => item.machineId === machineId && item.status !== 'FAILED');
  }

  private machineSummary(machine: MachineState, maintenance?: MaintenanceRequest): string {
    const displayStatus = maintenance && maintenance.status !== 'COMPLETED' ? 'MAINTENANCE' : machine.status;
    return [
      `MACHINE M${String(machine.id).padStart(2, '0')} — ${displayStatus}`,
      '',
      'PHYSICAL',
      `Temperature   ${machine.temperature.toFixed(1)} °C`,
      `Vibration     ${machine.vibration.toFixed(2)}`,
      `RPM           ${machine.rpm.toFixed(0)}`,
      `Load          ${machine.load.toFixed(0)} %`,
      `Current       ${machine.current.toFixed(1)} A`,
      `Cooling       ${machine.coolingSetpoint.toFixed(0)} %`,
      '',
      `Twin          ${machine.digitalTwinStatus ?? 'UNKNOWN'}`,
      `AI risk       ${machine.failureRisk ?? 'UNKNOWN'}`,
      `${healthForecastLabel(machine)}  ${machine.predictedHealth?.toFixed(0) ?? '--'} %`,
      `Fault model   ${this.wrap(machine.suspectedFault ?? 'None', 36)}`,
      `Recommended   ${machine.recommendedAction ?? 'NONE'}`,
      maintenance ? `Maintenance   ${maintenance.status} ${maintenance.progress ?? 0}%` : '',
    ].filter(Boolean).join('\n');
  }

  private showConfirmation(message: string, action: () => void): void {
    this.confirmAction = action;
    this.confirmText.setText(message);
    this.confirmLayer.setVisible(true);
  }

  private hideConfirmation(): void {
    this.confirmAction = undefined;
    this.confirmLayer.setVisible(false);
  }

  private maxPageForTab(): number {
    if (!this.factoryState) return 0;
    if (this.tab === 'ALERTS') return Math.max(0, this.systemAlerts().length - 1);
    if (this.tab === 'AI') return Math.max(0, this.allAIMessages().length - 1);
    if (this.tab === 'MACHINES') return Math.max(0, Math.ceil(this.factoryState.machines.length / 7) - 1);
    if (this.tab === 'MAINTENANCE') return Math.max(0, this.factoryState.maintenance.length - 1);
    if (this.tab === 'EVENTS') return Math.max(0, Math.ceil(this.factoryState.events.length / 6) - 1);
    return 0;
  }

  private systemAlerts(): Alert[] {
    return this.factoryState?.alerts.filter((alert) => alert.source === 'SYSTEM') ?? [];
  }

  private allAIMessages(): AIMessage[] {
    return [...(this.factoryState?.aiMessages ?? [])]
      .filter((message) => this.aiHorizonFilter === 'ALL' ||
        message.horizonMinutes === (this.aiHorizonFilter === '24H' ? 1440 : 2880))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  private wrap(value: string, width: number): string {
    const words = value.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines.join('\n');
  }

  private formatConfidence(value: number): string {
    const percent = value <= 1 ? value * 100 : value;
    return `${Math.round(Phaser.Math.Clamp(percent, 0, 100))}%`;
  }

  private shortTime(value: string): string {
    const date = new Date(value);
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  }
}
