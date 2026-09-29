import Phaser from 'phaser';

import type {
  FactoryBackend,
  MachineCommand,
} from '../backend/FactoryBackend';

import type { FactoryState } from '../models/FactoryState';
import { healthForecastLabel, type MachineState } from '../models/MachineState';
import type { MaintenanceRequest } from '../models/Maintenance';

import { PixelButton } from './PixelButton';


type Action = {
  label: string;
  command: MachineCommand;
  value?: number;
  confirm?: boolean;
};


export class MachinePanel extends Phaser.GameObjects.Container {
  private readonly title: Phaser.GameObjects.Text;

  // IMPORTANT:
  // Do not call this "body".
  // Phaser.GameObjects.Container already has a physics body property.
  private readonly bodyText: Phaser.GameObjects.Text;

  private readonly commandStatus: Phaser.GameObjects.Text;

  private readonly buttons: PixelButton[] = [];

  private actions: Action[] = [];

  private machine?: MachineState;

  // IMPORTANT:
  // Do not call this "state".
  // Phaser.GameObjects.Container already has a state property.
  private factoryState?: FactoryState;

  private pending = false;

  private readonly confirmLayer: Phaser.GameObjects.Container;
  private readonly confirmText: Phaser.GameObjects.Text;

  private confirmAction?: () => void;


  constructor(
      scene: Phaser.Scene,
      private readonly backend: FactoryBackend,
      private readonly onClose: () => void,
  ) {
    super(scene, 0, 0);

    scene.add.existing(this);

    this.setDepth(3400);


    // ---------------------------------------------------------
    // PANEL BACKGROUND
    // ---------------------------------------------------------

    const panel = scene.add
        .rectangle(
            0,
            0,
            620,
            500,
            0x111d25,
            0.99,
        )
        .setOrigin(0.5)
        .setStrokeStyle(
            2,
            0x8da4ad,
        );


    // ---------------------------------------------------------
    // TITLE
    // ---------------------------------------------------------

    this.title = scene.add.text(
        -285,
        -225,
        'MACHINE',
        {
          fontFamily: 'monospace',
          fontSize: '18px',
          color: '#eef7fa',
          fontStyle: 'bold',
        },
    );


    // ---------------------------------------------------------
    // MACHINE DATA
    // ---------------------------------------------------------

    this.bodyText = scene.add.text(
        -285,
        -185,
        '',
        {
          fontFamily: 'monospace',
          fontSize: '12px',
          color: '#cfdee5',
          lineSpacing: 4,
          wordWrap: {
            width: 560,
            useAdvancedWrap: true,
          },
        },
    );


    // ---------------------------------------------------------
    // COMMAND STATUS
    // ---------------------------------------------------------

    this.commandStatus = scene.add.text(
        -285,
        145,
        'Commands are sent to the backend adapter.',
        {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: '#8ca3af',
          wordWrap: {
            width: 560,
            useAdvancedWrap: true,
          },
          maxLines: 2,
        },
    );


    this.add([
      panel,
      this.title,
      this.bodyText,
      this.commandStatus,
    ]);


    // ---------------------------------------------------------
    // CLOSE BUTTON
    // ---------------------------------------------------------

    const close = new PixelButton(
        scene,
        270,
        -220,
        36,
        28,
        'X',
        () => this.hide(),
        0x55343b,
    );

    this.add(close);


    // ---------------------------------------------------------
    // MACHINE ACTION BUTTONS
    // ---------------------------------------------------------

    for (let index = 0; index < 3; index += 1) {
      const button = new PixelButton(
          scene,
          -190 + index * 190,
          205,
          168,
          34,
          '',
          () => this.runAction(index),
      );

      button.setVisible(false);

      this.buttons.push(button);

      this.add(button);
    }


    // ---------------------------------------------------------
    // CONFIRMATION LAYER
    // ---------------------------------------------------------

    this.confirmLayer = scene.add
        .container(0, 0)
        .setDepth(20)
        .setVisible(false);


    const confirmBg = scene.add
        .rectangle(
            0,
            0,
            410,
            230,
            0x17242d,
            0.995,
        )
        .setStrokeStyle(
            2,
            0xd5a857,
        );


    const confirmTitle = scene.add.text(
        -180,
        -92,
        'WARNING / CONFIRM',
        {
          fontFamily: 'monospace',
          fontSize: '14px',
          color: '#f0c766',
          fontStyle: 'bold',
        },
    );


    this.confirmText = scene.add.text(
        -180,
        -55,
        '',
        {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: '#d9e5e9',
          wordWrap: {
            width: 360,
            useAdvancedWrap: true,
          },
        },
    );


    const cancel = new PixelButton(
        scene,
        -85,
        82,
        130,
        32,
        'CANCEL',
        () => this.hideConfirmation(),
    );


    const confirm = new PixelButton(
        scene,
        85,
        82,
        130,
        32,
        'START',
        () => {
          const action = this.confirmAction;

          this.hideConfirmation();

          action?.();
        },
        0x55343b,
    );


    this.confirmLayer.add([
      confirmBg,
      confirmTitle,
      this.confirmText,
      cancel,
      confirm,
    ]);


    this.add(
        this.confirmLayer,
    );


    this.setVisible(false);
  }


  // ---------------------------------------------------------
  // OPEN PANEL
  // ---------------------------------------------------------

  show(
      machine: MachineState,
      state: FactoryState,
      x: number,
      y: number,
  ): void {
    this.machine = machine;

    this.factoryState = state;

    this.setPosition(
        x,
        y,
    );

    this.setVisible(
        true,
    );

    this.render();
  }


  // ---------------------------------------------------------
  // CLOSE PANEL
  // ---------------------------------------------------------

  hide(): void {
    if (!this.visible) {
      return;
    }

    this.hideConfirmation();

    this.setVisible(
        false,
    );

    this.onClose();
  }


  // ---------------------------------------------------------
  // UPDATE FACTORY STATE
  //
  // Do NOT call this setState().
  // Phaser already has Container.setState().
  // ---------------------------------------------------------

  setFactoryState(
      state: FactoryState,
  ): void {
    this.factoryState = state;

    if (
        !this.visible ||
        !this.machine
    ) {
      return;
    }


    const updated =
        state.machines.find(
            (item) =>
                item.id === this.machine?.id,
        );


    if (updated) {
      this.machine = updated;
    }


    this.render();
  }


  getMachineId(): number | undefined {
    return this.machine?.id;
  }


  // ---------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------

  private render(): void {
    if (
        !this.machine ||
        !this.factoryState
    ) {
      return;
    }


    const machine =
        this.machine;


    const maintenance =
        this.maintenanceFor(
            machine.id,
        );


    const activeMaintenance =
        maintenance !== undefined &&
        maintenance.status !== 'COMPLETED' &&
        maintenance.status !== 'FAILED';


    const displayStatus =
        activeMaintenance
            ? 'MAINTENANCE'
            : machine.status;


    this.title.setText(
        `MACHINE M${String(machine.id).padStart(2, '0')} — ${displayStatus}`,
    );


    // -------------------------------------------------------
    // PANEL CONTENT
    // -------------------------------------------------------

    this.bodyText.setText(
        [
          'PHYSICAL MEASUREMENTS',

          `Health           ${machine.health?.toFixed(0) ?? '--'} %`,

          `Load             ${machine.load.toFixed(0)} %`,

          `RPM              ${machine.rpm.toFixed(0)}`,

          `Temperature      ${machine.temperature.toFixed(1)} °C`,

          `Vibration        ${machine.vibration.toFixed(2)}`,

          `Current          ${machine.current.toFixed(1)} A`,

          `Cooling          ${machine.coolingSetpoint.toFixed(0)} %`,

          '',

          'DIGITAL TWIN',

          `State            ${machine.digitalTwinStatus ?? 'UNKNOWN'}`,

          '',

          'AI PREDICTION',

          `${healthForecastLabel(machine).padEnd(16)} ${machine.predictedHealth?.toFixed(0) ?? '--'} %`,

          `Failure risk     ${machine.failureRisk ?? 'UNKNOWN'}`,

          `Suspected fault  ${machine.suspectedFault ?? 'None'}`,

          '',

          'DECISION ENGINE',

          `Recommended      ${machine.recommendedAction ?? 'NONE'}`,

          maintenance
              ? `Maintenance      ${maintenance.status} · ${maintenance.progress ?? 0}%`
              : '',

          maintenance?.technicianId
              ? `Technician       ${maintenance.technicianId}`
              : '',

          maintenance?.repairType
              ? `Repair           ${maintenance.repairType}`
              : '',

          maintenance?.estimatedCompletion
              ? `ETA              ${this.shortTime(
                  maintenance.estimatedCompletion,
              )} simulated`
              : '',
        ]
            .filter(
                (line, index, lines) =>
                    !(
                        line === '' &&
                        lines[index - 1] === ''
                    ),
            )
            .join('\n'),
    );


    // -------------------------------------------------------
    // ACTIONS
    // -------------------------------------------------------

    this.actions =
        this.actionsFor(
            machine,
            maintenance,
        );


    this.buttons.forEach(
        (button, index) => {
          const action =
              this.actions[index];


          if (!action) {
            button.setVisible(
                false,
            );

            return;
          }


          button
              .setVisible(true)
              .setLabel(
                  action.label,
              )
              .setEnabled(
                  !this.pending,
              );
        },
    );


    // -------------------------------------------------------
    // STATUS MESSAGE
    // -------------------------------------------------------

    if (
        machine.status === 'OFFLINE'
    ) {
      this.commandStatus.setText(
          'MACHINE OFFLINE · commands unavailable.',
      );

      return;
    }


    if (
        activeMaintenance &&
        maintenance
    ) {
      this.commandStatus.setText(
          `Maintenance ${maintenance.status}. START is unavailable until completion.`,
      );
    }
  }


  // ---------------------------------------------------------
  // AVAILABLE MACHINE ACTIONS
  // ---------------------------------------------------------

  private actionsFor(
      machine: MachineState,
      maintenance?: MaintenanceRequest,
  ): Action[] {

    if (
        maintenance &&
        maintenance.status !== 'COMPLETED' &&
        maintenance.status !== 'FAILED'
    ) {
      return [];
    }


    if (
        machine.status === 'OFFLINE'
    ) {
      return [];
    }


    if (
        machine.status === 'RUNNING'
    ) {
      return [
        {
          label: 'REDUCE LOAD',
          command: 'REDUCE_LOAD',
          value: Math.max(0, Math.round(machine.load - 55)),
        },

        {
          label: 'COOLING 90',
          command: 'SET_COOLING',
          value: 90,
        },

        {
          label: 'STOP',
          command: 'STOP',
        },
      ];
    }


    if (
        machine.status === 'STOPPED'
    ) {
      return [
        {
          label: 'START',
          command: 'START',

          confirm:
              machine.failureRisk === 'HIGH' ||
              machine.failureRisk === 'CRITICAL',
        },

        {
          label: 'REQUEST MAINTENANCE',
          command: 'REQUEST_MAINTENANCE',
        },
      ];
    }


    if (
        machine.status === 'FAULT'
    ) {
      return [
        {
          label: 'REQUEST MAINTENANCE',
          command: 'REQUEST_MAINTENANCE',
        },
      ];
    }


    return [];
  }


  // ---------------------------------------------------------
  // ACTION EXECUTION
  // ---------------------------------------------------------

  private runAction(
      index: number,
  ): void {
    const action =
        this.actions[index];

    const machine =
        this.machine;


    if (
        !action ||
        !machine ||
        this.pending
    ) {
      return;
    }


    if (
        action.command === 'START' &&
        action.confirm
    ) {
      this.confirmText.setText(
          `M${String(machine.id).padStart(2, '0')} still has ${machine.failureRisk} predicted failure risk.\n\nStart machine anyway?\n\nThe backend/PLC may still reject START.`,
      );


      this.confirmAction =
          () => this.send(
              action,
          );


      this.confirmLayer.setVisible(
          true,
      );


      return;
    }


    this.send(
        action,
    );
  }


  // ---------------------------------------------------------
  // SEND COMMAND TO BACKEND
  // ---------------------------------------------------------

  private send(
      action: Action,
  ): void {
    const machine =
        this.machine;


    if (!machine) {
      return;
    }

    if (action.command === 'REDUCE_LOAD' && action.value === 0) {
      this.commandStatus
          .setColor('#7fe3b2')
          .setText('LOAD ALREADY AT OR BELOW 55%.');
      return;
    }


    this.pending =
        true;


    this.commandStatus
        .setColor('#f0c766')
        .setText(
            `SENDING ${action.command}…`,
        );


    this.render();


    void this.backend
        .sendCommand(
            machine.id,
            action.command,
            action.value,
        )
        .then(
            (result) => {
              this.commandStatus.setColor(
                  result.accepted
                      ? '#7fe3b2'
                      : '#ef8a7f',
              );


              this.commandStatus.setText(
                  result.accepted
                      ? `COMMAND ACKNOWLEDGED · ${result.message}`
                      : `COMMAND REJECTED · ${result.message}`,
              );
            },
        )
        .catch(
            (error: unknown) => {
              this.commandStatus
                  .setColor('#ef8a7f')
                  .setText(
                      `COMMAND REJECTED · ${String(error)}`,
                  );
            },
        )
        .finally(
            () => {
              this.pending =
                  false;

              this.render();
            },
        );
  }


  // ---------------------------------------------------------
  // MAINTENANCE
  // ---------------------------------------------------------

  private maintenanceFor(
      machineId: number,
  ): MaintenanceRequest | undefined {
    return this.factoryState
        ?.maintenance
        .find(
            (item) =>
                item.machineId === machineId &&
                item.status !== 'FAILED',
        );
  }


  // ---------------------------------------------------------
  // CONFIRMATION
  // ---------------------------------------------------------

  private hideConfirmation(): void {
    this.confirmAction =
        undefined;

    this.confirmLayer.setVisible(
        false,
    );
  }


  // ---------------------------------------------------------
  // SIMULATED TIME DISPLAY
  // ---------------------------------------------------------

  private shortTime(
      value: string,
  ): string {
    const date =
        new Date(value);


    return `${String(
        date.getUTCHours(),
    ).padStart(
        2,
        '0',
    )}:${String(
        date.getUTCMinutes(),
    ).padStart(
        2,
        '0',
    )}`;
  }
}
