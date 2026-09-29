import Phaser from 'phaser';
import { createFactoryBackend } from '../backend/backendFactory';

import floorUrl from '../../assets/floor.png?url';
import wallUrl from '../../assets/wall.png?url';
import hazardUrl from '../../assets/hazard.png?url';
import machineUrl from '../../assets/machine.png?url';
import fanUrl from '../../assets/fan.png?url';
import workerUrl from '../../assets/worker.png?url';
import crateUrl from '../../assets/crate.png?url';
import palletUrl from '../../assets/pallet.png?url';
import cabinetUrl from '../../assets/cabinet.png?url';
import consoleUrl from '../../assets/console.png?url';

import factoryHumUrl from '../../assets/audio/factory_hum.wav?url';
import ventilationUrl from '../../assets/audio/ventilation.wav?url';
import motorLoopUrl from '../../assets/audio/motor_loop.wav?url';
import coolingFanUrl from '../../assets/audio/cooling_fan.wav?url';
import footstepUrl from '../../assets/audio/footstep.wav?url';
import uiClickUrl from '../../assets/audio/ui_click.wav?url';
import phoneOpenUrl from '../../assets/audio/phone_open.wav?url';
import phoneCloseUrl from '../../assets/audio/phone_close.wav?url';
import warningUrl from '../../assets/audio/warning.wav?url';
import criticalUrl from '../../assets/audio/critical.wav?url';
import machineStartUrl from '../../assets/audio/machine_start.wav?url';
import machineStopUrl from '../../assets/audio/machine_stop.wav?url';
import faultUrl from '../../assets/audio/fault.wav?url';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    this.load.image('floor', floorUrl);
    this.load.image('wall', wallUrl);
    this.load.image('hazard', hazardUrl);
    this.load.image('machine', machineUrl);
    this.load.image('fan', fanUrl);
    this.load.spritesheet('worker', workerUrl, { frameWidth: 16, frameHeight: 24 });
    this.load.image('crate', crateUrl);
    this.load.image('pallet', palletUrl);
    this.load.image('cabinet', cabinetUrl);
    this.load.image('console', consoleUrl);

    this.load.audio('factory-hum', factoryHumUrl);
    this.load.audio('ventilation', ventilationUrl);
    this.load.audio('motor-loop', motorLoopUrl);
    this.load.audio('cooling-fan', coolingFanUrl);
    this.load.audio('footstep', footstepUrl);
    this.load.audio('ui-click', uiClickUrl);
    this.load.audio('phone-open', phoneOpenUrl);
    this.load.audio('phone-close', phoneCloseUrl);
    this.load.audio('warning', warningUrl);
    this.load.audio('critical', criticalUrl);
    this.load.audio('machine-start', machineStartUrl);
    this.load.audio('machine-stop', machineStopUrl);
    this.load.audio('fault', faultUrl);
  }

  create(): void {
    for (const texture of ['floor', 'wall', 'hazard', 'machine', 'fan', 'worker', 'crate', 'pallet', 'cabinet', 'console']) {
      this.textures.get(texture).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }

    this.createWorkerAnimations();

    const backend = createFactoryBackend();
    this.registry.set('factoryBackend', backend);

    this.scene.start('FactoryScene');
    this.scene.launch('UIScene');
  }

  private createWorkerAnimations(): void {
    const definitions = [
      ['walk-down', 0, 2],
      ['walk-left', 3, 5],
      ['walk-right', 6, 8],
      ['walk-up', 9, 11],
    ] as const;

    for (const [key, start, end] of definitions) {
      if (this.anims.exists(key)) continue;
      this.anims.create({
        key,
        frames: this.anims.generateFrameNumbers('worker', { start, end }),
        frameRate: 8,
        repeat: -1,
      });
    }
  }
}
