// Pi Network — WhatsApp transport layer
// Phase 2.2: Evolution API integration for WhatsApp messaging.
// Supports text commands, media (images, documents), and file sending.

import type { BridgeConfig } from "../core/config";
import type { TaskEnvelope, TaskResult } from "../core/tasks";
import { parseCommand, setKnownPeers, fuzzyMatchPeer } from "../core/command-parser";
import type { ParsedCommand } from "../core/command-parser";

interface WhatsAppConfig {
  enabled: boolean;
  evolutionApiUrl: string;
  evolutionApiKey: string;
  instanceName: string;
  allowedNumbers: string[];
  commandPrefix: string;
  defaultReplyTarget: string;
  maxMessageLength: number;
  dedicatedGroupJid?: string;
}

interface EvolutionMessage {
  key: { remoteJid: string; remoteJidAlt?: string; fromMe: boolean; id: string; participant?: string; [k: string]: any };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text: string };
    imageMessage?: { url: string; mimetype?: string; caption?: string; [k: string]: any };
    documentMessage?: { url: string; mimetype?: string; fileName?: string; caption?: string; [k: string]: any };
    videoMessage?: { url: string; mimetype?: string; caption?: string; [k: string]: any };
    audioMessage?: { url: string; mimetype?: string; [k: string]: any };
    stickerMessage?: { url: string; [k: string]: any };
    [k: string]: any;
  };
  messageTimestamp: number;
  pushName?: string;
}

interface WhatsAppInboundMsg {
  type: "whatsapp-command" | "whatsapp-media";
  from: string;
  jid: string;
  messageId: string;
  parsed?: ParsedCommand;
  media?: {
    type: "image" | "document" | "video" | "audio";
    url?: string;
    base64?: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
  };
  timestamp: number;
  raw: string;
}

interface SendResult {
  delivered: boolean;
  queued: boolean;
}

interface FilePayload {
  data: Buffer | string;
  fileName: string;
  mimeType: string;
}

export class WhatsAppTransport {
  private config: BridgeConfig;
  private waConfig: WhatsAppConfig;
  private messageHandler: ((msg: WhatsAppInboundMsg) => void) | null = null;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private knownPeers: string[] = [];

  constructor(config: BridgeConfig) {
    this.config = config;
    this.waConfig = (config as any).whatsapp as WhatsAppConfig;
  }

  onMessage(handler: (msg: WhatsAppInboundMsg) => void): void {
    this.messageHandler = handler;
  }

  setPeers(peers: string[]): void {
    this.knownPeers = peers;
    setKnownPeers(peers);
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
    return { delivered: false, queued: false };
  }

  async sendResult(peer: string, result: TaskResult): Promise<SendResult> {
    if (!this.waConfig?.enabled) return { delivered: false, queued: false };
    if (result.deliverTo !== "whatsapp" && peer !== "whatsapp") return { delivered: false, queued: false };
    const text = this.formatResultMessage(result);
    return this.sendWhatsAppMessage(text);
  }

  async sendFile(peer: string, file: FilePayload): Promise<void> {
    if (!this.waConfig?.enabled) return;
    const number = this.waConfig.allowedNumbers[0];
    if (!number) return;

    try {
      const base64Data = typeof file.data === "string" ? file.data : file.data.toString("base64");
      await fetch(`${this.waConfig.evolutionApiUrl}/message/sendDocument/${this.waConfig.instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: this.waConfig.evolutionApiKey },
        body: JSON.stringify({
          number,
          document: base64Data,
          fileName: file.fileName,
          caption: `📎 ${file.fileName}`,
        }),
      });
    } catch (e: any) {
      console.error(`WhatsApp: Failed to send file: ${e.message}`);
    }
  }

  async sendClarification(peer: string, taskId: string, question: string): Promise<SendResult> {
    if (!this.waConfig?.enabled) return { delivered: false, queued: false };
    return this.sendWhatsAppMessage(`❓ _Clarification needed:_ ${question}`);
  }

  async sendKill(peer: string, taskId: string): Promise<SendResult> {
    return { delivered: false, queued: false };
  }

  async startPolling(): Promise<void> {
    if (!this.waConfig) return;
    this.pollingInterval = setInterval(async () => {
      try {
        const res = await fetch(
          `${this.waConfig.evolutionApiUrl}/chat/fetchMessages/${this.waConfig.instanceName}`,
          { headers: { apikey: this.waConfig.evolutionApiKey } },
        );
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          console.log(`WhatsApp: received ${data.length} messages`);
          for (const msg of data) {
            this.processInboundMessage(msg);
          }
        }
      } catch (e: any) { /* silent */ }
    }, 5000);
    try { (this.pollingInterval as any).unref?.(); } catch {}
  }

  private processInboundMessage(msg: EvolutionMessage): void {
    if (!msg || !msg.key || typeof msg.key.remoteJid !== "string") return;
    if (msg.key.fromMe) return;
    if (!this.messageHandler) return;

    const jid = msg.key.remoteJidAlt || msg.key.remoteJid;
    const number = jid.replace("@s.whatsapp.net", "").replace("@g.us", "");

    // Group filter
    if (this.waConfig.dedicatedGroupJid && jid !== this.waConfig.dedicatedGroupJid) return;

    // Number allowlist
    const allowed = this.waConfig.allowedNumbers.some(n => number.includes(n.replace("+", "")));
    if (!allowed) return;

    // Extract text and media
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const media = this.extractMedia(msg);

    // If media present, always process (even without text/command)
    if (media) {
      const commandText = media.caption || text;
      if (commandText && (commandText.startsWith(this.waConfig.commandPrefix) || commandText.startsWith("@"))) {
        const parsed = parseCommand(commandText, this.waConfig.commandPrefix, this.knownPeers);
        this.messageHandler({
          type: "whatsapp-media",
          from: number,
          jid,
          messageId: msg.key?.id || jid,
          parsed: parsed.type !== "unknown" ? parsed : undefined,
          media,
          timestamp: msg.messageTimestamp * 1000,
          raw: commandText,
        });
        return;
      }
      // Media without command — send as media-only message
      this.messageHandler({
        type: "whatsapp-media",
        from: number,
        jid,
        messageId: msg.key?.id || jid,
        media,
        timestamp: msg.messageTimestamp * 1000,
        raw: text || `📎 ${media.fileName || media.type}`,
      });
      return;
    }

    // Text-only messages
    if (!text) return;
    console.log(`WhatsApp inbound: number=${number} text=${text.substring(0, 30)}`);

    // Command prefix filter
    if (!text.startsWith(this.waConfig.commandPrefix) && !text.startsWith("@")) return;

    const parsed = parseCommand(text, this.waConfig.commandPrefix, this.knownPeers);
    console.log(`WhatsApp parsed: type=${parsed.type} peer=${parsed.peer || "n/a"}`);
    if (parsed.type === "unknown") return;

    this.messageHandler({
      type: "whatsapp-command",
      from: number,
      jid,
      messageId: msg.key?.id || jid,
      parsed,
      timestamp: msg.messageTimestamp * 1000,
      raw: text,
    });
  }

  private extractMedia(msg: EvolutionMessage): WhatsAppInboundMsg["media"] | null {
    const m = msg.message;
    if (!m) return null;

    if (m.imageMessage) {
      return {
        type: "image",
        url: m.imageMessage.url,
        mimeType: m.imageMessage.mimetype || "image/jpeg",
        caption: m.imageMessage.caption,
      };
    }
    if (m.documentMessage) {
      return {
        type: "document",
        url: m.documentMessage.url,
        mimeType: m.documentMessage.mimetype || "application/octet-stream",
        fileName: m.documentMessage.fileName || "document",
        caption: m.documentMessage.caption,
      };
    }
    if (m.videoMessage) {
      return {
        type: "video",
        url: m.videoMessage.url,
        mimeType: m.videoMessage.mimetype || "video/mp4",
        caption: m.videoMessage.caption,
      };
    }
    if (m.audioMessage) {
      return {
        type: "audio",
        url: m.audioMessage.url,
        mimeType: m.audioMessage.mimetype || "audio/ogg",
      };
    }
    return null;
  }

  private async sendWhatsAppMessage(text: string): Promise<SendResult> {
    try {
      const number = this.waConfig.allowedNumbers[0];
      if (!number) return { delivered: false, queued: false };

      const chunks = this.splitMessage(text, this.waConfig.maxMessageLength || 1000);
      for (const chunk of chunks) {
        await fetch(`${this.waConfig.evolutionApiUrl}/message/sendText/${this.waConfig.instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: this.waConfig.evolutionApiKey },
          body: JSON.stringify({ number, text: chunk }),
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
    return `${icon} *Result from ${result.from}*\n\n${preview}`;
  }
}
