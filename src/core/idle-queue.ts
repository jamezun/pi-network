// Pi Network — Idle-aware message delivery queue
// Phase 1.2: Queues inbound messages when agent is busy, delivers when idle.

import type { TaskEnvelope } from "./tasks";

export interface PendingMessage {
  envelope: TaskEnvelope;
  receivedAt: number;
  retryCount: number;
}

export class IdleQueue {
  private pending: PendingMessage[] = [];

  enqueue(envelope: TaskEnvelope): void {
    this.pending.push({ envelope, receivedAt: Date.now(), retryCount: 0 });
  }

  dequeueAll(): PendingMessage[] {
    const messages = [...this.pending];
    this.pending = [];
    return messages;
  }

  peek(): PendingMessage | undefined {
    return this.pending[0];
  }

  get length(): number {
    return this.pending.length;
  }

  get isEmpty(): boolean {
    return this.pending.length === 0;
  }

  /**
   * Sort by priority: urgent > high > normal > low, then by receivedAt (FIFO within same priority)
   */
  sortByPriority(): void {
    const order = { urgent: 0, high: 1, normal: 2, low: 3 };
    this.pending.sort((a, b) => {
      const pa = order[a.envelope.priority] ?? 2;
      const pb = order[b.envelope.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.receivedAt - b.receivedAt;
    });
  }
}
