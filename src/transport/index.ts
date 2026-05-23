// Pi Network — Transport interface + factory

import type { BridgeConfig, NetworkMode } from "../core/config";
import type { TaskEnvelope, TaskResult } from "../core/tasks";
import type { FilePayload } from "../core/files";

export interface SendResult {
  delivered: boolean;
  queued: boolean;
}

export interface Transport {
  send(peer: string, payload: TaskEnvelope): Promise<SendResult>;
  sendResult(peer: string, result: TaskResult): Promise<SendResult>;
  sendFile(peer: string, file: FilePayload): Promise<void>;
  sendClarification(peer: string, taskId: string, question: string): Promise<SendResult>;
  sendAnswer(peer: string, taskId: string, answer: string): Promise<SendResult>;
  sendKill(peer: string, taskId: string): Promise<void>;
  ping(peer: string): Promise<boolean>;
  onMessage(handler: (msg: any) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createTransport(mode: NetworkMode, config: BridgeConfig): Transport {
  switch (mode) {
    case "tailscale":
      return new (require("./tailscale").TailscaleTransport)(config);
    case "server":
      return new (require("./server").ServerTransport)(config);
    case "hybrid":
      return new (require("./hybrid").HybridTransport)(config);
    case "local":
      return new (require("./local").LocalTransport)(config);
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
}

/**
 * Create a WhatsApp transport if configured.
 * Returns null if WhatsApp is not enabled.
 */
export function createWhatsAppTransport(config: BridgeConfig): Transport | null {
  const waConfig = (config as any).whatsapp;
  if (!waConfig?.enabled) return null;
  const { WhatsAppTransport } = require("./whatsapp");
  return new WhatsAppTransport(config) as Transport;
}
