import Phaser from 'phaser';
import { isAIMessageExpired, type AIMessage } from '../models/AIMessage';
import { PixelButton } from './PixelButton';

const ACCENTS = {
  INFO: 0x6cc7c8,
  WARNING: 0xe4b958,
  CRITICAL: 0xe86666,
} as const;

export class AIAssistantUI extends Phaser.GameObjects.Container {
  private readonly panel: Phaser.GameObjects.Container;
  private readonly panelBorder: Phaser.GameObjects.Rectangle;
  private readonly kindText: Phaser.GameObjects.Text;
  private readonly metaText: Phaser.GameObjects.Text;
  private readonly titleText: Phaser.GameObjects.Text;
  private readonly messageText: Phaser.GameObjects.Text;
  private readonly actionText: Phaser.GameObjects.Text;
  private readonly actionBanner: Phaser.GameObjects.Rectangle;
  private readonly leftEye: Phaser.GameObjects.Rectangle;
  private readonly rightEye: Phaser.GameObjects.Rectangle;
  private readonly statusLed: Phaser.GameObjects.Rectangle;
  private readonly warningBadge: Phaser.GameObjects.Rectangle;
  private readonly warningCountText: Phaser.GameObjects.Text;
  private readonly avatarScreen: Phaser.GameObjects.Rectangle;
  private readonly openButton: PixelButton;
  private readonly closeButton: PixelButton;

  private current?: AIMessage;
  private latest?: AIMessage;
  private latestWarning?: AIMessage;
  private onComplete?: () => void;
  private remainingMs = 0;
  private activeElapsedMs = 0;
  private panelSuppressed = false;

  constructor(
    scene: Phaser.Scene,
    private readonly onOpenAI: (message?: AIMessage) => void,
  ) {
    super(scene, 0, 0);
    scene.add.existing(this);
    this.setDepth(2960);

    // Compact industrial AI terminal/avatar. All geometry is deliberately pixel-like.
    const avatarFrame = scene.add.rectangle(0, 0, 64, 72, 0x182832, 0.98)
      .setOrigin(0)
      .setStrokeStyle(2, 0x627f8a);
    const antenna = scene.add.rectangle(31, -8, 3, 9, 0x718d98).setOrigin(0.5, 1);
    const antennaTip = scene.add.rectangle(31, -10, 7, 5, 0x6cc7c8).setOrigin(0.5);
    this.avatarScreen = scene.add.rectangle(8, 11, 48, 34, 0x0c171d, 1)
      .setOrigin(0)
      .setStrokeStyle(1, 0x45626d);
    this.leftEye = scene.add.rectangle(18, 23, 8, 4, 0x75e2da).setOrigin(0);
    this.rightEye = scene.add.rectangle(38, 23, 8, 4, 0x75e2da).setOrigin(0);
    const mouthLeft = scene.add.rectangle(22, 34, 8, 2, 0x4c8990).setOrigin(0);
    const mouthRight = scene.add.rectangle(34, 34, 8, 2, 0x4c8990).setOrigin(0);
    this.statusLed = scene.add.rectangle(8, 53, 7, 7, 0x53767f).setOrigin(0);
    const avatarLabel = scene.add.text(22, 50, 'AI', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#d7eef0',
      fontStyle: 'bold',
    });
    const hint = scene.add.text(8, 62, 'ASSIST', {
      fontFamily: 'monospace',
      fontSize: '7px',
      color: '#6f8994',
    });
    this.warningBadge = scene.add.rectangle(51, 0, 28, 19, 0xe4b958)
      .setOrigin(0.5).setVisible(false);
    this.warningCountText = scene.add.text(51, 0, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#101820', fontStyle: 'bold',
    }).setOrigin(0.5).setVisible(false);

    avatarFrame.setInteractive({ useHandCursor: true }).on('pointerdown', () => {
      scene.game.events.emit('ui-click');
      if (this.current) {
        this.panel.setVisible(!this.panel.visible && !this.panelSuppressed);
      } else if (this.latestWarning) {
        this.onOpenAI(this.latestWarning);
      } else if (this.latest && !this.panelSuppressed) {
        this.showReplay(this.latest);
      } else {
        this.onOpenAI(this.latest);
      }
    });

    this.panel = scene.add.container(-448, -72).setVisible(false);
    const shadow = scene.add.rectangle(6, 6, 430, 190, 0x000000, 0.4).setOrigin(0);
    this.panelBorder = scene.add.rectangle(0, 0, 430, 190, 0x101c24, 0.99)
      .setOrigin(0)
      .setStrokeStyle(3, ACCENTS.INFO);
    const headerStrip = scene.add.rectangle(2, 2, 426, 28, 0x1b303a, 1).setOrigin(0);
    this.kindText = scene.add.text(12, 9, 'AI · PREDICTION', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#9eece7',
      fontStyle: 'bold',
    });
    this.metaText = scene.add.text(398, 9, '', {
      fontFamily: 'monospace',
      fontSize: '9px',
      color: '#9db1ba',
    }).setOrigin(1, 0);
    this.titleText = scene.add.text(12, 39, '', {
      fontFamily: 'monospace',
      fontSize: '15px',
      color: '#e7f3f5',
      fontStyle: 'bold',
      wordWrap: { width: 400, useAdvancedWrap: true },
      maxLines: 2,
    });
    this.messageText = scene.add.text(12, 76, '', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#c8d9df',
      lineSpacing: 2,
      wordWrap: { width: 406, useAdvancedWrap: true },
      maxLines: 5,
    });
    this.actionBanner = scene.add.rectangle(8, 148, 320, 38, 0x263b46, 1)
      .setOrigin(0)
      .setStrokeStyle(2, ACCENTS.INFO);
    this.actionText = scene.add.text(16, 153, '', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#e7f3f5',
      fontStyle: 'bold',
      wordWrap: { width: 304, useAdvancedWrap: true },
      maxLines: 2,
    });
    this.openButton = new PixelButton(scene, 342, 166, 84, 24, 'OPEN AI', () => this.onOpenAI(this.current ?? this.latest));
    this.closeButton = new PixelButton(scene, 408, 16, 24, 20, 'X', () => this.dismissCurrent(false), 0x55343b);
    this.panel.add([
      shadow,
      this.panelBorder,
      headerStrip,
      this.kindText,
      this.metaText,
      this.titleText,
      this.messageText,
      this.actionBanner,
      this.actionText,
      this.openButton,
      this.closeButton,
    ]);

    this.add([
      this.panel,
      avatarFrame,
      antenna,
      antennaTip,
      this.avatarScreen,
      this.leftEye,
      this.rightEye,
      mouthLeft,
      mouthRight,
      this.statusLed,
      this.warningBadge,
      this.warningCountText,
      avatarLabel,
      hint,
    ]);
  }

  setWarningSummary(messages: AIMessage[], history: AIMessage[], currentMinute: number): void {
    if (this.latest && isAIMessageExpired(this.latest, currentMinute)) {
      this.invalidate(this.latest.id);
    }
    this.latestWarning = messages[0] ?? history[0];
    const count = messages.length;
    const hasHistory = history.length > 0;
    this.warningBadge.setFillStyle(count > 0 ? 0xe4b958 : 0x6cc7c8)
      .setVisible(count > 0 || hasHistory);
    this.warningCountText.setText(count > 0 ? (count > 9 ? '9+' : String(count)) : 'LOG')
      .setFontSize(count > 0 ? 11 : 8).setVisible(count > 0 || hasHistory);
  }

  present(message: AIMessage, onComplete: () => void): void {
    this.current = message;
    this.latest = message;
    this.onComplete = onComplete;
    this.remainingMs = message.severity === 'CRITICAL' ? 10500 : message.severity === 'WARNING' ? 8500 : 6500;
    this.activeElapsedMs = 0;
    this.renderMessage(message);
    this.panel.setVisible(!this.panelSuppressed);
    this.setActiveVisual(true, message.severity);
  }

  invalidate(messageId: string): void {
    if (this.current?.id === messageId) {
      this.current = undefined;
      this.onComplete = undefined;
      this.remainingMs = 0;
      this.panel.setVisible(false);
      this.setActiveVisual(false);
    }
    if (this.latest?.id === messageId) this.latest = undefined;
  }

  invalidateMachine(machineId: number): void {
    if (this.current?.machineId === machineId) {
      this.invalidate(this.current.id);
    }
    if (this.latest?.machineId === machineId) {
      this.latest = undefined;
      this.panel.setVisible(false);
    }
  }

  update(deltaMs: number): void {
    if (!this.current || this.panelSuppressed) return;
    this.activeElapsedMs += deltaMs;
    this.remainingMs -= deltaMs;

    // Sparse, low-amplitude eye animation only while the assistant is speaking.
    const phase = Math.floor(this.activeElapsedMs / 420) % 4;
    const eyeWidth = phase === 3 ? 3 : 8;
    this.leftEye.setSize(eyeWidth, 4);
    this.rightEye.setSize(eyeWidth, 4);
    const alpha = 0.65 + (Math.sin(this.activeElapsedMs / 260) + 1) * 0.15;
    this.statusLed.setAlpha(alpha);

    if (this.remainingMs <= 0) this.dismissCurrent(true);
  }

  setSuppressed(suppressed: boolean): void {
    this.panelSuppressed = suppressed;
    this.setVisible(!suppressed);
    if (!suppressed && this.current) this.panel.setVisible(true);
  }

  private showReplay(message: AIMessage): void {
    this.renderMessage(message);
    this.panel.setVisible(true);
  }

  private renderMessage(message: AIMessage): void {
    const accent = ACCENTS[message.severity];
    const accentCss = `#${accent.toString(16).padStart(6, '0')}`;
    this.panelBorder.setStrokeStyle(3, accent);
    this.actionBanner.setStrokeStyle(2, accent).setFillStyle(accent, 0.18);
    this.kindText.setText(`AI · ${message.kind}`).setColor(accentCss);

    const machine = message.machineId === undefined ? 'FACTORY' : `M${String(message.machineId).padStart(2, '0')}`;
    const confidence = message.confidence === undefined ? '' : ` · ${this.formatConfidence(message.confidence)}`;
    this.metaText.setText(`${machine} · ${message.severity}${confidence}`);
    this.titleText.setText(message.title);
    this.messageText.setText(message.message);
    const time = this.shortTime(message.timestamp);
    this.actionText.setText(
      message.recommendedAction
        ? `★ BEST ACTION · ${message.recommendedCommand?.label ?? message.recommendedAction}\n${time}`
        : time,
    );
    this.actionBanner.setVisible(Boolean(message.recommendedAction));
  }

  private dismissCurrent(completeQueue: boolean): void {
    if (this.current) this.latest = this.current;
    const done = this.onComplete;
    this.current = undefined;
    this.onComplete = undefined;
    this.remainingMs = 0;
    this.panel.setVisible(false);
    this.setActiveVisual(false);
    if (completeQueue) done?.();
    else done?.();
  }

  private setActiveVisual(active: boolean, severity: AIMessage['severity'] = 'INFO'): void {
    const accent = active ? ACCENTS[severity] : 0x53767f;
    this.statusLed.setFillStyle(accent).setAlpha(active ? 1 : 0.7);
    this.avatarScreen.setStrokeStyle(1, active ? accent : 0x45626d);
    this.leftEye.setFillStyle(active ? 0x9ff7ee : 0x75a7aa).setSize(8, 4);
    this.rightEye.setFillStyle(active ? 0x9ff7ee : 0x75a7aa).setSize(8, 4);
  }

  private formatConfidence(value: number): string {
    const percent = value <= 1 ? value * 100 : value;
    return `${Math.round(Phaser.Math.Clamp(percent, 0, 100))}%`;
  }

  private shortTime(value: string): string {
    const date = new Date(value);
    return `AI MESSAGE · ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} sim`;
  }
}
