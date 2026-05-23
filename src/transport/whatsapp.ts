// Pi Network — WhatsApp transport layer
// Phase 2.2: Evolution API integration for WhatsApp messaging.

import type { BridgeConfig } from "../core/config";
import type { TaskEnvelope, TaskResult } from "../core/tasks";
import type { FilePayload } from "../core/files";
import type { Transport, SendResult } from "./index";
import { parseCommand } from "../core/command-parser";
import type { ParsedCommand } from "../core/command-parser";

export interface WhatsAppConfig {
  enabled: boolean;
  evolutionApiUrl: string;      // "http://localhost:8080"
  evolutionApiKey: string;
  instanceName: string;          // "pi-network"
  allowedNumbers: string[];      // ["+1234567890"]
  commandPrefix: string;         // "/" or "@pi" or "!"
  defaultReplyTarget: string;   // "whatsapp" or peer name
  maxMessageLength: number;      // 1000
  dedicatedGroupJid?: string;
}

interface EvolutionMessage {
  key: { remoteJid: string; fromMe: boolean; id: string };
  message?: { conversation?: string; extendedTextMessage?: { text: string } };
  messageTimestamp: number;
  pushName?: string;
}

export class WhatsAppTransport implements Transport {
  private config: BridgeConfig;
  private waConfig: WhatsAppConfig;
  private ws: any = null;
  private messageHandler: ((msg: any) => void) | null = null;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.waConfig = (config as any).whatsapp as WhatsAppConfig;
  }

  async start(): Promise<void> {
    if (!this.waConfig?.enabled) return;

    // Ensure Evolution API instance exists
    try {
      await fetch(`${this.waConfig.evolutionApiUrl}/instance/fetchInstances`, {
        headers: { apikey: this.waConfig.evolutionApiKey },
      });
    } catch (e: any) {
      console.error(`WhatsApp: Cannot reach Evolution API at ${this.waConfig.evolutionApiUrl}: ${e.message}`);
      return;
    }

    // Start polling for messages (websocket requires additional deps)
    this.startPolling();
    console.log(`WhatsApp transport started (instance: ${this.waConfig.instanceName})`);
  }

  async stop(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async send(peer: string, payload: TaskEnvelope): Promise<SendResult> {
    // WhatsApp doesn't send tasks to peers directly — it's an inbound-only transport
    return { delivered: false, queued: false };
  }

  async sendResult(peer: string, result: TaskResult): Promise<SendResult> {
    if (!this.waConfig?.enabled) return { delivered: false, queued: false };
    if (result.deliverTo !== "whatsapp" && peer !== "whatsapp") return { delivered: false, queued: false };

    const text = this.formatResultMessage(result);
    return this.sendWhatsAppMessage(text);
  }

  async sendFile(peer: string, file: FilePayload): Promise<void> {
    // Send file as WhatsApp document via Evolution API
    if (!this.waConfig?.enabled) return;
    try {
      const number = this.waConfig.allowedNumbers[0];
      if (!number) return;

      await fetch(`${this.waConfig.evolutionApiUrl}/message/sendDocument/${this.waConfig.instanceName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.waConfig.evolutionApiKey,
        },
        body: JSON.stringify({
          number,
          document: file.content, // base64
          fileName: file.filename,
        }),
      });
    } catch {}
  }

  async sendClarification(peer: string, taskId: string, question: string): Promise<SendResult> {
    if (!this.waConfig?.enabled) return { delivered: false, queued: false };
    return this.sendWhatsAppMessage(`❓ _Clarification needed:_ ${question}`);
  }

  async sendAnswer(peer: string, taskId: string, answer: string): Promise<SendResult> {
    return { delivered: false, queued: false };
  }

  async sendKill(peer: string, taskId: string): Promise<void> {
    // No-op for WhatsApp
  }

  async ping(peer: string): Promise<boolean> {
    if (!this.waConfig?.enabled) return false;
    try {
      const res = await fetch(`${this.waConfig.evolutionApiUrl}/instance/fetchInstances`, {
        headers: { apikey: this.waConfig.evolutionApiKey },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch { return false; }
  }

  onMessage(handler: (msg: any) => void): void {
    this.messageHandler = handler;
  }

  private startPolling(): void {
    if (!this.waConfig) return;
    // Poll Evolution API for new messages every 5 seconds
    this.pollingInterval = setInterval(async () => {
      try {
        const res = await fetch(
          `${this.waConfig.evolutionApiUrl}/chat/fetchMessages/${this.waConfig.instanceName}`,
          {
            headers: { apikey: this.waConfig.evolutionApiKey },
          },
        );
        if (!res.ok) return;
        const data = await res.json();
        // Process messages — filter and route
        if (Array.isArray(data)) {
          for (const msg of data) {
            this.processInboundMessage(msg);
          }
        }
      } catch {}
    }, 5000);
    try { (this.pollingInterval as any).unref?.(); } catch {}
  }

  private processInboundMessage(msg: EvolutionMessage): void {
    if (msg.key.fromMe) return;
    if (!this.messageHandler) return;

    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    if (!text) return;

    const jid = msg.key.remoteJid;
    const number = jid.replace("@s.whatsapp.net", "").replace("@g.us", "");

    // Group filter
    if (this.waConfig.dedicatedGroupJid && jid !== this.waConfig.dedicatedGroupJid) return;

    // Number allowlist
    if (!this.waConfig.allowedNumbers.some(n => number.includes(n.replace("+", "")))) return;

    // Command prefix filter
    if (!text.startsWith(this.waConfig.commandPrefix) && !text.startsWith("@")) return;

    const parsed = parseCommand(text, this.waConfig.commandPrefix);
    if (parsed.type === "unknown") return;

    this.messageHandler({
      type: "whatsapp-command",
      from: number,
      jid,
      parsed,
      timestamp: msg.messageTimestamp * 1000,
      raw: text,
    });
  }

  private async sendWhatsAppMessage(text: string): Promise<SendResult> {
    try {
      const number = this.waConfig.allowedNumbers[0];
      if (!number) return { delivered: false, queued: false };

      // Split long messages
      const chunks = this.splitMessage(text, this.waConfig.maxMessageLength || 1000);

      for (const chunk of chunks) {
        await fetch(`${this.waConfig.evolutionApiUrl}/message/sendText/${this.waConfig.instanceName}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: this.waConfig.evolutionApiKey,
          },
          body: JSON.stringify({
            number,
            text: chunk,
          }),
        });
      }

      return { delivered: true, queued: false };
    } catch (e: any) {
      return { delivered: false, queued: false };
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = maxLen;
      if (remaining.length > maxLen) {
        const lastNewline = remaining.lastIndexOf("\n", maxLen);
        if (lastNewline > maxLen * 0.5) splitAt = lastNewline;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }

  private formatResultMessage(result: TaskResult): string {
    const icon = result.status === "completed" ? "✅" : result.status === "failed" ? "❌" : "📬";
    const preview = result.result.length > 800 ? result.result.slice(0, 800) + "…" : result.result;
    return `${icon} *Result from ${result.from}*\n\n${preview}\n\n_Completed in ${Date.now() - (result as any).timestamp ?? 0}ms_`;
  }
}
