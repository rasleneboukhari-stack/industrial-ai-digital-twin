import type { AIMessage } from '../models/AIMessage';

/**
 * Presentation-only queue for backend-provided AI messages.
 * It never derives predictions from machine telemetry and never creates AI content itself.
 */
export class AIMessageManager {
  private readonly seenIds = new Set<string>();
  private readonly queue: AIMessage[] = [];
  private active?: AIMessage;
  private initialized = false;

  constructor(
    private readonly present: (message: AIMessage, done: () => void) => void,
    private readonly invalidate: (messageId: string) => void,
  ) {}

  discardForMachine(machineId: number): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index].machineId === machineId) this.queue.splice(index, 1);
    }
    if (this.active?.machineId === machineId) {
      const messageId = this.active.id;
      this.active = undefined;
      this.invalidate(messageId);
      this.presentNext();
    }
  }

  ingest(messages: AIMessage[]): void {
    const ordered = [...messages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    if (!this.initialized) {
      this.initialized = true;
      for (const message of ordered) this.seenIds.add(message.id);
      const latestProminent = [...ordered].reverse().find((message) => message.prominent !== false);
      if (latestProminent) this.queue.push(latestProminent);
      this.presentNext();
      return;
    }

    for (const message of ordered) {
      if (this.seenIds.has(message.id)) continue;
      this.seenIds.add(message.id);
      if (message.prominent !== false) this.queue.push(message);
    }
    this.presentNext();
  }

  getActive(): AIMessage | undefined {
    return this.active;
  }

  private presentNext(): void {
    if (this.active || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.present(next, () => {
      if (this.active?.id !== next.id) return;
      this.active = undefined;
      this.presentNext();
    });
  }
}
