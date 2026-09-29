import Phaser from 'phaser';
import { FACTORY_WORLD } from '../config/factoryConfig';

export class Player extends Phaser.Physics.Arcade.Sprite {
  private readonly cursors: Phaser.Types.Input.Keyboard.CursorKeys;
  private readonly wasd: Record<'W' | 'A' | 'S' | 'D', Phaser.Input.Keyboard.Key>;
  private moving = false;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'worker', 0);
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setScale(2);
    this.setCollideWorldBounds(true);
    this.setDepth(1000);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setSize(10, 10);
    body.setOffset(3, 13);

    if (!scene.input.keyboard) throw new Error('Keyboard input is unavailable');
    this.cursors = scene.input.keyboard.createCursorKeys();
    this.wasd = scene.input.keyboard.addKeys('W,A,S,D') as Record<'W' | 'A' | 'S' | 'D', Phaser.Input.Keyboard.Key>;
  }

  update(inputEnabled = true): void {
    let x = 0;
    let y = 0;

    if (inputEnabled) {
      if (this.cursors.left.isDown || this.wasd.A.isDown) x -= 1;
      if (this.cursors.right.isDown || this.wasd.D.isDown) x += 1;
      if (this.cursors.up.isDown || this.wasd.W.isDown) y -= 1;
      if (this.cursors.down.isDown || this.wasd.S.isDown) y += 1;
    }

    const vector = new Phaser.Math.Vector2(x, y).normalize().scale(FACTORY_WORLD.playerSpeed);
    this.setVelocity(vector.x, vector.y);
    this.moving = inputEnabled && (x !== 0 || y !== 0);

    if (!this.moving) {
      this.anims.stop();
      return;
    }

    if (Math.abs(x) > Math.abs(y)) {
      this.play(x < 0 ? 'walk-left' : 'walk-right', true);
    } else {
      this.play(y < 0 ? 'walk-up' : 'walk-down', true);
    }
  }

  isMoving(): boolean {
    return this.moving;
  }
}
