// Pi Network — WhatsApp bridge service
// Phase 2.4: Core loop connecting WhatsApp to the mesh network.
// Receives WhatsApp messages → filters → parses → routes → returns results.

import type { BridgeConfig } from "./core/config";
import type { Transport } from "./transport/index";
import type { WhatsAppTransport } from "./transport/whatsapp";
import type { TaskEnvelope, TaskResult } from "./core/tasks";
import { formatHelpText, fuzzyMatchPeer } from "./core/command-parser";
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

  /** Get agents from live broker data, falling back to file registry */
  private getAgents(): any[] {
    const live = this.getLiveAgents?.();
    if (live && live.length > 0) return live;
    return [];  // No live agents available
  }

  /** Get online agent names for peer matching */
  private getOnlinePeers(): string[] {
    return this.getAgents()
      .filter(a => a.status === "online" || a.status?.includes("idle") || a.status?.includes("online") || a.status?.startsWith("🟢"))
      .map(a => a.name);
  }

  constructor(config: BridgeConfig, transport: Transport, private getLiveAgents?: () => any[], private brokerClient?: any) {
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

    // Feed known peers to the parser for fuzzy matching
    const agents = this.getAgents();
    this.waTransport.setPeers(agents.map(a => a.name));
    // Refresh peers periodically
    this.peerRefreshInterval = setInterval(() => {
      const a = this.getAgents();
      if (this.waTransport) this.waTransport.setPeers(a.map(ag => ag.name));
    }, 30000);

    console.log("WhatsApp bridge started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.peerRefreshInterval) { clearInterval(this.peerRefreshInterval); this.peerRefreshInterval = null; }
    if (this.waTransport) {
      await this.waTransport.stop();
      this.waTransport = null;
    }
  }

  private peerRefreshInterval: ReturnType<typeof setInterval> | null = null;

  private async handleInboundMessage(msg: any): Promise<void> {
    console.log(`WhatsAppBridge.handleInboundMessage: type=${msg.type} from=${msg.from}`);

    // Handle media messages
    if (msg.type === "whatsapp-media") {
      await this.handleMedia(msg);
      return;
    }

    if (msg.type !== "whatsapp-command") return;

    // Security check
    const securityResult = this.security.checkMessage({
      from: msg.from,
      messageId: msg.messageId || msg.jid,
      timestamp: msg.timestamp,
    });

    if (!securityResult.allowed) {
      console.log(`WhatsAppBridge: security blocked ${msg.from}: ${securityResult.reason}`);
      this.security.logCommand(msg.from, msg.raw, `blocked: ${securityResult.reason}`);
      return;
    }

    const parsed: ParsedCommand = msg.parsed;
    console.log(`WhatsAppBridge: routing parsed.type=${parsed.type}`);

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
        case "tasks":
          await this.handleTasks(msg.from);
          break;
        case "grab":
          await this.handleGrab(msg.from);
          break;
        case "post":
          await this.handlePost(msg.from, parsed.task || "");
          break;
        case "settings":
          await this.sendReply(msg.from, `⚙️ Settings available in TUI: /network settings`);
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

    const agents = this.getAgents();
    const matched = fuzzyMatchPeer(parsed.peer, agents.map(a => a.name));
    const peer = matched ? agents.find(a => a.name === matched) : null;
    this.knownPeers = agents.map(a => a.name);
    if (!peer) {
      await this.sendReply(from, formatUnknownPeer(parsed.peer, agents.map(a => a.name)));
      return;
    }

    if (peer.status === "offline" || peer.status?.startsWith("🔴") || peer.status?.startsWith("⚫")) {
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

    // Route: check if peer is local (broker) or remote (HTTP transport)
        console.log(`[WA-bridge] handleTask: peer=${parsed.peer}, brokerConnected=${!!this.brokerClient?.isConnected?.()}`);
        const liveAgents = this.getLiveAgents?.() || [];
        const targetAgent = liveAgents.find((a: any) => a.name.toLowerCase() === parsed.peer.toLowerCase());
        const isLocalPeer = this.brokerClient?.isConnected() && 
          targetAgent && !targetAgent.remote;
        console.log(`[WA-bridge] targetAgent: ${JSON.stringify({name: targetAgent?.name, remote: targetAgent?.remote, status: targetAgent?.status})}, isLocal=${isLocalPeer}`);
        let result: { delivered: boolean; queued?: boolean };
        try {
          if (isLocalPeer) {
            // Local session — deliver via broker
            const brokerResult = await this.brokerClient.send(parsed.peer, { text: parsed.task, expectsReply: true, taskId: envelope.taskId });
            result = { delivered: brokerResult?.delivered ?? false, queued: false };
          } else {
            // Remote peer — deliver via HTTP transport (TailscaleTransport with X-Target-Peer)
            result = await this.meshTransport.send(parsed.peer, envelope);
          }
        } catch (e: any) {
          // First path failed, try the other
          try {
            if (isLocalPeer) {
              result = await this.meshTransport.send(parsed.peer, envelope);
            } else {
              result = await this.meshTransport.send(parsed.peer, envelope);
            }
          } catch (e2: any) {
            await this.sendReply(from, formatError("Failed to deliver: " + e2.message));
            return;
          }
        }
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

    const agents = this.getAgents().filter(a => a.status === "online" || a.status === "busy" || a.status?.includes("idle") || a.status?.startsWith("🟢") || a.status?.startsWith("🟡"));
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
    const agents = this.getAgents();
    await this.sendReply(from, formatNetworkStatus(agents, this.config.localName));
  }

  private async handlePeers(from: string): Promise<void> {
    const agents = this.getAgents();
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
    const agents = this.getAgents().filter(a => a.status === "online");
    for (const agent of agents) {
      await this.meshTransport.sendKill(agent.name, taskId).catch(() => {});
    }
    await this.sendReply(from, `🔪 Kill signal sent for ${taskId}`);
  }

  private async handleTasks(from: string): Promise<void> {
    const { getOpenTasks } = require("./core/task-claim");
    const open = getOpenTasks();
    if (open.length === 0) {
      await this.sendReply(from, "📋 No open tasks. Post one with /post <task>");
      return;
    }
    const lines = open.map(t => {
      const age = Math.round((Date.now() - t.postedAt) / 1000);
      return `📋 ${t.taskId} [${t.priority}] (${age}s)\n   ${t.task.slice(0, 80)}\n   By: ${t.postedBy}`;
    });
    await this.sendReply(from, `*Open Tasks (${open.length}):*\n\n${lines.join("\n\n")}`);
  }

  private async handleGrab(from: string): Promise<void> {
    const { getOpenTasks, claimTask } = require("./core/task-claim");
    const open = getOpenTasks();
    if (open.length === 0) {
      await this.sendReply(from, "❌ No open tasks to grab");
      return;
    }
    const t = claimTask(open[0].taskId, `wa:${from}`);
    if (!t) {
      await this.sendReply(from, "❌ Task already claimed or expired");
      return;
    }
    await this.sendReply(from, `✅ Claimed: ${t.taskId}\n📋 ${t.task.slice(0, 100)}\nPosted by: ${t.postedBy}`);
  }

  private async handlePost(from: string, task: string): Promise<void> {
    if (!task) {
      await this.sendReply(from, "Usage: /post <task description>");
      return;
    }
    const { postTask } = require("./core/task-claim");
    const taskId = `claim-${Date.now().toString(36)}`;
    postTask(taskId, task, `wa:${from}`);
    await this.sendReply(from, `📋 Task posted: ${taskId}\n${task}\n\nWaiting for peers to claim...`);
  }

  private async handleHelp(from: string): Promise<void> {
    await this.sendReply(from, formatHelpText());
  }

  private async handleMedia(msg: any): Promise<void> {
    const { from, media, parsed, raw } = msg;
    if (!media) return;

    // If there's a parsed command with a peer, forward the media as part of a task
    if (parsed?.peer && parsed?.task) {
      const desc = `📎 File: ${media.fileName || media.type}${media.caption ? "\nCaption: " + media.caption : ""}\n\n${parsed.task}`;
      // Create task with file reference
      await this.handleTask(from, from, { ...parsed, task: desc });
      return;
    }

    // Media without command — acknowledge and describe
    const fileType = media.type;
    const fileName = media.fileName || `${fileType} file`;
    await this.sendReply(from, `📎 Received ${fileType}: _${fileName}_${media.caption ? "\nCaption: " + media.caption : ""}\n\n_To process, send with a command like:\n/${this.knownPeers[0] || "peer"} analyze this ${fileType}`);
  }

  private knownPeers: string[] = [];

  private async sendReply(from: string, text: string): Promise<void> {
    console.log(`WhatsAppBridge.sendReply: to=${from} text=${text.substring(0, 50)}`);
    // Route through WhatsApp transport
    try {
      const res = await fetch(`${this.waConfig.evolutionApiUrl}/message/sendText/${this.waConfig.instanceName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.waConfig.evolutionApiKey,
        },
        body: JSON.stringify({ number: from, text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.log(`WhatsAppBridge.sendReply FAILED: ${res.status} ${body}`);
      } else {
        console.log(`WhatsAppBridge.sendReply: sent successfully`);
      }
    } catch (e: any) {
      console.log(`WhatsAppBridge.sendReply error: ${e.message}`);
    }
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

  /**
   * Send a file (docx, xls, pdf, md, etc.) to a WhatsApp number.
   */
  async sendFile(to: string, data: Buffer | string, fileName: string, mimeType: string, caption?: string): Promise<void> {
    const base64 = typeof data === "string" ? data : data.toString("base64");
    console.log("WhatsAppBridge.sendFile:", fileName, "mimeType:", mimeType, "base64 length:", base64.length);
    try {
      const res = await fetch(`${this.waConfig.evolutionApiUrl}/message/sendDocument/${this.waConfig.instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: this.waConfig.evolutionApiKey },
        body: JSON.stringify({
          number: to,
          document: base64,
          fileName: fileName || "file",
          caption: caption || fileName || "",
          mimetype: mimeType,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error("WhatsAppBridge.sendFile FAILED:", res.status, errBody);
      }
    } catch (e: any) {
      console.error(`WhatsApp sendFile error: ${e.message}`);
    }
  }
}
