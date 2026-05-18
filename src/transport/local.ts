// Pi Network — Local transport (LAN only, queues outgoing)

import type { Transport, SendResult } from "./index";
import type { BridgeConfig } from "../core/config";
import type { TaskEnvelope, TaskResult } from "../core/tasks";
import type { FilePayload } from "../core/files";
import { pushToOutbox } from "../core/queue";

export class LocalTransport implements Transport {
  private handler: ((msg: any) => void) | null = null;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async send(peer: string, payload: TaskEnvelope): Promise<SendResult> {
    // Try direct LAN ping first
    if (await this.ping(peer)) {
      try {
        const port = this.config.peers[peer]?.bridgePort || this.config.bridgePort;
        const res = await fetch(`http://${peer}:${port}/task`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return { delivered: true, queued: false };
      } catch {}
    }
    pushToOutbox(peer, payload);
    return { delivered: false, queued: true };
  }

  async sendResult(peer: string, result: TaskResult): Promise<SendResult> {
    try {
      const port = this.config.peers[peer]?.bridgePort || this.config.bridgePort;
      const res = await fetch(`http://${peer}:${port}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { delivered: true, queued: false };
    } catch {}
    return { delivered: false, queued: true };
  }

  async sendFile(peer: string, file: FilePayload): Promise<void> {
    const port = this.config.peers[peer]?.bridgePort || this.config.bridgePort;
    await fetch(`http://${peer}:${port}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file),
      signal: AbortSignal.timeout(30000),
    });
  }

  async sendClarification(peer: string, taskId: string, question: string): Promise<SendResult> {
    return this.send(peer, { taskId, task: question } as any);
  }

  async sendAnswer(peer: string, taskId: string, answer: string): Promise<SendResult> {
    return this.send(peer, { taskId, task: answer } as any);
  }

  async sendKill(peer: string, taskId: string): Promise<void> {
    const port = this.config.peers[peer]?.bridgePort || this.config.bridgePort;
    await fetch(`http://${peer}:${port}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }

  async ping(peer: string): Promise<boolean> {
    try {
      const port = this.config.peers[peer]?.bridgePort || this.config.bridgePort;
      const res = await fetch(`http://${peer}:${port}/ping`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  onMessage(handler: (msg: any) => void): void { this.handler = handler; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
