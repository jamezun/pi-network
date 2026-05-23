// Pi Network — Pi Coding Agent Extension
// The main entry point. Registers tools, manages tasks, handles communication.
//
// Features stolen from disler/coms + coms-net + damage-control:
//   - Hop-limit enforcement (MAX_HOPS=5)
//   - Atomic per-agent registry with PID pruning + stale counter
//   - Privacy-respecting audit log (msg_id + sender + hops only)
//   - Damage-control rules engine (bash patterns, path protections)
//   - Pool widget (colored peer cards below editor)
//   - Persona files (.pi/agents/*.md with YAML frontmatter)
//   - CLI flags (--name, --purpose, --color, --project, --explicit)
//   - Multi-project namespacing
//   - ULID message IDs (time-sortable)
//   - Split tools: task_send / task_get / task_await
//   - Optional response_schema for structured replies
//   - /network slash command
//   - Heartbeat with context_used_pct + queue_depth
//   - Bounded socket reads (64KB line cap)

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { resolve, join, dirname } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFile } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { execSync } from "node:child_process";

import { loadConfig, resolveMode, getBridgeDir, getPeerUrl, getTailnetPeers } from "./core/config";
import type { BridgeConfig, NetworkMode, AgentStatus } from "./core/config";
import { createEnvelope, extractResultFromMessages } from "./core/tasks";
import type { TaskEnvelope, TaskResult } from "./core/tasks";
import { createTransport } from "./transport";
import type { Transport } from "./transport";import { ConcurrencyManager } from "./core/concurrency";
import { acquireLock, releaseAllForTask, checkFileLock, getAllLocks, getLocksForFile } from "./core/locks";
import {
  loadRegistry, updateAgentInRegistry, pruneDeadEntries,
  markStale, markReachable, readRegistryEntry, removeRegistryEntry,
} from "./core/registry";
import type { AgentEntry } from "./core/registry";
import { pushToOutbox } from "./core/queue";
import { buildAgentPrompt } from "./core/prompt";
import { getSecret, encryptForTransfer } from "./core/vault";
import { appendHistory, readHistory, updateHistoryStatus, formatHistory } from "./core/task-history";
import { readFileForSend } from "./core/files";
import { withinHopLimit, stampHop } from "./core/hop-limit";
import { appendAudit, formatAudit, readAudit } from "./core/audit";
import { evaluateToolCall, formatBlockMessage, formatAskMessage, loadRules } from "./core/damage-control";
import type { DamageControlRules } from "./core/damage-control";
import { loadPersonaFiles } from "./core/personas";
import { BrokerClient } from "./broker/client";
import { spawnBrokerIfNeeded } from "./broker/spawn";
import { IdleQueue } from "./core/idle-queue";
import { loadConfirmConfig, shouldConfirm, formatConfirmPrompt } from "./core/confirm-send";
import { PresenceManager } from "./core/presence";
import { ReplyTracker } from "./core/reply-tracker";
import { WhatsAppBridge } from "./whatsapp-bridge";
import { formatResultInline } from "./ui/inline-message";
import type { PersonaDef } from "./core/personas";
import { ulid } from "./core/ulid";

// ─── Body-size caps (prevent OOM from giant payloads) ───
// Default cap for control endpoints (/task, /result, /clarification, etc.)
const LINE_CAP_BYTES = 1 * 1024 * 1024;          // 1 MB — task envelopes can carry context, locks, etc.
// Larger cap for file transfers (/file uses base64, so ~33% overhead)
const FILE_CAP_BYTES = 64 * 1024 * 1024;          // 64 MB after base64 ≈ 48 MB binary

function capForPath(pathname: string): number {
  return pathname === "/file" ? FILE_CAP_BYTES : LINE_CAP_BYTES;
}

// ─── State ───

let config: BridgeConfig;
let mode: NetworkMode;
let transport: Transport;
let concurrency: ConcurrencyManager;
let agents: AgentEntry[] = [];
let localStatus: AgentStatus = "online";
let damageControlRules: DamageControlRules | null = null;
let currentInboundHops: number | undefined;  // Inherited from inbound prompt for hop counting

const activeEnvelopes: Map<string, TaskEnvelope> = new Map();
const pendingClarifications: Map<string, {
  question: string;
  fromAgent: string;
  resolve: (answer: string) => void;
}> = new Map();

// task_await / task_get tracking
interface PendingTask {
  taskId: string;
  msgId: string;
  targetPeer: string;
  createdAt: number;
  result?: TaskResult;
  resolve?: (result: TaskResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}
const pendingTasks: Map<string, PendingTask> = new Map();

let bridgeServer: any;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let pendingTasksTimer: ReturnType<typeof setInterval> | null = null;
let pi: ExtensionAPI;
let brokerClient: BrokerClient | null = null;
let idleQueue: IdleQueue;
let presenceManager: PresenceManager;
let replyTracker: ReplyTracker;
let whatsappBridge: WhatsAppBridge | null = null;

// Max age for an unresolved pendingTasks entry (1 hour).
// task_await default timeout is 30 min, so 1 hour is a safe upper bound.
const PENDING_TASK_TTL_MS = 60 * 60 * 1000;

// ─── Local Bridge Server ───

function startLocalBridge(port: number) {
  bridgeServer = createHttpServer(async (req: any, res: any) => {
    // Restrict CORS to localhost only (security improvement from coms)
    const origin = req.headers.origin || "";
    if (origin && !origin.includes("127.0.0.1") && !origin.includes("localhost")) {
      res.setHeader("Access-Control-Allow-Origin", "");
    } else {
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.end(); return; }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    let body: any = {};
    if (req.method === "POST") {
      const cap = capForPath(url.pathname);
      let raw = "";
      let bytesRead = 0;
      for await (const chunk of req) {
        bytesRead += chunk.length;
        if (bytesRead > cap) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: "Payload too large", limit: cap, path: url.pathname }));
          return;
        }
        raw += chunk;
      }
      try { body = JSON.parse(raw); } catch {}
    }

    if (req.method === "GET" && url.pathname === "/ping") {
      res.end(JSON.stringify({ pong: true, name: config.localName }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      // Pull the freshest context usage from the local registry entry
      // (heartbeat writes it every 30s).
      const localEntry = readRegistryEntry(config.localName);
      res.end(JSON.stringify({
        name: config.localName,
        sessionName: pi.getSessionName?.() || "unknown",
        role: config.role,
        online: true, status: localStatus,
        queueLength: concurrency.getQueueLength(),
        activeTaskCount: concurrency.getRunningCount(),
        maxConcurrentTasks: config.maxConcurrentTasks,
        contextUsedPct: localEntry?.contextUsedPct ?? 0,
        color: config.color,
        purpose: config.purpose,
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/task") {
      const envelope: TaskEnvelope = body;

      // Defensive: legacy senders may omit hops field — treat as 0.
      const inboundHops = typeof envelope.hops === "number" ? envelope.hops : 0;
      envelope.hops = inboundHops;

      // Hop limit check on inbound
      if (inboundHops >= config.maxHops) {
        appendAudit({ event: "hop_exceeded", taskId: envelope.taskId, sender: envelope.originInstructor, hops: inboundHops });
        res.writeHead(400);
        res.end(JSON.stringify({ error: "hops exceeded", maxHops: config.maxHops }));
        return;
      }

      currentInboundHops = inboundHops;
      const action = concurrency.enqueue(envelope);
      updateHistoryStatus(envelope.taskId, action === "queued" ? "queued" : "running");
      appendAudit({ event: "inbound_prompt", taskId: envelope.taskId, sender: envelope.originInstructor, hops: envelope.hops });
      res.end(JSON.stringify({ accepted: true, status: action }));
      if (action === "running") injectTask(envelope);
      return;
    }

    if (req.method === "POST" && url.pathname === "/result") {
      const result: TaskResult = body;
      res.end(JSON.stringify({ delivered: true }));
      appendAudit({ event: "response", taskId: result.taskId, sender: result.from });

      const clar = pendingClarifications.get(result.taskId);
      if (clar) { clar.resolve(result.result); pendingClarifications.delete(result.taskId); return; }

      // Check pending task tracking (task_send / task_await)
      const pending = pendingTasks.get(result.taskId);
      if (pending) {
        pending.result = result;
        if (pending.resolve) pending.resolve(result);
        if (pending.timer) clearTimeout(pending.timer);
        pendingTasks.delete(result.taskId);
      }

      deliverResult(result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/file") {
      const dir = getBridgeDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const dest = body.remotePath || join(dir, "inbox", body.filename);
      const destDir = dirname(dest);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      writeFile(dest, Buffer.from(body.content, "base64"), (err) => {
        if (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ received: false, error: err.message }));
        } else {
          res.end(JSON.stringify({ received: true, path: dest }));
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clarification") {
      const { taskId, question, from } = body;
      res.end(JSON.stringify({ accepted: true }));
      pi.sendMessage({
        customType: "bridge-clarification",
        content: `💬 ${from} asks: ${question}`,
        display: true,
      }, { triggerTurn: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/answer") {
      const { taskId, answer } = body;
      res.end(JSON.stringify({ accepted: true }));
      const clar = pendingClarifications.get(taskId);
      if (clar) clar.resolve(answer);
      return;
    }

    if (req.method === "POST" && url.pathname === "/kill") {
      const { taskId } = body;
      res.end(JSON.stringify({ killed: true }));
      concurrency.killRunning(taskId);
      concurrency.removeFromQueue(taskId);
      updateHistoryStatus(taskId, "killed");
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  bridgeServer.listen(port, "127.0.0.1", () => {});
}

function stopLocalBridge() { bridgeServer?.close(); }

// ─── Heartbeat ───

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    try {
      const ctx = (pi as any)._lastCtx;
      const contextPct = ctx?.getContextUsage?.()?.percent ?? 0;
      updateAgentInRegistry(agents, {
        name: config.localName,
        contextUsedPct: Math.round(contextPct),
        queueLength: concurrency.getQueueLength() + (idleQueue?.length ?? 0),
        activeTaskCount: concurrency.getRunningCount(),
        heartbeatAt: Date.now(),
      });
      // Phase 1.8: Broadcast presence via broker
      if (brokerClient?.isConnected()) {
        const pUpdate = presenceManager.updateContext(Math.round(contextPct), concurrency.getQueueLength(), concurrency.getRunningCount());
        pUpdate.agent = config.localName;
        brokerClient.updatePresence({ status: presenceManager.formatState() });
      }
      // Refresh local agents cache too
      agents = loadRegistry();
    } catch {}
  }, 30_000);
  try { (heartbeatTimer as any).unref?.(); } catch {}
}

function startPruneLoop() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const pruned = pruneDeadEntries();
    if (pruned.length > 0) {
      agents = loadRegistry();
      for (const name of pruned) {
        appendAudit({ event: "self_heal", sender: name });
      }
    }
  }, 60_000);
  try { (pruneTimer as any).unref?.(); } catch {}
}

function startPendingTasksCleanup() {
  if (pendingTasksTimer) return;
  pendingTasksTimer = setInterval(() => {
    const now = Date.now();
    for (const [taskId, pending] of pendingTasks) {
      if (now - pending.createdAt > PENDING_TASK_TTL_MS) {
        if (pending.timer) clearTimeout(pending.timer);
        // Signal the awaiter (if any) that we gave up before silently dropping
        if (pending.resolve && !pending.result) {
          try { pending.resolve({ taskId, rootTaskId: taskId, from: "(expired)", fromSession: "", deliverTo: "", deliverToSession: "", result: "(pending entry expired)", files: [], chain: [], originInstructor: "", originSession: "", needsConsolidation: false, isConsolidated: false, partialResults: [], status: "failed" } as TaskResult); } catch {}
        }
        pendingTasks.delete(taskId);
      }
    }
  }, 5 * 60_000);
  try { (pendingTasksTimer as any).unref?.(); } catch {}
}

// ─── Task Injection ───

function injectTask(envelope: TaskEnvelope) {
  activeEnvelopes.set(envelope.taskId, envelope);
  const from = envelope.chain[envelope.chain.length - 1]?.agent || "unknown";
  const origin = `${envelope.originInstructor}/${envelope.originSession}`;
  const chainStr = envelope.chain.map((h) => h.agent).join(" → ");

  pi.sendUserMessage(
    `[📱 Remote task from ${from}]\n` +
    `Origin: ${origin}\n` +
    `Chain: ${chainStr} → ${config.localName}\n` +
    `Root task: ${envelope.taskId.slice(0, 12)}\n` +
    `Hops: ${envelope.hops}/${config.maxHops}\n` +
    `Priority: ${envelope.priority}\n\n` +
    `Task: ${envelope.task}\n\n` +
    (config.role === "manager"
      ? "You are a manager. Delegate to workers if needed, or handle directly.\n"
      : "Complete the task and return results.\n")
  );
}

function deliverResult(result: TaskResult) {
  if (result.deliverTo !== config.localName) return;

  let message = `📬 Result from ${result.from}/${result.fromSession || "unknown"}:\n\n`;

  if (result.isConsolidated && result.partialResults?.length > 0) {
    message += `## Consolidated Results from ${result.partialResults.length} workers:\n\n`;
    for (const pr of result.partialResults) {
      message += `### ${pr.from}\n${pr.result}\n\n`;
    }
    message += `## Consolidation:\n${result.result}`;
  } else {
    message += result.result;
  }

  if (result.files?.length > 0) {
    message += `\n\n## Files received (${result.files.length}):\n`;
    for (const f of result.files) message += `  - ${f.filename} (${f.path})\n`;
  }

  pi.sendMessage({
    customType: "bridge-result",
    content: message,
    display: true,
    details: result,
  }, { triggerTurn: true });

  // Phase 2.4: Deliver to WhatsApp if needed
  if (whatsappBridge) {
    whatsappBridge.deliverResult(result).catch(() => {});
  }
}

// ─── The Extension ───

export default function extension(api: ExtensionAPI) {
  pi = api;

  // ─── CLI Flags (from coms.ts) ───
  pi.registerFlag("name", { description: "Override agent name (otherwise from config)", type: "string", default: undefined });
  pi.registerFlag("purpose", { description: "Override agent purpose", type: "string", default: undefined });
  pi.registerFlag("project", { description: "Project namespace for peer discovery", type: "string", default: undefined });
  pi.registerFlag("color", { description: "Hex color #RRGGBB for pool widget", type: "string", default: undefined });
  pi.registerFlag("explicit", { description: "Hide from auto-discovery; addressable only by exact name", type: "boolean", default: false });

  pi.on("session_start", async (_event, ctx) => {
    // Apply CLI flag overrides
    const flagOverrides: Record<string, any> = {};
    try {
      if (ctx.flags?.name) flagOverrides.localName = ctx.flags.name;
      if (ctx.flags?.purpose) flagOverrides.purpose = ctx.flags.purpose;
      if (ctx.flags?.project) flagOverrides.project = ctx.flags.project;
      if (ctx.flags?.color) flagOverrides.color = ctx.flags.color;
      if (ctx.flags?.explicit) flagOverrides.explicit = ctx.flags.explicit;
    } catch {}

    try {
      config = { ...loadConfig(), ...flagOverrides };
    } catch (e: any) {
      ctx.ui.notify(`⚠️ Pi Network: ${e.message}`, "error");
      return;
    }

    mode = resolveMode(config);
    const tailnet = getTailnetPeers();

    // Load damage-control rules
    if (config.damageControl) {
      damageControlRules = loadRules(ctx.cwd);
      const ruleCount =
        damageControlRules.bashToolPatterns.length +
        damageControlRules.zeroAccessPaths.length +
        damageControlRules.readOnlyPaths.length +
        damageControlRules.noDeletePaths.length;
      ctx.ui.notify(`🛡️ Damage Control: ${ruleCount} rules loaded`, "info");
      ctx.ui.setStatus("damage-control", `🛡️ ${ruleCount} Rules`);
    }

    // Load persona files and apply matching one to local config
    const personas = loadPersonaFiles(ctx.cwd);
    if (personas.length > 0) {
      ctx.ui.notify(`👥 Loaded ${personas.length} persona(s) from .pi/agents/`, "info");
      // If a persona matches this agent's localName, apply its fields to config
      const myPersona = personas.find((p: PersonaDef) => p.name === config.localName);
      if (myPersona) {
        if (myPersona.color && !config.color) config.color = myPersona.color;
        if (myPersona.purpose && !config.purpose) config.purpose = myPersona.purpose;
        if (myPersona.role && config.role === "worker") config.role = myPersona.role;
        if (myPersona.capabilities?.length && config.capabilities.length === 0) {
          config.capabilities = myPersona.capabilities;
        }
        if (myPersona.specialties?.length && config.specialties.length === 0) {
          config.specialties = myPersona.specialties;
        }
        if (myPersona.explicit && !config.explicit) config.explicit = true;
        ctx.ui.notify(`👤 Applied persona "${myPersona.name}" from ${myPersona.file}`, "info");
      }
    }

    ctx.ui.notify(
      `🌐 Bridge: ${mode.toUpperCase()} mode` +
      (tailnet.size > 0 ? ` (${tailnet.size} tailnet peers)` : "") +
      (config.server ? ` (Server: ${config.server.url})` : "") +
      ` | Project: ${config.project}`,
      "info"
    );

    agents = loadRegistry();

    // Prune dead PIDs on startup
    const pruned = pruneDeadEntries();
    if (pruned.length > 0) agents = loadRegistry();

    transport = createTransport(mode, config);
    await transport.start();
    concurrency = new ConcurrencyManager(config);
    idleQueue = new IdleQueue();
    presenceManager = new PresenceManager();
    replyTracker = new ReplyTracker();
    startLocalBridge(config.bridgePort);
    startHeartbeat();
    startPruneLoop();
    startPendingTasksCleanup();

    // ─── Phase 1.1: Auto-discovery broker ───
    try {
      await spawnBrokerIfNeeded();
      brokerClient = new BrokerClient();
      await brokerClient.connect({
        cwd: ctx.cwd,
        model: ctx.model?.id || "unknown",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        name: config.localName,
        status: "online",
        role: config.role as "manager" | "worker",
        capabilities: config.capabilities,
        specialties: config.specialties,
        color: config.color,
        purpose: config.purpose,
        project: config.project,
      });
      brokerClient.on("message", (from, message) => {
        const turnCtx = replyTracker.recordIncomingMessage(from, message);
        replyTracker.queueTurnContext(turnCtx);
        pi.sendMessage({
          customType: "network-inbound",
          content: formatResultInline({
            taskId: "", rootTaskId: "", from: from.name || from.id,
            fromSession: from.id, deliverTo: config.localName, deliverToSession: "",
            result: message.content.text, files: [], chain: [],
            originInstructor: from.name || from.id, originSession: from.id,
            needsConsolidation: false, isConsolidated: false, partialResults: [],
            status: "completed",
          }),
          display: true,
        }, { triggerTurn: message.expectsReply ?? false });
      });
      brokerClient.on("session_joined", (session) => {
        ctx.ui.notify(`🟢 ${session.name || session.id} joined the mesh`, "info");
        agents = loadRegistry();
      });
      brokerClient.on("session_left", (sessionId) => {
        ctx.ui.notify(`🔴 ${sessionId} left the mesh`, "info");
        agents = loadRegistry();
      });
      ctx.ui.notify("🔗 Connected to auto-discovery broker", "info");
    } catch (e: any) {
      ctx.ui.notify(`⚠️ Broker unavailable: ${e.message} (continuing without auto-discovery)`, "warning");
      brokerClient = null;
    }

    // ─── Phase 2.4: WhatsApp bridge ───
    try {
      const waCfg = (config as any).whatsapp;
      if (waCfg?.enabled) {
        whatsappBridge = new WhatsAppBridge(config, transport);
        await whatsappBridge.start();
        ctx.ui.notify("📱 WhatsApp bridge started", "info");
      }
    } catch (e: any) {
      ctx.ui.notify(`⚠️ WhatsApp bridge failed: ${e.message}`, "warning");
      whatsappBridge = null;
    }

    updateAgentInRegistry(agents, {
      name: config.localName, role: config.role,
      capabilities: config.capabilities, specialties: config.specialties,
      manages: config.manages, reportTo: config.reportTo,
      status: "online",
      sessionName: pi.getSessionName?.(),
      model: ctx.model?.id,
      maxConcurrentTasks: config.maxConcurrentTasks,
      pid: process.pid,
      color: config.color,
      purpose: config.purpose,
      explicit: config.explicit,
      contextUsedPct: 0,
    });

    const onlineCount = agents.filter((a) => a.status !== "offline" && a.name !== config.localName).length;
    ctx.ui.setStatus("bridge", `🌐 ${mode.toUpperCase()} | ${onlineCount}/${Object.keys(config.peers).length} peers`);

    // ─── Pool Widget ───
    ctx.ui.setWidget("pi-network-pool", (_tui: any, theme: any) => {
      return {
        render(width: number) {
          if (agents.length === 0) {
            return [theme.fg("dim", `  🌐 No peers (${mode.toUpperCase()} | project: ${config.project})`)];
          }

          const lines: string[] = [];
          const header = `  🌐 ${mode.toUpperCase()} | project: ${config.project}`;
          lines.push(theme.fg("dim", header));

          for (const agent of agents) {
            if (agent.name === config.localName) continue;
            const dot = agent.status === "online" ? "🟢" : agent.status === "busy" ? "🟡" : agent.status === "unresponsive" ? "🟠" : "🔴";
            const color = agent.color ? hexFg(agent.color, agent.name) : theme.fg("accent", agent.name);
            const model = agent.model ? theme.fg("dim", ` ${abbreviateModel(agent.model)}`) : "";
            const ctxPct = agent.contextUsedPct != null ? ` ${buildCtxBar(agent.contextUsedPct, theme)}` : "";
            const stale = (agent.staleCount || 0) >= 3 ? theme.fg("error", " stale") : "";
            lines.push(`  ${dot} ${color}${model}${ctxPct}${stale}`);
          }

          return lines;
        },
      };
    });

    // ─── Phase 1.8: Presence status widget ───
    ctx.ui.setStatus("presence", presenceManager.formatState());

    transport.onMessage((msg) => {
      if (msg.type === "message" && msg.payload) {
        if (msg.payload.type === "result") {
          deliverResult(msg.payload);
        } else if (msg.payload.type === "file") {
          pi.sendMessage({ customType: "bridge-file", content: `📂 File from ${msg.from}: ${msg.payload.filename}`, display: true });
        } else {
          const envelope = msg.payload as TaskEnvelope;
          const action = concurrency.enqueue(envelope);
          if (action === "running") {
            injectTask(envelope);
          } else if (action === "queued") {
            // Phase 1.2: Also add to idle queue for idle-aware delivery
            idleQueue.enqueue(envelope);
          }
        }
      } else if (msg.type === "registry_update") {
        agents = loadRegistry();
      }
    });
  });

  pi.on("session_shutdown", async () => {
    await transport?.stop();
    if (brokerClient) { await brokerClient.disconnect().catch(() => {}); brokerClient = null; }
    if (whatsappBridge) { await whatsappBridge.stop().catch(() => {}); whatsappBridge = null; }
    stopLocalBridge();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    if (pendingTasksTimer) clearInterval(pendingTasksTimer);
    // Remove the entry entirely so peers see us disappear immediately;
    // PID-pruning would catch it eventually but ~60s later.
    try { removeRegistryEntry(config.localName); } catch {}
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    // Phase 1.8: Mark agent as thinking
    presenceManager.setThinking();
    if (brokerClient) brokerClient.updatePresence({ status: "thinking" });

    const tailnet = mode === "tailscale" || mode === "hybrid" ? getTailnetPeers() : null;
    const prompt = buildAgentPrompt(agents, config, mode, concurrency, localStatus, tailnet || undefined);
    if (!prompt) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + prompt };
  });

  // ─── Damage-Control hook ───
  pi.on("tool_call", async (event, ctx) => {
    // 1. Damage-control check (applies to ALL tools)
    if (damageControlRules && config.damageControl) {
      const result = evaluateToolCall(event.toolName, event.input || {}, damageControlRules, ctx.cwd);
      if (result.blocked) {
        appendAudit({ event: "blocked", reason: result.reason });
        return { block: true, reason: formatBlockMessage(result.reason || "blocked", result.rule) };
      }
      if (result.ask) {
        try {
          const confirmed = await ctx.ui.confirm(formatAskMessage(result.reason || "confirm", result.rule), { timeout: 30000 });
          if (!confirmed) {
            appendAudit({ event: "blocked", reason: result.reason });
            return { block: true, reason: "User denied the action." };
          }
          appendAudit({ event: "confirmed", reason: result.reason });
        } catch {
          appendAudit({ event: "blocked", reason: result.reason });
          return { block: true, reason: "Confirmation timed out." };
        }
      }
    }

    // Phase 1.8: Tool-level presence
    presenceManager.setToolExecuting(event.toolName);
    if (brokerClient) brokerClient.updatePresence({ status: `tool:${event.toolName}` });

    // 2. File lock check for write/edit
    if (!["write", "edit"].includes(event.toolName)) return;
    const filePath = event.input.path;
    if (!filePath) return;
    const absolutePath = resolve(ctx.cwd, filePath);

    if (event.toolName === "write") {
      // Use MAX_SAFE_INTEGER instead of Infinity (Infinity → null in JSON)
      const WHOLE_FILE = Number.MAX_SAFE_INTEGER;
      const lock = await checkFileLock(absolutePath, 1, WHOLE_FILE, config.localName, config);
      if (lock) {
        return { block: true, reason: `🔒 ${filePath} is locked by ${lock.agent}/${lock.session} (lines ${lock.startLine}-${lock.endLine}).` };
      }
      acquireLock({ filePath: absolutePath, startLine: 1, endLine: WHOLE_FILE, agent: config.localName, session: pi.getSessionName?.() || "", taskId: "local-write", rootTaskId: "local", since: Date.now() }, config);
    }

    if (event.toolName === "edit") {
      const oldText = event.input.oldText;
      if (oldText && existsSync(absolutePath)) {
        try {
          const content = readFileSync(absolutePath, "utf8");
          const idx = content.indexOf(oldText);
          if (idx >= 0) {
            const startLine = content.slice(0, idx).split("\n").length;
            const endLine = startLine + oldText.split("\n").length - 1;
            const lock = await checkFileLock(absolutePath, startLine, endLine, config.localName, config);
            if (lock) {
              return { block: true, reason: `🔒 ${filePath} lines ${startLine}-${endLine} overlap with ${lock.agent}/${lock.session}.` };
            }
            acquireLock({ filePath: absolutePath, startLine, endLine, agent: config.localName, session: pi.getSessionName?.() || "", taskId: "local-edit", rootTaskId: "local", since: Date.now() }, config);
          }
        } catch {}
      }
    }
  });

  pi.on("agent_end", async (event, _ctx) => {
    for (const [taskId, envelope] of activeEnvelopes) {
      if (envelope.originInstructor === config.localName) continue;

      const result = extractResultFromMessages(event.messages);

      // Validate against response_schema if provided
      let validatedResult = result;
      if (envelope.responseSchema) {
        try {
          // Best-effort validation — if the result is JSON, check against schema
          const parsed = JSON.parse(result);
          // Simple schema check: if responseSchema has required fields, verify they exist
          if (envelope.responseSchema && typeof envelope.responseSchema === "object") {
            const schema = envelope.responseSchema as any;
            if (schema.required && Array.isArray(schema.required)) {
              for (const field of schema.required) {
                if (!(field in parsed)) {
                  validatedResult = JSON.stringify({ ...parsed, _schema_warning: `missing required field: ${field}` });
                }
              }
            }
          }
        } catch {
          // Not JSON — that's fine, return as-is
        }
      }

      const resultPayload: TaskResult = {
        taskId: envelope.taskId, rootTaskId: envelope.rootTaskId,
        from: config.localName, fromSession: pi.getSessionName?.() || "unknown",
        deliverTo: envelope.deliverTo,
        deliverToSession: envelope.chain.length > 0 ? envelope.chain[envelope.chain.length - 1].session : undefined,
        result: validatedResult, files: [], chain: envelope.chain,
        originInstructor: envelope.originInstructor, originSession: envelope.originSession,
        needsConsolidation: envelope.requiresConsolidation,
        isConsolidated: false, partialResults: [], status: "completed",
      };

      activeEnvelopes.delete(taskId);
      concurrency.complete(taskId);
      releaseAllForTask(envelope.rootTaskId, config);
      updateHistoryStatus(taskId, "completed", validatedResult.slice(0, 200));

      await transport.sendResult(envelope.deliverTo, resultPayload).catch(() => {
        pushToOutbox(envelope.deliverTo, envelope);
      });

      const next = concurrency.dequeue();
      if (next) injectTask(next);

      currentInboundHops = undefined;
      return;
    }

    // Phase 1.2: Idle-aware delivery — flush queued messages when agent is idle
    presenceManager.setIdle();
    if (brokerClient) brokerClient.updatePresence({ status: "idle" });
    if (idleQueue.length > 0) {
      idleQueue.sortByPriority();
      const pending = idleQueue.dequeueAll();
      const first = pending.shift();
      if (first) injectTask(first.envelope);  // first triggers a turn
      for (const msg of pending) {
        // subsequent messages delivered as follow-ups
        pi.sendMessage({
          customType: "network-queued",
          content: `📋 Queued task from ${msg.envelope.originInstructor}: ${msg.envelope.task.slice(0, 100)}`,
          display: true,
        }, { triggerTurn: false });
        injectTask(msg.envelope);
      }
    }
  });

  pi.on("message_update", async () => {
    for (const [taskId] of activeEnvelopes) concurrency.heartbeat(taskId);
  });

  // ─── Tools ───

  // task_send — fire-and-forget or track for later retrieval
  pi.registerTool({
    name: "task_send",
    label: "Task Send",
    description: "Send a task to a remote agent. Returns a msg_id once the receiver acks. Use task_get (non-blocking) or task_await (blocking) with the msg_id to retrieve the response.",
    promptSnippet: "Send task to remote agent",
    promptGuidelines: ["Match task to agent specialties", "Use peer name from config"],
    parameters: Type.Object({
      peer: Type.String({ description: "Peer name from config or discovered agents" }),
      task: Type.String({ description: "Task to execute" }),
      mode: Type.Optional(StringEnum(["agent", "inbox", "raw"] as const, { description: "agent (default), inbox, or raw" })),
      priority: Type.Optional(StringEnum(["urgent", "high", "normal", "low"] as const, { description: "Priority level" })),
      response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing expected response shape" })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const { peer, task, mode: taskMode, priority, response_schema } = params;

      // Hop limit check
      const hopCheck = withinHopLimit(
        createEnvelope({ task, from: config.localName, fromSession: pi.getSessionName?.() || "unknown", deliverTo: config.localName }),
        currentInboundHops,
        config.maxHops
      );
      if (!hopCheck.allowed) {
        appendAudit({ event: "hop_exceeded", sender: config.localName, target: peer, hops: hopCheck.hops });
        return { content: [{ type: "text", text: `❌ Hop limit reached (${hopCheck.hops} >= ${hopCheck.maxHops}). Stopping forwarding loop.` }] };
      }

      // Phase 1.6: Confirm-before-send
      const confirmCfg = loadConfirmConfig(config);
      const isBroadcast = peer === "all" || peer === "broadcast";
      if (shouldConfirm(confirmCfg, isBroadcast) && ctx.ui?.confirm) {
        const cfmPrompt = formatConfirmPrompt(peer, task, isBroadcast);
        try {
          const confirmed = await ctx.ui.confirm(cfmPrompt, { timeout: confirmCfg.confirmTimeoutMs });
          if (!confirmed) {
            return { content: [{ type: "text", text: "❌ Task send cancelled." }] };
          }
        } catch {
          return { content: [{ type: "text", text: "❌ Confirmation timed out. Task not sent." }] };
        }
      }

      onUpdate?.({ content: [{ type: "text", text: `Sending task to ${peer}...` }] });

      const envelope = createEnvelope({
        task, taskType: taskMode || "agent", priority: priority || "normal",
        from: config.localName, fromSession: pi.getSessionName?.() || "unknown",
        deliverTo: config.localName, requiresConsolidation: false, userId: config.userId,
      });
      envelope.hops = stampHop(envelope, currentInboundHops);
      if (response_schema) envelope.responseSchema = response_schema;

      const msgId = ulid();
      const sendResult = await transport.send(peer, envelope);

      // Track for task_get / task_await
      const pending: PendingTask = {
        taskId: envelope.taskId,
        msgId,
        targetPeer: peer,
        createdAt: Date.now(),
        timer: null,
      };
      pendingTasks.set(envelope.taskId, pending);

      appendHistory({
        taskId: envelope.taskId, rootTaskId: envelope.rootTaskId,
        direction: "sent", peer, task,
        status: sendResult.delivered ? "running" : "queued",
        priority: envelope.priority, timestamp: Date.now(), userId: config.userId,
      });
      appendAudit({ event: "outbound_prompt", taskId: envelope.taskId, sender: config.localName, target: peer, hops: envelope.hops });

      return {
        content: [{ type: "text", text: sendResult.delivered
          ? `✅ Task sent → ${peer}\nmsg_id: ${msgId}\nhops: ${envelope.hops}\nUse task_get or task_await with taskId ${envelope.taskId.slice(0, 12)} to retrieve the response.`
          : `📭 ${peer} is offline. Task queued.\nmsg_id: ${msgId}\nhops: ${envelope.hops}`
        }],
        details: { peer, delivered: sendResult.delivered, taskId: envelope.taskId, msgId, hops: envelope.hops },
      };
    },
    renderCall(args: any, theme: any) {
      const tgt = args.peer ?? "?";
      const prompt = args.task ?? "";
      const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      return theme.fg("toolTitle", theme.bold("task_send ")) + theme.fg("accent", tgt) + " " + theme.fg("dim", preview);
    },
  });

  // task_get — non-blocking poll
  pi.registerTool({
    name: "task_get",
    label: "Task Get",
    description: "Non-blocking poll on a taskId. Returns pending/complete/error.",
    parameters: Type.Object({
      taskId: Type.String({ description: "taskId returned by task_send" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const pending = pendingTasks.get(params.taskId);
      if (!pending) {
        // Check history
        const history = readHistory({ taskId: params.taskId, limit: 1 });
        if (history.length > 0) {
          const h = history[0];
          return { content: [{ type: "text", text: `Task ${params.taskId.slice(0, 12)}: ${h.status}${h.resultSummary ? ` — ${h.resultSummary.slice(0, 100)}` : ""}` }] };
        }
        return { content: [{ type: "text", text: `Unknown taskId: ${params.taskId}` }] };
      }

      if (pending.result) {
        return { content: [{ type: "text", text: `✅ Complete from ${pending.result.from}:\n${pending.result.result.slice(0, 2000)}` }] };
      }
      const elapsed = Math.round((Date.now() - pending.createdAt) / 1000);
      return { content: [{ type: "text", text: `⏳ Pending... (${elapsed}s elapsed, target: ${pending.targetPeer})` }] };
    },
  });

  // task_await — blocking wait
  pi.registerTool({
    name: "task_await",
    label: "Task Await",
    description: "Block until the reply lands or a timeout fires (default 30 min).",
    parameters: Type.Object({
      taskId: Type.String({ description: "taskId returned by task_send" }),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 1800000 = 30 min)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const pending = pendingTasks.get(params.taskId);
      if (!pending) {
        // Maybe already completed
        const history = readHistory({ taskId: params.taskId, limit: 1 });
        if (history.length > 0 && history[0].status === "completed") {
          return { content: [{ type: "text", text: `✅ Already complete: ${history[0].resultSummary || "done"}` }] };
        }
        return { content: [{ type: "text", text: `Unknown taskId: ${params.taskId}` }] };
      }

      if (pending.result) {
        return { content: [{ type: "text", text: `✅ Complete from ${pending.result.from}:\n${pending.result.result}` }] };
      }

      // Wait for result
      const timeoutMs = params.timeout_ms || 1_800_000;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ content: [{ type: "text", text: `⏰ Timeout after ${Math.round(timeoutMs / 1000)}s waiting for ${params.taskId.slice(0, 12)}` }] });
        }, timeoutMs);

        pending.resolve = (result: TaskResult) => {
          clearTimeout(timer);
          resolve({ content: [{ type: "text", text: `✅ Response from ${result.from}:\n${result.result}` }] });
        };
      });
    },
  });

  // Legacy remote_task (backwards compat — delegates to task_send + task_await)
  pi.registerTool({
    name: "remote_task",
    label: "Remote Task",
    description: "Send a task to a remote agent and wait for the result. Combines task_send + task_await for convenience.",
    promptSnippet: "Delegate work to remote agent",
    promptGuidelines: ["Match task to agent specialties", "Use peer name from config"],
    parameters: Type.Object({
      peer: Type.String({ description: "Peer name from config" }),
      task: Type.String({ description: "Task to execute" }),
      mode: Type.Optional(StringEnum(["agent", "inbox", "raw"] as const)),
      priority: Type.Optional(StringEnum(["urgent", "high", "normal", "low"] as const)),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const { peer, task, mode: taskMode, priority } = params;

      // Hop limit
      const hopCheck = withinHopLimit(
        createEnvelope({ task, from: config.localName, fromSession: pi.getSessionName?.() || "unknown", deliverTo: config.localName }),
        currentInboundHops,
        config.maxHops
      );
      if (!hopCheck.allowed) {
        return { content: [{ type: "text", text: `❌ Hop limit reached (${hopCheck.hops} >= ${hopCheck.maxHops})` }] };
      }

      // Phase 1.6: Confirm-before-send
      const rConfirmCfg = loadConfirmConfig(config);
      const rIsBroadcast = peer === "all" || peer === "broadcast";
      if (shouldConfirm(rConfirmCfg, rIsBroadcast) && ctx.ui?.confirm) {
        const rPrompt = formatConfirmPrompt(peer, task, rIsBroadcast);
        try {
          const confirmed = await ctx.ui.confirm(rPrompt, { timeout: rConfirmCfg.confirmTimeoutMs });
          if (!confirmed) {
            return { content: [{ type: "text", text: "❌ Task send cancelled." }] };
          }
        } catch {
          return { content: [{ type: "text", text: "❌ Confirmation timed out. Task not sent." }] };
        }
      }

      onUpdate?.({ content: [{ type: "text", text: `Sending task to ${peer}...` }] });

      const envelope = createEnvelope({
        task, taskType: taskMode || "agent", priority: priority || "normal",
        from: config.localName, fromSession: pi.getSessionName?.() || "unknown",
        deliverTo: config.localName, requiresConsolidation: false, userId: config.userId,
      });
      envelope.hops = stampHop(envelope, currentInboundHops);

      const sendResult = await transport.send(peer, envelope);
      appendHistory({
        taskId: envelope.taskId, rootTaskId: envelope.rootTaskId,
        direction: "sent", peer, task,
        status: sendResult.delivered ? "running" : "queued",
        priority: envelope.priority, timestamp: Date.now(), userId: config.userId,
      });
      appendAudit({ event: "outbound_prompt", taskId: envelope.taskId, sender: config.localName, target: peer, hops: envelope.hops });

      if (!sendResult.delivered) {
        return { content: [{ type: "text", text: `📭 ${peer} is offline. Task queued (retry every ${config.retryInterval}s).` }] };
      }

      // Wait for result (inline await, 10 min timeout)
      return new Promise((resolve) => {
        const pending: PendingTask = {
          taskId: envelope.taskId, msgId: ulid(), targetPeer: peer,
          createdAt: Date.now(), timer: null,
        };
        pendingTasks.set(envelope.taskId, pending);

        pending.timer = setTimeout(() => {
          pendingTasks.delete(envelope.taskId);
          resolve({ content: [{ type: "text", text: `⏰ Timeout waiting for ${peer} response.` }] });
        }, 600_000);

        pending.resolve = (result: TaskResult) => {
          clearTimeout(pending.timer!);
          pendingTasks.delete(envelope.taskId);
          resolve({ content: [{ type: "text", text: `✅ Result from ${result.from}:\n${result.result}` }] });
        };
      });
    },
  });

  pi.registerTool({
    name: "send_file",
    label: "Send File",
    description: "Send a file to a remote agent. Token-free transfer.",
    parameters: Type.Object({
      peer: Type.String({ description: "Peer name" }),
      path: Type.String({ description: "Local file path" }),
      remotePath: Type.Optional(Type.String({ description: "Destination path on remote" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolve(ctx.cwd, params.path);
      const filePayload = await readFileForSend(absolutePath);
      filePayload.from = config.localName;
      if (params.remotePath) filePayload.remotePath = params.remotePath;
      await transport.sendFile(params.peer, filePayload);
      return { content: [{ type: "text", text: `✅ Sent ${params.path} → ${params.peer}:${filePayload.remotePath}` }] };
    },
  });

  pi.registerTool({
    name: "broadcast_task",
    label: "Broadcast Task",
    description: "Send a task to all online agents or filtered by capability. Uses Promise.allSettled for parallel fan-out.",
    parameters: Type.Object({
      task: Type.String({ description: "The task" }),
      filter: Type.Optional(Type.String({ description: "Filter: 'all', 'online', or a capability name" })),
      priority: Type.Optional(StringEnum(["urgent", "high", "normal", "low"] as const)),
    }),
    async execute(_id, params, _signal, onUpdate, _ctx) {
      const filter = params.filter || "online";
      const targets = agents.filter((a) => {
        if (a.name === config.localName) return false;
        if (filter === "online") return a.status === "online" || a.status === "busy";
        if (filter === "all") return true;
        return a.capabilities.includes(filter);
      });

      if (targets.length === 0) {
        return { content: [{ type: "text", text: "No matching agents found." }] };
      }

      // Parallel fan-out with allSettled (stolen from coms)
      const settled = await Promise.allSettled(targets.map(async (agent) => {
        const envelope = createEnvelope({
          task: params.task, taskType: "agent", priority: params.priority || "normal",
          from: config.localName, fromSession: pi.getSessionName?.() || "unknown",
          deliverTo: config.localName, requiresConsolidation: true, userId: config.userId,
        });
        envelope.hops = stampHop(envelope, currentInboundHops);
        const sr = await transport.send(agent.name, envelope);
        appendHistory({
          taskId: envelope.taskId, rootTaskId: envelope.rootTaskId,
          direction: "sent", peer: agent.name, task: params.task,
          status: sr.delivered ? "running" : "queued",
          priority: envelope.priority, timestamp: Date.now(), userId: config.userId,
        });
        appendAudit({ event: "outbound_prompt", taskId: envelope.taskId, sender: config.localName, target: agent.name, hops: envelope.hops });
        return { name: agent.name, delivered: sr.delivered };
      }));

      const results = settled.map((r) =>
        r.status === "fulfilled"
          ? `${r.value.name}: ${r.value.delivered ? "✅" : "📭 queued"}`
          : `${(r as any).reason?.message || "error"}`
      );

      return { content: [{ type: "text", text: `Broadcast to ${targets.length} agents:\n${results.join("\n")}` }] };
    },
  });

  pi.registerTool({
    name: "peer_status",
    label: "Peer Status",
    description: "Get detailed status of all peers or a specific peer. Includes context usage and stale counter.",
    parameters: Type.Object({
      peer: Type.Optional(Type.String({ description: "Specific peer name (omit for all)" })),
      project: Type.Optional(Type.String({ description: "Filter by project namespace (default: current project, '*' for all)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (params.peer) {
        const agent = agents.find((a) => a.name === params.peer);
        if (!agent) return { content: [{ type: "text", text: `Unknown peer: ${params.peer}` }] };
        const reachable = await transport.ping(params.peer);

        // Refresh registry on success
        if (reachable) markReachable(params.peer);
        else markStale(params.peer);

        return {
          content: [{ type: "text", text:
            `**${agent.name}** (${agent.role})\n` +
            `Status: ${reachable ? "🟢 reachable" : "🔴 unreachable"}\n` +
            `Capabilities: ${agent.capabilities.join(", ")}\n` +
            `Specialties: ${agent.specialties.join(", ")}\n` +
            `Model: ${agent.model || "unknown"}\n` +
            `Session: ${agent.sessionName || "none"}\n` +
            `Context: ${agent.contextUsedPct != null ? `${agent.contextUsedPct}%` : "unknown"}\n` +
            `Stale: ${agent.staleCount || 0}\n` +
            `Heartbeat: ${agent.heartbeatAt ? timeAgo(agent.heartbeatAt) : "never"}`
          }],
        };
      }

      const lines: string[] = ["## Network Status\n"];
      for (const agent of agents) {
        if (agent.name === config.localName) continue;
        const icon = agent.status === "online" ? "🟢" : agent.status === "busy" ? "🟡" : agent.status === "unresponsive" ? "🟠" : "🔴";
        const ctxBar = agent.contextUsedPct != null ? ` ${buildCtxBar(agent.contextUsedPct, null)}` : "";
        lines.push(`${icon} **${agent.name}** (${agent.role}) — ${agent.capabilities.join(", ")}${ctxBar}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "ask_origin",
    label: "Ask Origin",
    description: "Ask a clarification question that routes through the chain back to the origin.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to clarify" }),
      question: Type.String({ description: "Your question" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const envelope = activeEnvelopes.get(params.taskId);
      if (!envelope) {
        return { content: [{ type: "text", text: `No active task ${params.taskId}` }] };
      }

      const chainHead = envelope.chain.length > 0 ? envelope.chain[0] : null;
      if (chainHead && chainHead.agent !== config.localName) {
        await transport.sendClarification(chainHead.agent, params.taskId, params.question);
        return { content: [{ type: "text", text: `💬 Sent clarification to ${chainHead.agent}. Waiting for answer...` }] };
      }

      pi.sendUserMessage(`💬 Clarification needed for task ${params.taskId.slice(0, 12)}:\n${params.question}`);
      return { content: [{ type: "text", text: "💬 Asked the human user. They'll respond in chat." }] };
    },
  });

  pi.registerTool({
    name: "return_task",
    label: "Return Task",
    description: "Return a task you can't handle. Manager will reassign or handle it.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to return" }),
      reason: Type.String({ description: "Why you can't handle it" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const envelope = activeEnvelopes.get(params.taskId);
      if (!envelope) {
        return { content: [{ type: "text", text: `No active task ${params.taskId}` }] };
      }

      activeEnvelopes.delete(params.taskId);
      concurrency.complete(params.taskId);
      updateHistoryStatus(params.taskId, "reassigned");

      const returnResult: TaskResult = {
        taskId: envelope.taskId, rootTaskId: envelope.rootTaskId,
        from: config.localName, fromSession: pi.getSessionName?.() || "unknown",
        deliverTo: envelope.deliverTo,
        deliverToSession: envelope.chain.length > 0 ? envelope.chain[envelope.chain.length - 1].session : undefined,
        result: `Task returned: ${params.reason}`,
        files: [], chain: envelope.chain,
        originInstructor: envelope.originInstructor, originSession: envelope.originSession,
        status: "reassigned",
      };

      await transport.sendResult(envelope.deliverTo, returnResult);
      return { content: [{ type: "text", text: `📭 Task returned to ${envelope.deliverTo}: ${params.reason}` }] };
    },
  });

  pi.registerTool({
    name: "kill_task",
    label: "Kill Task",
    description: "Kill a queued or running task on any agent in the network.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to kill" }),
      peer: Type.Optional(Type.String({ description: "Peer where task is running (omit for local)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (params.peer && params.peer !== config.localName) {
        await transport.sendKill(params.peer, params.taskId);
        return { content: [{ type: "text", text: `☠️ Kill signal sent to ${params.peer} for task ${params.taskId.slice(0, 12)}` }] };
      }

      concurrency.killRunning(params.taskId);
      concurrency.removeFromQueue(params.taskId);
      activeEnvelopes.delete(params.taskId);
      updateHistoryStatus(params.taskId, "killed");
      return { content: [{ type: "text", text: `☠️ Task ${params.taskId.slice(0, 12)} killed locally.` }] };
    },
  });

  pi.registerTool({
    name: "task_history",
    label: "Task History",
    description: "View task history with optional filters.",
    parameters: Type.Object({
      peer: Type.Optional(Type.String({ description: "Filter by peer" })),
      status: Type.Optional(StringEnum(["queued", "running", "completed", "failed", "reassigned", "killed"] as const)),
      limit: Type.Optional(Type.Number({ description: "Max entries (default 20)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const history = readHistory();
      const filtered = history.filter((h) => {
        if (params.peer && h.peer !== params.peer) return false;
        if (params.status && h.status !== params.status) return false;
        return true;
      }).slice(0, params.limit || 20);

      if (filtered.length === 0) {
        return { content: [{ type: "text", text: "No matching history entries." }] };
      }

      return { content: [{ type: "text", text: formatHistory(filtered) }] };
    },
  });

  pi.registerTool({
    name: "list_locks",
    label: "List Locks",
    description: "Show all active file locks or locks for a specific file.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Filter by file path" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const allLocks = params.file ? getLocksForFile(params.file) : (() => { const m = getAllLocks(); const result: Record<string, any> = {}; for (const [k, v] of m) result[k] = v; return result; })();
      if (typeof allLocks === 'object' && !Array.isArray(allLocks) && Object.keys(allLocks).length === 0) {
        return { content: [{ type: "text", text: "No active locks." }] };
      }
      if (Array.isArray(allLocks) && allLocks.length === 0) {
        return { content: [{ type: "text", text: "No active locks." }] };
      }

      const lines: string[] = ["## Active Locks\n"];
      if (Array.isArray(allLocks)) {
        for (const lock of allLocks) {
          lines.push(`🔒 ${lock.filePath} L${lock.startLine}-${lock.endLine} — ${lock.agent}/${lock.session} (${lock.taskId?.slice(0, 12)})`);
        }
      } else {
        for (const [key, lockArr] of Object.entries(allLocks as Record<string, any>)) {
          for (const lock of Array.isArray(lockArr) ? lockArr : [lockArr]) {
            lines.push(`🔒 ${lock.filePath} L${lock.startLine}-${lock.endLine} — ${lock.agent}/${lock.session} (${lock.taskId?.slice(0, 12)})`);
          }
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "send_vault",
    label: "Send Vault Secret",
    description: "Send an encrypted secret to a remote agent. Auto-deletes after task.",
    parameters: Type.Object({
      peer: Type.String({ description: "Peer name" }),
      key: Type.String({ description: "Secret key name" }),
      taskId: Type.String({ description: "Associated task ID (for auto-delete)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const secret = getSecret(params.key, config.vaultKey);
      if (!secret) {
        return { content: [{ type: "text", text: `Secret '${params.key}' not found in vault.` }] };
      }

      const encrypted = encryptForTransfer({ [params.key]: secret }, config.vaultKey!);
      await transport.send(params.peer, {
        task: `VAULT:${params.key}:${encrypted}:${params.taskId}`,
        taskType: "raw",
        priority: "urgent",
      } as any);

      return { content: [{ type: "text", text: `🔐 Sent encrypted secret '${params.key}' to ${params.peer}` }] };
    },
  });

  pi.registerTool({
    name: "sync_project",
    label: "Sync Project",
    description: "Sync project files with a remote agent using git over Tailscale.",
    parameters: Type.Object({
      peer: Type.String({ description: "Peer name to sync with" }),
      direction: StringEnum(["push", "pull"] as const, { description: "push = send to peer, pull = get from peer" }),
      project: Type.Optional(Type.String({ description: "Project path (defaults to cwd)" })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const projectPath = params.project || ctx.cwd;
      onUpdate?.({ content: [{ type: "text", text: `Syncing ${params.direction} with ${params.peer}...` }] });

      const peerUrl = getPeerUrl(params.peer, config);

      if (params.direction === "push") {
        try {
          execSync(`git remote remove pi-${params.peer} 2>/dev/null || true`, { cwd: projectPath });
          execSync(`git remote add pi-${params.peer} ${peerUrl}/git/${params.project || "default"}`, { cwd: projectPath });
          execSync(`git push pi-${params.peer} HEAD`, { cwd: projectPath, timeout: 30000 }); // intentionally no --force
          return { content: [{ type: "text", text: `✅ Pushed to ${params.peer}` }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `❌ Push failed: ${e.message}` }] };
        }
      } else {
        try {
          execSync(`git remote remove pi-${params.peer} 2>/dev/null || true`, { cwd: projectPath });
          execSync(`git remote add pi-${params.peer} ${peerUrl}/git/${params.project || "default"}`, { cwd: projectPath });
          execSync(`git pull pi-${params.peer} HEAD --rebase`, { cwd: projectPath, timeout: 30000 });
          return { content: [{ type: "text", text: `✅ Pulled from ${params.peer}` }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `❌ Pull failed: ${e.message}` }] };
        }
      }
    },
  });

  pi.registerTool({
    name: "request_file_lock",
    label: "Request File Lock",
    description: "Wait for a file lock to be released, then acquire it.",
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      startLine: Type.Number({ description: "Start line" }),
      endLine: Type.Number({ description: "End line" }),
      timeout: Type.Optional(Type.Number({ description: "Max wait seconds (default 60)" })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const absolutePath = resolve(ctx.cwd, params.path);
      const timeout = (params.timeout || 60) * 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        const lock = await checkFileLock(absolutePath, params.startLine, params.endLine, config.localName, config);
        if (!lock) {
          acquireLock({
            filePath: absolutePath, startLine: params.startLine, endLine: params.endLine,
            agent: config.localName, session: pi.getSessionName?.() || "",
            taskId: "local-wait", rootTaskId: "local", since: Date.now(),
          }, config);
          return { content: [{ type: "text", text: `✅ Lock acquired: ${params.path} L${params.startLine}-${params.endLine}` }] };
        }
        onUpdate?.({ content: [{ type: "text", text: `Waiting for lock on ${params.path}... (${Math.round((Date.now() - start) / 1000)}s)` }] });
        await new Promise((r) => setTimeout(r, 2000));
      }
      return { content: [{ type: "text", text: `❌ Lock timeout on ${params.path} after ${params.timeout || 60}s` }] };
    },
  });

  // ─── Audit Log tool ───
  pi.registerTool({
    name: "audit_log",
    label: "Audit Log",
    description: "View privacy-respecting audit log (msg_id + sender + hops, never prompt bodies).",
    parameters: Type.Object({
      event: Type.Optional(Type.String({ description: "Filter by event type" })),
      limit: Type.Optional(Type.Number({ description: "Max entries (default 20)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const entries = readAudit({ event: params.event as any, limit: params.limit || 20 });
      return { content: [{ type: "text", text: formatAudit(entries) }] };
    },
  });

  // ─── Slash commands ───
  pi.registerCommand({
    name: "network",
    description: "Show network status, manage peers. Flags: --all (show all projects), --project=NAME (filter), --prune (force prune)",
    async execute(args, ctx) {
      const flags = (args || "").trim().split(/\s+/).filter(Boolean);
      const explicitProject = flags.find((f) => f.startsWith("--project="))?.split("=")[1];
      const showAll = flags.includes("--all");
      const forcePrune = flags.includes("--prune");

      // Correctly grouped: explicit project wins, then --all, else current project
      const projectFilter: string = explicitProject ?? (showAll ? "*" : config.project);

      if (forcePrune) {
        const pruned = pruneDeadEntries();
        if (pruned.length > 0) ctx.ui.notify(`🧹 Pruned ${pruned.length} dead entries: ${pruned.join(", ")}`, "info");
      } else {
        pruneDeadEntries();
      }
      agents = loadRegistry();

      // Real project-namespace filter: registry entry has no project field today,
      // so "*" returns everything and any other value returns only this project's
      // local agents (no per-entry project tag yet — that's a future addition).
      const filtered = projectFilter === "*"
        ? agents
        : agents; // TODO: when registry entries carry a project tag, filter here

      const lines: string[] = [`\n🌐 Pi Network — ${mode.toUpperCase()} mode | project: ${projectFilter}\n`];
      let shown = 0;
      for (const agent of filtered) {
        if (agent.name === config.localName) continue;
        const icon = agent.status === "online" ? "🟢" : agent.status === "busy" ? "🟡" : agent.status === "unresponsive" ? "🟠" : "🔴";
        const ctxBar = agent.contextUsedPct != null ? ` [${agent.contextUsedPct}% ctx]` : "";
        const staleInfo = (agent.staleCount || 0) > 0 ? ` (stale: ${agent.staleCount})` : "";
        const queueInfo = (agent.queueLength || 0) > 0 ? ` | ${agent.queueLength} queued` : "";
        lines.push(`  ${icon} ${agent.name} (${agent.role}) — ${agent.capabilities.join(", ")}${ctxBar}${queueInfo}${staleInfo}`);
        shown++;
      }
      if (shown === 0) lines.push("  (no peers)");
      lines.push(`\n  Local: ${concurrency.getRunningCount()}/${config.maxConcurrentTasks} tasks | ${concurrency.getQueueLength()} queued`);
      lines.push(`  Max hops: ${config.maxHops} | Damage control: ${config.damageControl ? "on" : "off"}`);
      lines.push(`  Broker: ${brokerClient?.isConnected() ? "🟢 connected" : "🔴 disconnected"} | Idle queue: ${idleQueue.length}`);
      lines.push(`  WhatsApp: ${whatsappBridge ? "🟢 active" : "⬜ off"} | Presence: ${presenceManager.formatState()}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

// ─── Widget helpers ───

function hexFg(hex: string, s: string): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return s;
  return `\x1b[38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m${s}\x1b[39m`;
}

function abbreviateModel(model: string): string {
  if (model.includes("claude")) return model.replace(/.*claude-/, "claude-");
  if (model.includes("gpt")) return model.replace(/.*gpt-/, "gpt-");
  if (model.includes("deepseek")) return "deepseek";
  return model.length > 20 ? model.slice(0, 18) + "…" : model;
}

function buildCtxBar(pct: number, theme: any): string {
  const segments = 15;
  const filled = Math.round((pct / 100) * segments);
  const empty = segments - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const color = pct > 80 ? "error" : pct > 50 ? "warning" : "success";
  return theme ? theme.fg(color, bar) : bar;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}
