// Pi Network — WhatsApp bridge service
// Phase 2.4: Core loop connecting WhatsApp to the mesh network.
// Receives WhatsApp messages → filters → parses → routes → returns results.

import type { BridgeConfig } from "./core/config";
import type { Transport } from "./transport/index";
import type { WhatsAppTransport } from "./transport/whatsapp";
import type { TaskEnvelope, TaskResult } from "./core/tasks";
import { formatHelpText } from "./core/command-parser";
import type { ParsedCommand } from "./core/command-parser";
import { WhatsAppSecurity } from "./core/whatsapp-security";
import { WhatsAppNotifier } from "./core/whatsapp-notify";
import {
  formatTaskResult,
  formatNetworkStatus, formatTaskHistory, formatPeerList,
  formatError, formatOfflinePeer, formatUnknownPeer, formatParseError,
} from "./core/whatsapp-formatter";
import { loadRegistry } from "./core/registry";
import { readHistory } from "./core/task-history";

interface WhatsAppBridgeConfig {
  enabled: boolean;
  evolutionApiUrl: string;
  evolutionApiKey: string;
  instanceName: string;
  allowedNumbers: string[];
  commandPrefix: string;
  defaultReplyTarget: string;
  maxMessageLength: number;
  dedicatedGroupJid?: string;
  notify?: {
    enabled: boolean;
    throttleMs?: number;
  };
}

export class WhatsAppBridge {
  private config: BridgeConfig;
  private waConfig: WhatsAppBridgeConfig;
  private security: WhatsAppSecurity;
  private notifier: WhatsAppNotifier;
  private meshTransport: Transport;
  private waTransport: WhatsAppTransport | null = null;
  private running = false;

  constructor(config: BridgeConfig, transport: Transport) {
    this.config = config;
    this.waConfig = (config as any).whatsapp as WhatsAppBridgeConfig;
    this.meshTransport = transport;

    this.security = new WhatsAppSecurity({
      allowedNumbers: this.waConfig.allowedNumbers,
      maxCommandsPerMinute: 10,
    });

    this.notifier = new WhatsAppNotifier({
      enabled: this.waConfig.notify?.enabled ?? false,
      evolutionApiUrl: this.waConfig.evolutionApiUrl,
      evolutionApiKey: this.waConfig.evolutionApiKey,
      instanceName: this.waConfig.instanceName,
      targetNumber: this.waConfig.allowedNumbers[0],
      throttleMs: this.waConfig.notify?.throttleMs,
    });
  }

  async start(): Promise<void> {
    if (!this.waConfig?.enabled) return;
    this.running = true;

    // Create a dedicated WhatsApp transport for inbound command handling
    const { WhatsAppTransport } = await import("./transport/whatsapp");
    this.waTransport = new WhatsAppTransport(this.config);
    this.waTransport.onMessage((msg) => this.handleInboundMessage(msg));
    await this.waTransport.start();

    console.log("WhatsApp bridge started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.waTransport) {
      await this.waTransport.stop();
      this.waTransport = null;
    }
  }

  private async handleInboundMessage(msg: any): Promise<void> {
    if (msg.type !== "whatsapp-command") return;

    // Security check
    const securityResult = this.security.checkMessage({
      from: msg.from,
      messageId: msg.jid,
      timestamp: msg.timestamp,
    });

    if (!securityResult.allowed) {
      this.security.logCommand(msg.from, msg.raw, `blocked: ${securityResult.reason}`);
      return;
    }

    const parsed: ParsedCommand = msg.parsed;

    try {
      switch (parsed.type) {
        case "task":
          await this.handleTask(msg.from, msg.jid, parsed);
          break;
        case "broadcast":
          await this.handleBroadcast(msg.from, msg.jid, parsed);
          break;
        case "status":
          await this.handleStatus(msg.from);
          break;
        case "peers":
          await this.handlePeers(msg.from);
          break;
        case "history":
          await this.handleHistory(msg.from);
          break;
        case "kill":
          await this.handleKill(msg.from, parsed.taskId);
          break;
        case "help":
          await this.handleHelp(msg.from);
          break;
        default:
          await this.sendReply(msg.from, formatParseError());
      }

      this.security.logCommand(msg.from, msg.raw, "ok");
    } catch (e: any) {
      await this.sendReply(msg.from, formatError(`Internal error: ${e.message}`));
      this.security.logCommand(msg.from, msg.raw, `error: ${e.message}`);
    }
  }

  private async handleTask(from: string, jid: string, parsed: ParsedCommand): Promise<void> {
    if (!parsed.peer || !parsed.task) {
      await this.sendReply(from, formatParseError());
      return;
    }

    const agents = loadRegistry();
    const peer = agents.find(a => a.name === parsed.peer);
    if (!peer) {
      await this.sendReply(from, formatUnknownPeer(parsed.peer, agents.map(a => a.name)));
      return;
    }

    if (peer.status === "offline") {
      await this.sendReply(from, formatOfflinePeer(parsed.peer));
      return;
    }

    // Create and send envelope via transport
    const envelope: TaskEnvelope = {
      taskId: `wa-${Date.now()}`,
      parentTaskId: null,
      rootTaskId: `wa-${Date.now()}`,
      originInstructor: "whatsapp",
      originSession: from,
      chain: [{
        agent: "whatsapp",
        session: from,
        role: "instructor" as const,
        timestamp: Date.now(),
        action: "delegated" as const,
      }],
      task: parsed.task,
      taskType: parsed.options?.mode || "agent",
      status: "queued",
      lockScope: [],
      requiresConsolidation: false,
      deliverTo: "whatsapp",
      priority: parsed.options?.priority || "normal",
      hops: 0,
      userId: from,
    };

    const result = await this.meshTransport.send(parsed.peer, envelope);
    if (result.delivered) {
      await this.sendReply(from, `📤 Task sent to ${parsed.peer}. Result will follow.`);
    } else {
      await this.sendReply(from, formatOfflinePeer(parsed.peer));
    }
  }

  private async handleBroadcast(from: string, jid: string, parsed: ParsedCommand): Promise<void> {
    if (!parsed.task) {
      await this.sendReply(from, formatParseError());
      return;
    }

    const agents = loadRegistry().filter(a => a.status === "online" || a.status === "busy");
    if (agents.length === 0) {
      await this.sendReply(from, formatError("No online peers"));
      return;
    }

    for (const agent of agents) {
      const envelope: TaskEnvelope = {
        taskId: `wa-bcast-${agent.name}-${Date.now()}`,
        parentTaskId: null,
        rootTaskId: `wa-bcast-${Date.now()}`,
        originInstructor: "whatsapp",
        originSession: from,
        chain: [{
          agent: "whatsapp",
          session: from,
          role: "instructor" as const,
          timestamp: Date.now(),
          action: "delegated" as const,
        }],
        task: parsed.task!,
        taskType: parsed.options?.mode || "raw",
        status: "queued",
        lockScope: [],
        requiresConsolidation: false,
        deliverTo: "whatsapp",
        priority: "normal",
        hops: 0,
        userId: from,
      };
      await this.meshTransport.send(agent.name, envelope).catch(() => {});
    }

    await this.sendReply(from, `📢 Broadcast sent to ${agents.length} peer(s)`);
  }

  private async handleStatus(from: string): Promise<void> {
    const agents = loadRegistry();
    await this.sendReply(from, formatNetworkStatus(agents, this.config.localName));
  }

  private async handlePeers(from: string): Promise<void> {
    const agents = loadRegistry();
    await this.sendReply(from, formatPeerList(agents));
  }

  private async handleHistory(from: string): Promise<void> {
    const history = readHistory();
    await this.sendReply(from, formatTaskHistory(history.slice(0, 20)));
  }

  private async handleKill(from: string, taskId?: string): Promise<void> {
    if (!taskId) {
      await this.sendReply(from, formatError("Usage: /kill <taskId>"));
      return;
    }
    // Send kill to all peers
    const agents = loadRegistry().filter(a => a.status === "online");
    for (const agent of agents) {
      await this.meshTransport.sendKill(agent.name, taskId).catch(() => {});
    }
    await this.sendReply(from, `🔪 Kill signal sent for ${taskId}`);
  }

  private async handleHelp(from: string): Promise<void> {
    await this.sendReply(from, formatHelpText());
  }

  private async sendReply(from: string, text: string): Promise<void> {
    // Route through WhatsApp transport
    try {
      await fetch(`${this.waConfig.evolutionApiUrl}/message/sendText/${this.waConfig.instanceName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.waConfig.evolutionApiKey,
        },
        body: JSON.stringify({ number: from, text }),
      });
    } catch {}
  }

  /**
   * Handle a TaskResult that should be sent back to WhatsApp.
   */
  async deliverResult(result: TaskResult): Promise<void> {
    if (result.deliverTo !== "whatsapp") return;
    const formatted = formatTaskResult(result);
    await this.sendReply(result.originSession || this.waConfig.allowedNumbers[0], formatted);
    await this.notifier.notifyTaskComplete(result);
  }
}
