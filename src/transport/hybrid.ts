// Pi Network — Hybrid transport (Tailscale direct + server fallback)

import type { Transport, SendResult } from "./index";
import type { BridgeConfig } from "../core/config";
import type { TaskEnvelope, TaskResult } from "../core/tasks";
import type { FilePayload } from "../core/files";
import { TailscaleTransport } from "./tailscale";
import { ServerTransport } from "./server";
import { getTailnetPeers } from "../core/config";

export class HybridTransport implements Transport {
  private tailscale: TailscaleTransport;
  private server: ServerTransport;
  private handler: ((msg: any) => void) | null = null;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.tailscale = new TailscaleTransport(config);
    this.server = new ServerTransport(config);
  }

  private isTailscaleReachable(peer: string): boolean {
    const peers = getTailnetPeers();
    return peers.has(peer) && peers.get(peer)!.online;
  }

  async send(peer: string, payload: TaskEnvelope): Promise<SendResult> {
    const peerConfig = this.config.peers[peer];
    if (!peerConfig?.forceServer && this.isTailscaleReachable(peer)) {
      try {
        return await this.tailscale.send(peer, payload);
      } catch {}
    }
    return this.server.send(peer, payload);
  }

  async sendResult(peer: string, result: TaskResult): Promise<SendResult> {
    const peerConfig = this.config.peers[peer];
    if (!peerConfig?.forceServer && this.isTailscaleReachable(peer)) {
      try {
        return await this.tailscale.sendResult(peer, result);
      } catch {}
    }
    return this.server.sendResult(peer, result);
  }

  async sendFile(peer: string, file: FilePayload): Promise<void> {
    const peerConfig = this.config.peers[peer];
    if (!peerConfig?.forceServer && this.isTailscaleReachable(peer)) {
      try {
        return await this.tailscale.sendFile(peer, file);
      } catch {}
    }
    return this.server.sendFile(peer, file);
  }

  async sendClarification(peer: string, taskId: string, question: string): Promise<SendResult> {
    if (this.isTailscaleReachable(peer)) {
      try { return await this.tailscale.sendClarification(peer, taskId, question); } catch {}
    }
    return this.server.sendClarification(peer, taskId, question);
  }

  async sendAnswer(peer: string, taskId: string, answer: string): Promise<SendResult> {
    if (this.isTailscaleReachable(peer)) {
      try { return await this.tailscale.sendAnswer(peer, taskId, answer); } catch {}
    }
    return this.server.sendAnswer(peer, taskId, answer);
  }

  async sendKill(peer: string, taskId: string): Promise<void> {
    if (this.isTailscaleReachable(peer)) {
      await this.tailscale.sendKill(peer, taskId).catch(() => {});
    }
    await this.server.sendKill(peer, taskId).catch(() => {});
  }

  async ping(peer: string): Promise<boolean> {
    const peerConfig = this.config.peers[peer];
    if (!peerConfig?.forceServer) {
      const tsPing = await this.tailscale.ping(peer);
      if (tsPing) return true;
    }
    return this.server.ping(peer);
  }

  onMessage(handler: (msg: any) => void): void {
    this.handler = handler;
    this.tailscale.onMessage(handler);
    this.server.onMessage(handler);
  }

  async start(): Promise<void> {
    await Promise.all([this.tailscale.start(), this.server.start()]);
  }

  async stop(): Promise<void> {
    await Promise.all([this.tailscale.stop(), this.server.stop()]);
  }
}
