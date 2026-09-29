import Phaser from 'phaser';
import { machinePositions } from '../config/machineLayout';
import type { FactoryState } from '../models/FactoryState';
import type { MachineState } from '../models/MachineState';

export class AudioManager {
  private unlocked = false;
  private audioStarted = false;
  private muted = false;
  private masterVolume = 0.65;
  private state?: FactoryState;
  private previousState?: FactoryState;
  private playerX = 300;
  private playerY = 640;
  private walking = false;
  private footstepTimer = 0;
  private pendingAlertSeverity?: 'WARNING' | 'CRITICAL';
  private readonly notifiedAlertIds = new Set<string>();

  private readonly ambience: Phaser.Sound.BaseSound;
  private readonly ventilation: Phaser.Sound.BaseSound;
  private readonly localMotor: Phaser.Sound.BaseSound & { volume: number; rate: number };
  private readonly localFan: Phaser.Sound.BaseSound & { volume: number; rate: number };

  private readonly onUiClick = () => this.playOneShot('ui-click', 0.28);

  constructor(private readonly scene: Phaser.Scene) {
    this.ambience = scene.sound.add('factory-hum', { loop: true, volume: 0.13 });
    this.ventilation = scene.sound.add('ventilation', { loop: true, volume: 0.07 });
    this.localMotor = scene.sound.add('motor-loop', { loop: true, volume: 0 }) as Phaser.Sound.BaseSound & { volume: number; rate: number };
    this.localFan = scene.sound.add('cooling-fan', { loop: true, volume: 0 }) as Phaser.Sound.BaseSound & { volume: number; rate: number };

    scene.input.once('pointerdown', () => this.unlock());
    scene.input.keyboard?.once('keydown', () => this.unlock());
    scene.game.events.on('ui-click', this.onUiClick);

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  setState(state: FactoryState): void {
    this.previousState = this.state;
    this.state = state;
    this.processAlertSounds(state);
    this.processMachineEvents(state);
  }

  setPlayerPosition(x: number, y: number): void {
    this.playerX = x;
    this.playerY = y;
  }

  setWalking(walking: boolean): void {
    this.walking = walking;
  }

  update(deltaMs: number): void {
    if (!this.unlocked || !this.state) return;

    this.footstepTimer -= deltaMs;
    if (this.walking && this.footstepTimer <= 0) {
      this.playOneShot('footstep', 0.15);
      this.footstepTimer = 330;
    }

    const nearest = this.nearestRunningMachine();
    if (!nearest) {
      this.localMotor.volume = 0;
      this.localFan.volume = 0;
      return;
    }

    const { machine, distance } = nearest;
    const proximity = Phaser.Math.Clamp(1 - distance / 380, 0, 1);
    const rpmFactor = Phaser.Math.Clamp(machine.rpm / 3000, 0.2, 1.25);
    const coolingFactor = Phaser.Math.Clamp(machine.coolingSetpoint / 100, 0, 1);

    this.localMotor.volume = 0.20 * proximity;
    this.localMotor.rate = 0.78 + rpmFactor * 0.38;
    this.localFan.volume = 0.11 * proximity * coolingFactor;
    this.localFan.rate = 0.8 + coolingFactor * 0.45;
  }

  playPhoneOpen(): void {
    this.playOneShot('phone-open', 0.30);
  }

  playPhoneClose(): void {
    this.playOneShot('phone-close', 0.26);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyMasterVolume();
    return this.muted;
  }

  setMasterVolume(value: number): void {
    this.masterVolume = Phaser.Math.Clamp(value, 0, 1);
    this.applyMasterVolume();
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  isMuted(): boolean {
    return this.muted;
  }

  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;

    const soundManager = this.scene.sound as Phaser.Sound.BaseSoundManager & { context?: AudioContext };
    const context = soundManager.context;
    if (context?.state === 'suspended') {
      void context.resume().then(() => this.startAudio()).catch(() => {
        // The browser may still require another user gesture. Keep the game silent rather than spamming errors.
      });
      return;
    }

    this.startAudio();
  }

  destroy(): void {
    this.scene.game.events.off('ui-click', this.onUiClick);
    this.ambience.stop();
    this.ventilation.stop();
    this.localMotor.stop();
    this.localFan.stop();
  }

  private processAlertSounds(state: FactoryState): void {
    for (const alert of state.alerts) {
      if (alert.status === 'RESOLVED' || this.notifiedAlertIds.has(alert.id)) continue;
      this.notifiedAlertIds.add(alert.id);
      const severity = alert.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
      if (!this.audioStarted) {
        if (severity === 'CRITICAL' || !this.pendingAlertSeverity) this.pendingAlertSeverity = severity;
        continue;
      }
      this.playOneShot(severity === 'CRITICAL' ? 'critical' : 'warning', severity === 'CRITICAL' ? 0.48 : 0.35);
    }
  }

  private processMachineEvents(state: FactoryState): void {
    if (!this.previousState || !this.audioStarted) return;
    for (const machine of state.machines) {
      const previous = this.previousState.machines.find((item) => item.id === machine.id);
      if (!previous || previous.status === machine.status) continue;
      if (machine.status === 'FAULT') this.playOneShot('fault', 0.48);
      else if (previous.status === 'RUNNING' && machine.status === 'STOPPED') this.playOneShot('machine-stop', 0.36);
      else if (previous.status === 'STOPPED' && machine.status === 'RUNNING') this.playOneShot('machine-start', 0.38);
    }
  }

  private nearestRunningMachine(): { machine: MachineState; distance: number } | undefined {
    if (!this.state) return undefined;
    let best: { machine: MachineState; distance: number } | undefined;
    for (const machine of this.state.machines) {
      if (machine.status !== 'RUNNING') continue;
      const placement = machinePositions.find((item) => item.id === machine.id);
      if (!placement) continue;
      const distance = Phaser.Math.Distance.Between(this.playerX, this.playerY, placement.x, placement.y);
      if (!best || distance < best.distance) best = { machine, distance };
    }
    return best;
  }

  private playOneShot(key: string, volume: number): void {
    if (!this.audioStarted || this.muted) return;
    this.scene.sound.play(key, { volume });
  }

  private startAudio(): void {
    if (this.audioStarted) return;
    this.audioStarted = true;
    this.applyMasterVolume();
    if (!this.ambience.isPlaying) this.ambience.play();
    if (!this.ventilation.isPlaying) this.ventilation.play();
    if (!this.localMotor.isPlaying) this.localMotor.play();
    if (!this.localFan.isPlaying) this.localFan.play();

    if (this.pendingAlertSeverity === 'CRITICAL') this.playOneShot('critical', 0.48);
    else if (this.pendingAlertSeverity === 'WARNING') this.playOneShot('warning', 0.35);
    this.pendingAlertSeverity = undefined;
  }

  private applyMasterVolume(): void {
    this.scene.sound.volume = this.muted ? 0 : this.masterVolume;
  }
}
