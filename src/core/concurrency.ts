// Pi Network — Concurrent task manager

import type { BridgeConfig } from "./config";
import type { TaskEnvelope } from "./tasks";

interface RunningTask {
  envelope: TaskEnvelope;
  startedAt: number;
  lastHeartbeat: number;
}

export class ConcurrencyManager {
  private running: Map<string, RunningTask> = new Map();
  private queue: TaskEnvelope[] = [];
  private maxSlots: number;

  constructor(config: BridgeConfig) {
    this.maxSlots = config.maxConcurrentTasks;
  }

  hasSlot(): boolean {
    return this.running.size < this.maxSlots;
  }

  getAvailableSlots(): number {
    return Math.max(0, this.maxSlots - this.running.size);
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getRunningCount(): number {
    return this.running.size;
  }

  enqueue(envelope: TaskEnvelope): "running" | "queued" {
    if (this.hasSlot()) {
      this.running.set(envelope.taskId, {
        envelope,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
      });
      return "running";
    }
    this.queue.push(envelope);
    return "queued";
  }

  dequeue(): TaskEnvelope | null {
    if (this.queue.length === 0 || !this.hasSlot()) return null;

    // Priority ordering: urgent → high → normal → low
    this.queue.sort((a, b) => {
      const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
      return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
    });

    const next = this.queue.shift()!;
    this.running.set(next.taskId, {
      envelope: next,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    return next;
  }

  complete(taskId: string): TaskEnvelope | null {
    const running = this.running.get(taskId);
    if (!running) return null;
    this.running.delete(taskId);
    return running.envelope;
  }

  heartbeat(taskId: string): void {
    const running = this.running.get(taskId);
    if (running) running.lastHeartbeat = Date.now();
  }

  getUnresponsiveTasks(timeoutMs: number): RunningTask[] {
    const now = Date.now();
    const unresponsive: RunningTask[] = [];
    for (const [, task] of this.running) {
      if (now - task.lastHeartbeat > timeoutMs) {
        unresponsive.push(task);
      }
    }
    return unresponsive;
  }

  getRunningTasks(): RunningTask[] {
    return [...this.running.values()];
  }

  getQueuedTasks(): TaskEnvelope[] {
    return [...this.queue];
  }

  removeFromQueue(taskId: string): TaskEnvelope | null {
    const idx = this.queue.findIndex((t) => t.taskId === taskId);
    if (idx >= 0) return this.queue.splice(idx, 1)[0];
    return null;
  }

  killRunning(taskId: string): TaskEnvelope | null {
    const running = this.running.get(taskId);
    if (!running) return null;
    this.running.delete(taskId);
    return running.envelope;
  }
}
