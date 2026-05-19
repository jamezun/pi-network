// Pi Network — Tailscale transport (direct HTTP over WireGuard)

import type { Transport, SendResult } from "./index";
import type { BridgeConfig } from "../core/config";
import type { TaskEnvelope, TaskResult } from "../core/tasks";
import type { FilePayload } from "../core/files";
import { getPeerUrl } from "../core/config";
import { pushToOutbox, readAllOutbox, removeFromOutbox } from "../core/queue";

export class TailscaleTransport implements Transport {
  private handler: ((msg: any) => void) | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async send(peer: string, payload: TaskEnvelope): Promise<SendResult> {
    const url = getPeerUrl(peer, this.config);
    try {
      const res = await fetch(`${url}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { delivered: true, queued: false };
      throw new Error(`HTTP ${res.status}`);
    } catch {
      pushToOutbox(peer, payload);
      return { delivered: false, queued: true };
    }
  }

  async sendResult(peer: string, result: TaskResult): Promise<SendResult> {
    const url = getPeerUrl(peer, this.config);
    try {
      const res = await fetch(`${url}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { delivered: true, queued: false };
      throw new Error(`HTTP ${res.status}`);
    } catch {
      return { delivered: false, queued: true };
    }
  }

  async sendFile(peer: string, file: FilePayload): Promise<void> {
    const url = getPeerUrl(peer, this.config);
    try {
      await fetch(`${url}/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(file),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error(`Failed to send file to ${peer}: peer unreachable`);
    }
  }

  async sendClarification(peer: string, taskId: string, question: string): Promise<SendResult> {
    const url = getPeerUrl(peer, this.config);
    const res = await fetch(`${url}/clarification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, question, from: this.config.localName }),
      signal: AbortSignal.timeout(5000),
    });
    return { delivered: res.ok, queued: !res.ok };
  }

  async sendAnswer(peer: string, taskId: string, answer: string): Promise<SendResult> {
    const url = getPeerUrl(peer, this.config);
    const res = await fetch(`${url}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, answer, from: this.config.localName }),
      signal: AbortSignal.timeout(5000),
    });
    return { delivered: res.ok, queued: !res.ok };
  }

  async sendKill(peer: string, taskId: string): Promise<void> {
    const url = getPeerUrl(peer, this.config);
    await fetch(`${url}/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, from: this.config.localName }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  async ping(peer: string): Promise<boolean> {
    try {
      const url = getPeerUrl(peer, this.config);
      const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  onMessage(handler: (msg: any) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.startRetryLoop();
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  private startRetryLoop(): void {
    this.retryTimer = setInterval(async () => {
      const outbox = readAllOutbox();
      for (const [peer, messages] of Object.entries(outbox)) {
        const online = await this.ping(peer);
        if (!online) continue;

        for (const msg of messages) {
          try {
            const result = await this.send(peer, msg);
            if (result.delivered) {
              removeFromOutbox(peer, msg.taskId);
            } else {
              break;
            }
          } catch {
            break;
          }
        }
      }
    }, this.config.retryInterval * 1000);
  }
}
