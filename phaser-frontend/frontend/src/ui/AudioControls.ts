import Phaser from 'phaser';
import type { AudioManager } from './AudioManager';
import { PixelButton } from './PixelButton';

export class AudioControls extends Phaser.GameObjects.Container {
  private readonly muteButton: PixelButton;
  private readonly volumeText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, x: number, y: number, private readonly audio: AudioManager) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(2900);

    const panel = scene.add.rectangle(0, 0, 154, 38, 0x12202a, 0.94).setOrigin(0).setStrokeStyle(1, 0x5d747e);
    this.muteButton = new PixelButton(scene, 30, 19, 50, 26, 'SOUND', () => {
      this.audio.toggleMute();
      this.refresh();
    });
    const minus = new PixelButton(scene, 71, 19, 26, 26, '-', () => {
      this.audio.setMasterVolume(this.audio.getMasterVolume() - 0.1);
      this.refresh();
    });
    const plus = new PixelButton(scene, 139, 19, 26, 26, '+', () => {
      this.audio.setMasterVolume(this.audio.getMasterVolume() + 0.1);
      this.refresh();
    });
    this.volumeText = scene.add.text(105, 19, '65', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#c8d9df',
    }).setOrigin(0.5);

    this.add([panel, this.muteButton, minus, plus, this.volumeText]);
    this.refresh();
  }

  private refresh(): void {
    this.muteButton.setLabel(this.audio.isMuted() ? 'MUTED' : 'SOUND');
    this.muteButton.setActiveStyle(!this.audio.isMuted());
    this.volumeText.setText(String(Math.round(this.audio.getMasterVolume() * 100)));
  }
}
