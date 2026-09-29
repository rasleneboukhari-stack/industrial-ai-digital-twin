import Phaser from 'phaser';

export class PixelButton extends Phaser.GameObjects.Container {
  private readonly background: Phaser.GameObjects.Rectangle;
  private readonly label: Phaser.GameObjects.Text;
  private readonly enabledFill: number;
  private readonly hoverFill: number;
  private readonly activeFill = 0x52704f;
  private readonly disabledFill = 0x273137;
  private enabled = true;
  private activeStyle = false;
  private disabledReason?: string;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    width: number,
    height: number,
    text: string,
    private readonly onClick: () => void,
    fill = 0x263b46,
  ) {
    super(scene, x, y);
    this.enabledFill = fill;
    this.hoverFill = fill === 0x55343b ? 0x70424b : 0x36505d;

    this.background = scene.add.rectangle(0, 0, width, height, fill, 1).setStrokeStyle(1, 0x91aab5, 1);
    this.background.setInteractive({ useHandCursor: true });
    this.label = scene.add
      .text(0, 0, text, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#e7f1f5',
        align: 'center',
        wordWrap: { width: Math.max(20, width - 8) },
      })
      .setOrigin(0.5);

    this.add([this.background, this.label]);
    scene.add.existing(this);

    this.background.on('pointerover', () => {
      if (this.enabled && !this.activeStyle) this.background.setFillStyle(this.hoverFill);
    });
    this.background.on('pointerout', () => this.refreshStyle());
    this.background.on('pointerdown', () => {
      if (!this.enabled) return;
      this.scene.game.events.emit('ui-click');
      this.onClick();
    });
  }

  setLabel(text: string): this {
    this.label.setText(text);
    return this;
  }

  setActiveStyle(active: boolean): this {
    this.activeStyle = active;
    this.refreshStyle();
    return this;
  }
  setEnabled(enabled: boolean, reason?: string): this {
    this.enabled = enabled;
    this.disabledReason = enabled ? undefined : reason;
    this.refreshStyle();
    return this;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getDisabledReason(): string | undefined {
    return this.disabledReason;
  }

  private refreshStyle(): void {
    if (!this.enabled) {
      this.background.setFillStyle(this.disabledFill).setStrokeStyle(1, 0x53616a, 0.7);
      this.label.setColor('#73838b').setAlpha(0.8);
      return;
    }
    this.background.setFillStyle(this.activeStyle ? this.activeFill : this.enabledFill).setStrokeStyle(1, 0x91aab5, 1);
    this.label.setColor('#e7f1f5').setAlpha(1);
  }
}
