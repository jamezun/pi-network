// Pi Network — Server transport (WebSocket + polling via relay)

import WebSocket from "ws";
import type { Transport, SendResult } from "./index";
import type { BridgeConfig } from "../core/config";
import type { TaskEnvelope, TaskResult } from "../core/tasks";
import type { FilePayload } from "../core/files";

export class ServerTransport implements Transport {
  private ws: WebSocket | null = null;
  private handler: ((msg: any) => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.server!.apiKey}`,
    };
  }

  async send(peer: string, payload: TaskEnvelope): Promise<SendResult> {
    const res = await fetch(`${this.config.server!.url}/send`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ to: peer, from: this.config.localName, payload }),
    });
    return await res.json();
  }

  async sendResult(peer: string, result: TaskResult): Promise<SendResult> {
    const res = await fetch(`${this.config.server!.url}/send`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ to: peer, from: this.config.localName, payload: { type: "result", ...result } }),
    });
    return await res.json();
  }

  async sendFile(peer: string, file: FilePayload): Promise<void> {
    await fetch(`${this.config.server!.url}/file/upload`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ ...file, to: peer, from: this.config.localName }),
    });
  }

  async sendClarification(peer: string, taskId: string, question: string): Promise<SendResult> {
    return this.send(peer, { taskId, task: question, taskType: "agent" } as any);
  }

  async sendAnswer(peer: string, taskId: string, answer: string): Promise<SendResult> {
    return this.send(peer, { taskId, task: answer, taskType: "agent" } as any);
  }

  async sendKill(peer: string, taskId: string): Promise<void> {
    await fetch(`${this.config.server!.url}/send`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ to: peer, from: this.config.localName, payload: { type: "kill", taskId } }),
    });
  }

  async ping(peer: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.config.server!.url}/status?peer=${peer}`,
        { headers: this.authHeaders(), signal: AbortSignal.timeout(3000) }
      );
      const data = await res.json();
      return data.online === true;
    } catch {
      return false;
    }
  }

  onMessage(handler: (msg: any) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.connectWebSocket();
    if (!this.ws) {
      this.pollTimer = setInterval(() => this.poll(), this.config.pollInterval);
    }
    await this.register();
  }

  async stop(): Promise<void> {
    this.ws?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.deregister();
  }

  private async connectWebSocket(): Promise<void> {
    try {
      const wsUrl = this.config.server!.url.replace(/^http/, "ws") + "/ws";
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.config.server!.apiKey}`,
          "X-Peer-Name": this.config.localName,
        },
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handler?.(msg);
        } catch {}
      });

      this.ws.on("close", () => {
        this.ws = null;
        setTimeout(() => this.connectWebSocket(), 3000);
      });

      this.ws.on("error", () => {
        this.ws = null;
      });

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.ws?.terminate();
          this.ws = null;
          reject(new Error("WS timeout"));
        }, 5000);
        this.ws!.once("open", () => { clearTimeout(timeout); resolve(); });
        this.ws!.once("error", (err) => { clearTimeout(timeout); reject(err); });
      });
    } catch {
      this.ws = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(
        `${this.config.server!.url}/inbox?peer=${this.config.localName}`,
        { headers: this.authHeaders() }
      );
      const { messages } = await res.json();
      for (const msg of messages) {
        this.handler?.(msg);
        await fetch(`${this.config.server!.url}/ack`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ id: msg.id, peer: this.config.localName }),
        });
      }
    } catch {}
  }

  private async register(): Promise<void> {
    await fetch(`${this.config.server!.url}/register`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        name: this.config.localName,
        role: this.config.role,
        capabilities: this.config.capabilities,
        specialties: this.config.specialties,
      }),
    });
  }

  private async deregister(): Promise<void> {
    await fetch(`${this.config.server!.url}/deregister`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ name: this.config.localName }),
    }).catch(() => {});
  }
}
