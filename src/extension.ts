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
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { resolve, join, dirname } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFile } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { discoverClaudeSessions } from "./core/claude-discovery";
import { IdleQueue } from "./core/idle-queue";
import { loadConfirmConfig, shouldConfirm, formatConfirmPrompt } from "./core/confirm-send";
import { PresenceManager } from "./core/presence";
import { ReplyTracker } from "./core/reply-tracker";
import { WhatsAppBridge } from "./whatsapp-bridge";
import { NetworkInlineMessage, makeMessageDetails } from "./ui/inline-message";
import { PeerListOverlay } from "./ui/session-list";
import { NetworkComposeOverlay } from "./ui/compose";
import type { PersonaDef } from "./core/personas";
import { ulid } from "./core/ulid";
import { GitSyncManager, loadGitSyncConfig } from "./core/git-sync";
import { validateInterviewRequest, formatInterviewRequest, parseInterviewReply, type InterviewRequest, type InterviewReply } from "./core/interview";

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
let gitSync: GitSyncManager | null = null;

// ─── Session lifecycle safety (ported from pi-intercom) ───
let runtimeContext: ExtensionContext | null = null;
let runtimeGeneration = 0;
let shuttingDown = false;
let disposed = true;
let runtimeStarted = false;
let currentSessionId: string | null = null;
let currentModel = "unknown";
let sessionStartedAt: number | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let startupConnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let reconnectPromise: Promise<BrokerClient> | null = null;
let reconnectPromiseGeneration: number | null = null;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000, 30_000];

// Duplicate session name detection
function duplicateSessionNames(sessions: { name?: string }[]): Set<string> {
  return new Set(
    sessions.map(s => s.name?.toLowerCase()).filter((n): n is string => Boolean(n))
      .filter((n, i, a) => a.indexOf(n) !== i)
  );
}
function shortSessionId(id: string): string { return id.slice(0, 8); }
function formatSessionLabel(session: { name?: string; id: string }, dupes: Set<string>): string {
  if (!session.name) return session.id;
  return dupes.has(session.name.toLowerCase()) ? `${session.name} (${shortSessionId(session.id)})` : session.name;
}

function detectRuntime(): "pi" | "claude" | "unknown" {
  // Check if we're running inside pi or claude code
  if (process.env.CLAUDE_CODE_SESSION) return "claude";
  if (process.env.PI_SESSION || process.env.PI_CWD) return "pi";
  // Heuristic: pi extensions have pi.getSessionName
  return "pi"; // We're loaded as a pi extension, so default to pi
}

function previewText(value: unknown, maxLen = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const n = value.replace(/\s+/g, " ").trim();
  return n && (n.length > maxLen ? n.slice(0, maxLen - 1) + "…" : n) || undefined;
}

function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
  if (disposed || shuttingDown || generation !== runtimeGeneration || !ctx) return null;
  try {
    if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) return null;
    void ctx.hasUI;
    return ctx;
  } catch { return null; }
}

function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
  const live = getLiveContext(ctx, generation);
  if (!live?.hasUI) return;
  try { live.ui.notify(message, level); } catch {}
}

function clearReconnectTimer(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}
function clearStartupConnectTimer(): void {
  if (startupConnectTimer) { clearTimeout(startupConnectTimer); startupConnectTimer = null; }
}

function getReconnectDelayMs(): number {
  return RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
}

function scheduleReconnect(): void {
  if (disposed || shuttingDown || reconnectTimer) return;
  const gen = runtimeGeneration;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (gen !== runtimeGeneration) return;
    reconnectAttempt++;
    ensureBrokerConnected("background").catch(() => {});
  }, getReconnectDelayMs());
  try { (reconnectTimer as any).unref?.(); } catch {}
}

async function ensureBrokerConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<BrokerClient> {
  if (disposed || shuttingDown) throw new Error("Network shutting down");
  if (brokerClient?.isConnected()) return brokerClient;
  const ctx = getLiveContext();
  const gen = runtimeGeneration;
  if (!ctx || !currentSessionId) throw new Error("Network runtime not initialized");
  clearReconnectTimer();

  // Deduplicate concurrent reconnect attempts
  if (reconnectPromise && reconnectPromiseGeneration === gen) return reconnectPromise;

  const nextPromise = (async (): Promise<BrokerClient> => {
    // Disconnect any stale broker client first
    if (brokerClient?.isConnected()) { try { await brokerClient.disconnect(); } catch {} brokerClient = null; }
    const nextClient = new BrokerClient();
    brokerClient = nextClient;
    attachBrokerClientHandlers(nextClient);
    try {
      await spawnBrokerIfNeeded();
      await nextClient.connect({
        name: pi.getSessionName?.() || config.localName, // Real session name for discovery
        localName: config.localName,                     // Machine identity for routing
        cwd: ctx.cwd, model: currentModel, pid: process.pid,
        startedAt: sessionStartedAt!, lastActivity: Date.now(),
        status: presenceManager.formatState(),
        runtime: detectRuntime(),                        // pi vs claude
        // Role is dynamic — set per-task by who delegates. No static role.
        capabilities: config.capabilities, specialties: config.specialties,
        color: config.color, purpose: config.purpose, project: config.project,
      });
      if (!getLiveContext(ctx, gen)) { await nextClient.disconnect(); throw new Error("Runtime no longer active"); }
      reconnectAttempt = 0;
      // Broker doesn't notify us about pre-existing sessions on connect, so fetch them now.
      refreshAgentsFromBroker();
      return nextClient;
    } catch (e) {
      if (brokerClient === nextClient) brokerClient = null;
      if (reason === "background") scheduleReconnect();
      throw e;
    } finally {
      if (reconnectPromise === nextPromise) { reconnectPromise = null; reconnectPromiseGeneration = null; }
    }
  })();
  reconnectPromise = nextPromise;
  reconnectPromiseGeneration = gen;
  return nextPromise;
}

function attachBrokerClientHandlers(client: BrokerClient): void {
  client.on("message", (from, message) => {
    const live = getLiveContext();
    if (brokerClient !== client || !live) return;
    handleBrokerInboundMessage(live, from, message);
  });
  client.on("disconnected", () => {
    if (brokerClient !== client) return;
    // Reject any pending reply waiter
    if (replyWaiter) replyWaiter.reject(new Error("Broker disconnected"));
    brokerClient = null;
    if (!shuttingDown && !disposed) {
      clearReconnectTimer();
      scheduleReconnect();
      const ctx = getLiveContext();
      if (ctx?.hasUI) ctx.ui.notify("⚠️ Broker disconnected, reconnecting...", "warning");
    }
  });
  client.on("session_joined", (session) => {
    const ctx = getLiveContext();
    if (!ctx) return;
    const label = session.name || shortSessionId(session.id);
    notifyIfLive(ctx, `🟢 ${label} joined the mesh`, "info");
    debouncedRefresh();
  });
  client.on("session_left", (sessionId) => {
    debouncedRefresh();
  });
  client.on("presence_update", (session) => {
    debouncedRefresh();
  });
}

// Check if target matches current session (local self-delivery)
// Refresh agents array from broker sessions (async, fire-and-forget)
const DEBUG_LOG = require("os").homedir() + "/.pi/agent/intercom/pi-network-debug.log";
function debugLog(msg: string) {
  try { require("fs").appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
let showPeersInFooter = true;  // toggle with /network peers
let peerLayout: "horizontal" | "vertical" = "horizontal";
let lastRefreshTime = 0;
let refreshPending = false;
function debouncedRefresh() {
  const now = Date.now();
  if (now - lastRefreshTime < 3000) {
    if (!refreshPending) { refreshPending = true; setTimeout(() => { refreshPending = false; refreshAgentsFromBroker(); }, 3000 - (now - lastRefreshTime)); }
    return;
  }
  lastRefreshTime = now;
  refreshAgentsFromBroker();
}

function refreshAgentsFromBroker() {
  // refreshAgentsFromBroker called
  const piSessionsPromise = brokerClient?.isConnected()
    ? brokerClient.listSessions().then(s => { return s; }).catch((e: any) => { debugLog(`broker list error: ${e.message}`); return [] as any[]; })
    : Promise.resolve([] as any[]);

  piSessionsPromise.then(piSessions => {
    const piAgents = piSessions
      .filter((s: any) => s.id !== currentSessionId)
      .map((s: any) => ({
        name: s.name || s.id.slice(0, 8),
        status: s.status?.includes("online") || s.status?.includes("idle") || s.status?.startsWith("\ud83d\udfe2") ? "online" : s.status?.includes("busy") || s.status?.includes("tool:") ? "busy" : "offline",
        rawStatus: s.status,
        role: s.role,
        runtime: s.runtime || "pi",
        capabilities: s.capabilities || [],
        specialties: s.specialties || [],
        model: s.model,
        pid: s.pid,
        sessionName: s.name,
        cwd: s.cwd || "",
        heartbeatAt: s.lastActivity,
        staleCount: 0,
        contextUsedPct: (s as any).contextUsedPct,
        color: s.color,
        project: s.project,
        startedAt: s.startedAt,
      }));

    // Merge Claude sessions (discovered from ~/.claude/sessions/)
    const claudeSessions = discoverClaudeSessions();
    // merged claude + broker sessions
    const claudeAgents = claudeSessions.map(s => ({
      name: s.name,
      status: s.status === "idle" ? "online" : s.status === "busy" ? "busy" : "online",
      rawStatus: s.status,
      runtime: "claude" as const,
      capabilities: [] as string[],
      specialties: [] as string[],
      model: s.model,
      pid: s.pid,
      sessionName: s.name,
      cwd: s.cwd || "",
      heartbeatAt: Date.now(),
      staleCount: 0,
      startedAt: s.startedAt,
    }));

    // Dedupe broker sessions: same name from different session IDs (stale registrations)
    const seen = new Set<string>();
    const dedupedPi = piAgents.filter((a: any) => {
      const key = a.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Dedupe: Claude sessions may already be in broker if claude-bridge is running
    const piNames = new Set(dedupedPi.map((a: any) => a.name.toLowerCase()));
    const uniqueClaude = claudeAgents.filter((a: any) => !piNames.has(a.name.toLowerCase()));

    agents = [...dedupedPi, ...uniqueClaude];

    const ctx = getLiveContext();
    if (ctx) {
      const onlineCount = agents.filter((a: any) => a.status !== "offline").length;
      if (showPeersInFooter) ctx.ui.setStatus("bridge", `\ud83c\udf10 ${onlineCount}/${agents.length} peers online`);
    }
  }).catch(() => { debugLog("refreshAgentsFromBroker failed, keeping current agents"); });
}

function currentSessionTargetMatches(to: string, resolvedTo?: string | null, activeClient?: BrokerClient | null): boolean {
  const targets = new Set<string>();
  const add = (t: string | null | undefined) => { const v = t?.trim(); if (v) targets.add(v.toLowerCase()); };
  add(currentSessionId);
  add(activeClient?.sessionId);
  add(config.localName);
  add(pi.getSessionName?.());  // Match real session name too
  return Boolean(resolvedTo && activeClient?.sessionId && resolvedTo === activeClient.sessionId) || targets.has(to.trim().toLowerCase());
}

// Stub — implemented later in the file, referenced by ensureBrokerConnected
let handleBrokerInboundMessage: (ctx: ExtensionContext, from: any, message: any) => void = () => {};

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
        details: makeMessageDetails("clarification", from, question, { taskId }),
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
  bridgeServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[pi-network] Port ${port} already in use — another session is the manager. Running as client.`);
      bridgeServer = null;
    } else {
      console.error(`[pi-network] Bridge server error:`, err);
    }
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
      // Refresh agents from broker (debounced)
      debouncedRefresh();
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
  const from = (envelope.chain?.length ? envelope.chain[envelope.chain.length - 1]?.agent : null) || "unknown";
  const origin = `${envelope.originInstructor}/${envelope.originSession}`;
  const chainStr = envelope.chain?.map((h) => h.agent).join(" → ") || "";

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
    details: makeMessageDetails("task_result", result.from, result.result, { taskId: result.taskId, hops: result.hops }),
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
    debugLog(`session_start fired! cwd=${ctx.cwd}`);
    // ─── Lifecycle safety ───
    shuttingDown = false;
    disposed = false;
    runtimeStarted = true;
    runtimeGeneration++;
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearStartupConnectTimer();
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentModel = ctx.model?.id ?? "unknown";
    sessionStartedAt = Date.now();

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
      // damage-control status intentionally not shown in footer
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

    // ─── Phase 1.1: Auto-discovery broker (deferred to next tick) ───
    const startupGen = runtimeGeneration;
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!getLiveContext(ctx, startupGen)) return;
      debugLog("startup: ensureBrokerConnected called");
      ensureBrokerConnected("startup")
        .then((client) => { debugLog(`startup: broker connected! sessionId=${client.sessionId?.slice(0,8)} isConnected=${client.isConnected()}`); notifyIfLive(ctx, "🔗 Connected to auto-discovery broker", "info", startupGen); })
        .catch((e: any) => {
          debugLog(`startup: broker FAILED: ${e.message}`);
          if (!getLiveContext(ctx, startupGen)) return;
          notifyIfLive(ctx, `⚠️ Broker unavailable: ${e.message} (continuing without auto-discovery)`, "warning", startupGen);
          brokerClient = null;
          scheduleReconnect();
        });
    }, 0);

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

    // ─── Git sync ───
    const gitSyncCfg = loadGitSyncConfig(config);
    if (gitSyncCfg.mode !== "off") {
      try {
        gitSync = new GitSyncManager(gitSyncCfg, config.role, config.localName, ctx.cwd);
        gitSync.installBranchProtection();
        gitSync.start();
        ctx.ui.notify(`🔀 Git sync: ${gitSyncCfg.mode} | ${config.role} | base: ${gitSyncCfg.baseBranch}`, "info");
      } catch (e: any) {
        ctx.ui.notify(`⚠️ Git sync failed: ${e.message}`, "warning");
        gitSync = null;
      }
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

    // Initial status — will update once broker connects
    ctx.ui.setStatus("bridge", `🌐 Connecting...`);

    // ─── Pool Widget ───
    ctx.ui.setWidget("pi-network-pool", (_tui: any, theme: any) => {
      return {
        render(width: number) {
          if (!showPeersInFooter) return [""];
          if (agents.length === 0) return [theme.fg("dim", "  🌐 Discovering peers...")];

          if (peerLayout === "vertical") {
            const lines: string[] = [theme.fg("dim", "  🌐 Pi Network")];
            for (const agent of agents) {
              const dot = agent.status === "online" ? "\ud83d\udfe2" : agent.status === "busy" ? "\ud83d\udfe1" : "\ud83d\udd34";
              const color = agent.color ? hexFg(agent.color, agent.name) : theme.fg("accent", agent.name);
              const rt = (agent as any).runtime === "claude" ? theme.fg("dim", " [claude]") : (agent as any).runtime === "pi" ? theme.fg("dim", " [pi]") : "";
              const model = agent.model ? theme.fg("dim", ` ${abbreviateModel(agent.model)}`) : "";
              lines.push(`  ${dot} ${color}${rt}${model}`);
            }
            return lines;
          }

          // Horizontal: peers inline, wrap at terminal width
          const tokens: string[] = [];
          for (const agent of agents) {
            const dot = agent.status === "online" ? "\ud83d\udfe2" : agent.status === "busy" ? "\ud83d\udfe1" : "\ud83d\udd34";
            const name = agent.color ? hexFg(agent.color, agent.name) : theme.fg("accent", agent.name);
            const rt = (agent as any).runtime === "claude" ? theme.fg("dim", " [claude]") : (agent as any).runtime === "pi" ? theme.fg("dim", " [pi]") : "";
            const model = agent.model ? theme.fg("dim", ` ${abbreviateModel(agent.model)}`) : "";
            tokens.push(`${dot}${name}${rt}${model}`);
          }
          const prefix = "  \ud83c\udf10 ";
          const sep = "  ";
          const lines: string[] = [];
          let currentLine = prefix;
          for (let i = 0; i < tokens.length; i++) {
            const candidate = currentLine + (i > 0 ? sep : "") + tokens[i];
            const plain = candidate.replace(/\x1b\[[0-9;]*m/g, "");
            if (plain.length > width && currentLine !== prefix) {
              lines.push(currentLine);
              currentLine = prefix + tokens[i];
            } else {
              currentLine = candidate;
            }
          }
          if (currentLine.trim()) lines.push(currentLine);
          return lines;
        },
      };
    });


    // ─── Phase 1.8: Presence status widget ───
    // presence status intentionally not shown in footer

    transport.onMessage((msg) => {
      if (msg.type === "message" && msg.payload) {
        if (msg.payload.type === "result") {
          deliverResult(msg.payload);
        } else if (msg.payload.type === "file") {
          pi.sendMessage({ customType: "bridge-file", content: `📂 File from ${msg.from}: ${msg.payload.filename}`, display: true, details: makeMessageDetails("file_received", msg.from, msg.payload.filename) });
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
    shuttingDown = true;
    disposed = true;
    runtimeGeneration++;
    clearReconnectTimer();
    clearStartupConnectTimer();
    // Reject any pending reply waiter
    if (replyWaiter) { replyWaiter.reject(new Error("Session shutting down")); replyWaiter = null; }
    replyTracker.reset();
    await transport?.stop();
    if (brokerClient) { await brokerClient.disconnect().catch(() => {}); brokerClient = null; }
    if (whatsappBridge) { await whatsappBridge.stop().catch(() => {}); whatsappBridge = null; }
    if (gitSync) { gitSync.stop(); gitSync = null; }
    stopLocalBridge();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    if (pendingTasksTimer) clearInterval(pendingTasksTimer);
    try { removeRegistryEntry(config.localName); } catch {}
    runtimeContext = null;
    currentSessionId = null;
    sessionStartedAt = null;
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
        deliverToSession: (envelope.chain?.length ?? 0) > 0 ? envelope.chain[envelope.chain.length - 1].session : undefined,
        result: validatedResult, files: [], chain: envelope.chain,
        originInstructor: envelope.originInstructor, originSession: envelope.originSession,
        needsConsolidation: envelope.requiresConsolidation,
        isConsolidated: false, partialResults: [], status: "completed",
      };

      activeEnvelopes.delete(taskId);
      concurrency.complete(taskId);
      releaseAllForTask(envelope.rootTaskId, config);
      updateHistoryStatus(taskId, "completed", validatedResult.slice(0, 200));

      // Git sync: worker auto-commits and pushes on task complete
      if (gitSync && config.role === "worker") {
        try {
          const committed = gitSync.autoCommit(envelope.task, envelope.taskId);
          if (committed) {
            appendAudit({ event: "git_commit", taskId: envelope.taskId, sender: config.localName, reason: gitSync.getCurrentBranch() || "unknown" });
          }
        } catch {}
      }

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
          details: makeMessageDetails("queued", msg.envelope.originInstructor, msg.envelope.task.slice(0, 200), { taskId: msg.envelope.taskId }),
        }, { triggerTurn: false });
        injectTask(msg.envelope);
      }
    }
  });

  pi.on("message_update", async () => {
    for (const [taskId] of activeEnvelopes) concurrency.heartbeat(taskId);
  });

  // ─── Broker inbound message handler (implementation for forward reference) ───
  handleBrokerInboundMessage = (ctx: ExtensionContext, from: any, message: any) => {
    const msgGen = runtimeGeneration;
    const live = getLiveContext(ctx, msgGen);
    if (!live) return;

    const turnCtx = replyTracker.recordIncomingMessage(from, message);
    replyTracker.queueTurnContext(turnCtx);

    // Check if agent is idle — queue if busy
    void (async () => {
      const activeCtx = getLiveContext(ctx, msgGen);
      if (!activeCtx) return;

      let isIdle: boolean;
      try { isIdle = (activeCtx as any).isIdle?.() ?? true; } catch { return; }

      if (!isIdle) {
        // Auto-reply to sender if non-interactive (headless) and this isn't a reply
        if (!activeCtx.hasUI && !message.replyTo && brokerClient?.isConnected()) {
          try {
            const r = await brokerClient.send(from.id, {
              text: "Agent is busy and non-interactive. Will continue current task and respond when idle.",
              replyTo: message.id,
            });
            if (r.delivered && getLiveContext(ctx, msgGen)) replyTracker.markReplied(message.id);
          } catch { /* best-effort */ }
          return;
        }
        // Interactive but busy — queue for later
        idleQueue.enqueue({ ...message, _from: from });
        return;
      }

      deliverInboundMessage(from, message);
    })();
  };

  function deliverInboundMessage(from: any, message: any): void {
    const inboundFrom = from.name || from.id;
    const attachmentText = message.content?.attachments?.length
      ? message.content.attachments.map((a: any) => `\n---\n📎 ${a.name}${a.language ? ` (${a.language})` : ""}\n${a.content}`).join("")
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCmd = message.expectsReply ? `network_comm({ action: "reply", message: "..." })` : undefined;
    pi.sendMessage({
      customType: "network-inbound",
      content: bodyText,
      display: true,
      details: makeMessageDetails("inbound_task", inboundFrom, bodyText, { replyCommand: replyCmd }),
    }, { triggerTurn: message.expectsReply ?? false });
    // Audit trail
    pi.appendEntry?.("network_received", { from: inboundFrom, messageId: message.id, timestamp: Date.now() });
  }

  // ─── Tools ───

  // task_send — fire-and-forget or track for later retrieval
  pi.registerTool({
    name: "task_send",
    label: "Task Send",
    description: "Send task to remote agent. Returns msg_id. Poll with task_get or block with task_await.",
    promptSnippet: "Send task",
    promptGuidelines: ["match task to agent specialty", "use peer name from config"],
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
    description: "Non-blocking poll on taskId.",
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
    renderCall(args: any, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("task_get ")) + theme.fg("dim", args.taskId?.slice(0, 12) ?? "?"), 0, 0);
    },
    renderResult(result: any, { isPartial }: any, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", "⏳ Waiting..."), 0, 0);
      const t = result.content?.[0]?.text ?? "";
      const failed = t.includes("Unknown");
      return new Text((failed ? theme.fg("dim", "○ ") : t.startsWith("✅") ? theme.fg("success", "✓ ") : theme.fg("warning", "⏳ ")) + t.replace(/^[✅⏳] /, "").slice(0, 100), 0, 0);
    },
  });

  // task_await — blocking wait
  pi.registerTool({
    name: "task_await",
    label: "Task Await",
    description: "Block until reply or timeout (default 30min).",
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
    description: "Send task + await result (task_send + task_await combined).",
    promptSnippet: "Remote task",
    promptGuidelines: ["match task to agent specialty", "use peer name from config"],
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
    renderCall(args: any, theme: any) {
      const tgt = args.peer ?? "?";
      const prompt = args.task ?? "";
      const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      let text = theme.fg("toolTitle", theme.bold("remote_task ")) + theme.fg("accent", tgt);
      if (preview) text += "\n  " + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, { isPartial }: any, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", "⏳ Waiting for response..."), 0, 0);
      const t = result.content?.[0]?.text ?? "";
      return new Text((t.startsWith("✅") ? theme.fg("success", "✓ ") : theme.fg("error", "✗ ")) + t.replace(/^[✅⏰❌] /, "").slice(0, 100), 0, 0);
    },
  });

  pi.registerTool({
    name: "send_file",
    label: "Send File",
    description: "Send file to remote agent (base64, token-free).",
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
    description: "Fan-out task to all online agents or filtered by capability.",
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
    description: "Peer status (context usage, stale counter, queue depth).",
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

      // Try broker sessions first (shows real session names like pi-intercom)
      let brokerSessions: any[] = [];
      try { if (brokerClient?.isConnected()) brokerSessions = await brokerClient.listSessions(); } catch {}

      if (brokerSessions.length > 0) {
        const others = brokerSessions.filter(s => s.id !== currentSessionId);
        if (others.length === 0) lines.push("No other sessions online.");
        for (const s of others) {
          const icon = (s.status?.includes("online") || s.status?.includes("idle") || s.status?.startsWith("🟢")) ? "🟢" : (s.status?.includes("busy") || s.status?.includes("tool:")) ? "🟡" : "🔴";
          const rt = s.runtime === "claude" ? "claude" : s.runtime === "pi" ? "pi" : "?";
          const model = s.model || "?";
          const shortModel = model.replace(/^(anthropic\/|openai\/|google\/|x-ai\/|meta\/)/, "");
          const caps = s.capabilities?.length ? s.capabilities.join(", ") : "";
          const ctx = s.contextUsedPct != null ? ` ${buildCtxBar(s.contextUsedPct, null)}` : "";
          lines.push(`${icon} **${s.name || s.id.slice(0, 8)}** [${rt}] ${shortModel}${caps ? ` — ${caps}` : ""}${ctx}`);
        }
      } else {
        // Fall back to file-based registry
        for (const agent of agents) {
          if (agent.name === config.localName) continue;
          const icon = agent.status === "online" ? "🟢" : agent.status === "busy" ? "🟡" : agent.status === "unresponsive" ? "🟠" : "🔴";
          const ctxBar = agent.contextUsedPct != null ? ` ${buildCtxBar(agent.contextUsedPct, null)}` : "";
          lines.push(`${icon} **${agent.name}**${ctxBar}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "ask_origin",
    label: "Ask Origin",
    description: "Clarification question routed back to origin.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to clarify" }),
      question: Type.String({ description: "Your question" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const envelope = activeEnvelopes.get(params.taskId);
      if (!envelope) {
        return { content: [{ type: "text", text: `No active task ${params.taskId}` }] };
      }

      const chainHead = (envelope.chain?.length ?? 0) > 0 ? envelope.chain[0] : null;
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
    description: "Return unhandleable task. Manager reassigns.",
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
        deliverToSession: (envelope.chain?.length ?? 0) > 0 ? envelope.chain[envelope.chain.length - 1].session : undefined,
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
    description: "Kill a queued or running task.",
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
    description: "View task history.",
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
    description: "List active file locks.",
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
    description: "Send encrypted secret to remote agent (auto-deletes after task).",
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
    description: "Sync project files with remote agent via git.",
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
    description: "Wait for file lock release then acquire.",
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
    description: "View audit log (msg_id + sender + hops, no prompt bodies).",
    parameters: Type.Object({
      event: Type.Optional(Type.String({ description: "Filter by event type" })),
      limit: Type.Optional(Type.Number({ description: "Max entries (default 20)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const entries = readAudit({ event: params.event as any, limit: params.limit || 20 });
      return { content: [{ type: "text", text: formatAudit(entries) }] };
    },
  });

  // ─── network_comm — Direct messaging with ask/reply/pending (ported from pi-intercom) ───
  let replyWaiter: { from: string; replyTo: string; resolve: (msg: any) => void; reject: (err: Error) => void } | null = null;

  function waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<any> {
    if (replyWaiter) return Promise.reject(new Error("Already waiting for a reply"));
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (replyWaiter?.replyTo === replyTo) replyWaiter = null;
        reject(new Error(`No reply from "${from}" within 10 minutes`));
      }, 10 * 60 * 1000);
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); };
      const onAbort = () => { cleanup(); reject(new Error("Cancelled")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = { from, replyTo, resolve: (msg) => { cleanup(); resolve(msg); }, reject: (err) => { cleanup(); reject(err); } };
    });
  }

  // Intercept broker messages to resolve reply waiters
  const origHandler = handleBrokerInboundMessage;
  handleBrokerInboundMessage = (ctx, from, message) => {
    // Check if this is a reply we're waiting for
    if (replyWaiter && message.replyTo) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === replyWaiter.from.toLowerCase() || from.id === replyWaiter.from;
      if (fromMatches && message.replyTo === replyWaiter.replyTo) {
        replyWaiter.resolve({ from, message });
        return;
      }
    }
    origHandler(ctx, from, message);
  };

  pi.registerTool({
    name: "network_comm",
    label: "Network Communication",
    description: "Mesh messaging. send=fire&forget, ask=send+await reply, reply=auto-target sender, pending=list unresolved asks, status=connection info.",
    promptSnippet: "Mesh message",
    promptGuidelines: ["ask when need response", "send for notifications", "reply auto-targets sender", "pending shows unanswered asks"],
    parameters: Type.Object({
      action: StringEnum(["send", "ask", "reply", "pending", "status"], { description: "Communication action" }),
      to: Type.Optional(Type.String({ description: "Target agent name (for send/ask, or to disambiguate reply)" })),
      message: Type.Optional(Type.String({ description: "Message text" })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: StringEnum(["file", "snippet", "context"]),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      })), { description: "Optional file/snippet/context attachments" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { action, to, message, attachments } = params;

      switch (action) {
        case "status": {
          const connected = brokerClient?.isConnected() ?? false;
          const pending = replyTracker.listPending();
          let sessions: any[] = [];
          try { if (connected) sessions = await brokerClient.listSessions(); } catch {}
          const others = sessions.filter(s => s.id !== currentSessionId);
          return {
            content: [{ type: "text", text: 
              `Connected: ${connected ? `Yes (${currentSessionId?.slice(0, 8)})` : "No"}\n` +
              `Session: ${pi.getSessionName?.() || config.localName}\n` +
              `Runtime: ${detectRuntime()}\n` +
              `Peers: ${others.length > 0 ? others.map(s => { const rt = s.runtime || "?"; const m = (s.model || "?").replace(/^(anthropic\/|openai\/|google\/|x-ai\/|meta\/)/, ""); return `${s.name || s.id.slice(0, 8)} [${rt}] ${m}`; }).join(", ") : "none"}\n` +
              `Pending asks: ${pending.length}${pending.length > 0 ? "\n" + pending.map(p => `  • ${p.from.name}: ${p.message.content.text.slice(0, 60)}...`).join("\n") : ""}`
            }],
          };
        }

        case "pending": {
          const pending = replyTracker.listPending();
          if (pending.length === 0) {
            return { content: [{ type: "text", text: "No pending asks" }] };
          }
          const lines = pending.map(p => {
            const elapsed = Math.round((Date.now() - p.receivedAt) / 1000);
            const preview = p.message.content.text.length > 60 ? p.message.content.text.slice(0, 57) + "..." : p.message.content.text;
            return `• ${p.from.name || p.from.id.slice(0, 8)} (${elapsed}s ago): ${preview}`;
          });
          return { content: [{ type: "text", text: `Pending asks:\n${lines.join("\n")}` }] };
        }

        case "send": {
          if (!to || !message) return { content: [{ type: "text", text: "❌ 'to' and 'message' required for send" }], isError: true };
          let client: BrokerClient;
          try { client = await ensureBrokerConnected("tool"); } catch (e: any) {
            return { content: [{ type: "text", text: `❌ Not connected: ${e.message}` }], isError: true };
          }
          try {
            const result = await client.send(to, { text: message, attachments });
            appendAudit({ event: "comm_send", sender: config.localName, recipient: to, hops: 0 });
            pi.appendEntry?.("network_sent", { to, messageId: result.id, message: message.slice(0, 200), timestamp: Date.now() });
            return {
              content: [{ type: "text", text: result.delivered ? `✅ Delivered to ${to}` : `❌ Not delivered: ${result.reason}` }],
              isError: !result.delivered,
              details: { messageId: result.id, delivered: result.delivered, reason: result.reason },
            };
          } catch (e: any) {
            return { content: [{ type: "text", text: `❌ Send failed: ${e.message}` }], isError: true };
          }
        }

        case "ask": {
          if (!to || !message) return { content: [{ type: "text", text: "❌ 'to' and 'message' required for ask" }], isError: true };
          if (replyWaiter) return { content: [{ type: "text", text: "❌ Already waiting for a reply" }], isError: true };
          let client: BrokerClient;
          try { client = await ensureBrokerConnected("tool"); } catch (e: any) {
            return { content: [{ type: "text", text: `❌ Not connected: ${e.message}` }], isError: true };
          }
          const questionId = randomUUID();
          try {
            const sendResult = await client.send(to, {
              text: message, attachments, messageId: questionId, expectsReply: true,
            });
            if (!sendResult.delivered) {
              return { content: [{ type: "text", text: `❌ Not delivered: ${sendResult.reason}` }], isError: true };
            }
            appendAudit({ event: "comm_ask", sender: config.localName, recipient: to, hops: 0 });
            pi.appendEntry?.("network_sent", { to, messageId: questionId, message: message.slice(0, 200), timestamp: Date.now() });
            // Block until reply
            const reply = await waitForReply(to, questionId, signal);
            replyTracker.markReplied(questionId);
            const replyText = reply.message.content.text;
            const replyAttachments = reply.message.content.attachments?.length
              ? reply.message.content.attachments.map((a: any) => `\n---\n📎 ${a.name}\n${a.content}`).join("")
              : "";
            return { content: [{ type: "text", text: `**Reply from ${reply.from.name || reply.from.id.slice(0, 8)}:**\n${replyText}${replyAttachments}` }] };
          } catch (e: any) {
            if (replyWaiter?.replyTo === questionId) replyWaiter = null;
            return { content: [{ type: "text", text: `❌ Ask failed: ${e.message}` }], isError: true };
          }
        }

        case "reply": {
          if (!message) return { content: [{ type: "text", text: "❌ 'message' required for reply" }], isError: true };
          let target: { to: string; replyTo: string };
          try {
            const ctx2 = replyTracker.resolveReplyTarget({ to });
            target = { to: ctx2.from.name || ctx2.from.id, replyTo: ctx2.message.id };
          } catch (e: any) {
            return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
          }
          let client: BrokerClient;
          try { client = await ensureBrokerConnected("tool"); } catch (e: any) {
            return { content: [{ type: "text", text: `❌ Not connected: ${e.message}` }], isError: true };
          }
          try {
            const result = await client.send(target.to, { text: message, replyTo: target.replyTo, attachments });
            replyTracker.markReplied(target.replyTo);
            appendAudit({ event: "comm_reply", sender: config.localName, recipient: target.to, hops: 0 });
            pi.appendEntry?.("network_sent", { to: target.to, replyTo: target.replyTo, message: message.slice(0, 200), timestamp: Date.now() });
            return {
              content: [{ type: "text", text: result.delivered ? `✅ Reply sent to ${target.to}` : `❌ Not delivered: ${result.reason}` }],
              isError: !result.delivered,
            };
          } catch (e: any) {
            return { content: [{ type: "text", text: `❌ Reply failed: ${e.message}` }], isError: true };
          }
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
      }
    },
    renderCall(args: any, theme: any) {
      const action = args.action || "send";
      const tgt = args.to ?? "?";
      const msg = args.message ?? "";
      const preview = msg.length > 60 ? msg.slice(0, 57) + "..." : msg;
      const color = action === "ask" ? "warning" : action === "reply" ? "success" : "accent";
      let text = theme.fg("toolTitle", theme.bold("network_comm ")) + theme.fg(color, action) + " → " + theme.fg("accent", tgt);
      if (preview) text += "\n  " + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, { isPartial }: any, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", "⏳ Waiting for reply..."), 0, 0);
      const text = result.content?.[0]?.text ?? "";
      const failed = result.isError || text.startsWith("❌");
      return new Text((failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ")) + text.replace(/^[✅❌] /, "").slice(0, 120), 0, 0);
    },
  });

  // ─── Tier 2: Event-based pi-subagents relay + local self-delivery + delivery ACKs ───
  const SUBAGENT_CONTROL_EVENT = "subagent:control-intercom";
  const SUBAGENT_RESULT_EVENT = "subagent:result-intercom";
  const SUBAGENT_RESULT_DELIVERY_EVENT = "subagent:result-intercom-delivery";

  function parseSubagentPayload(payload: unknown): { to: string; message: string; requestId?: string } | null {
    if (typeof payload !== "object" || payload === null) return null;
    const r = payload as Record<string, unknown>;
    if (typeof r.to !== "string" || typeof r.message !== "string") return null;
    return { to: r.to, message: r.message, requestId: typeof r.requestId === "string" ? r.requestId : undefined };
  }

  function emitResultDelivery(requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (!requestId) return;
    pi.events?.emit(SUBAGENT_RESULT_DELIVERY_EVENT, {
      requestId, delivered, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
  }

  function deliverLocalSubagentRelayMessage(sender: string, status: string, messageText: string): void {
    deliverInboundMessage({ id: sender, name: sender, cwd: runtimeContext?.cwd ?? process.cwd(), model: sender, pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), status }, { id: randomUUID(), timestamp: Date.now(), content: { text: messageText } });
  }

  function relaySubagentPayload(payload: unknown, options: { sender: string; status: string; errorEntryType: string; acknowledge?: boolean }): void {
    const parsed = parseSubagentPayload(payload);
    if (!parsed) return;
    const relayGen = runtimeGeneration;
    void (async () => {
      const stillLive = () => !runtimeStarted || Boolean(getLiveContext(runtimeContext, relayGen));
      if (!stillLive()) return;

      // Local self-delivery
      if (currentSessionTargetMatches(parsed.to)) {
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      let activeClient: BrokerClient;
      try { activeClient = await ensureBrokerConnected("background"); } catch (e: any) {
        if (!stillLive()) return;
        pi.appendEntry?.(options.errorEntryType, { to: parsed.to, message: parsed.message, error: e.message, timestamp: Date.now() });
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, e);
        return;
      }

      // Double-check after async connect
      if (currentSessionTargetMatches(parsed.to, activeClient.sessionId, activeClient)) {
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      try {
        const result = await activeClient.send(parsed.to, { text: parsed.message });
        if (!stillLive()) return;
        if (!result.delivered) {
          const err = new Error(result.reason ?? "Session not found");
          pi.appendEntry?.(options.errorEntryType, { to: parsed.to, message: parsed.message, error: err.message, timestamp: Date.now() });
          if (options.acknowledge) emitResultDelivery(parsed.requestId, false, err);
          return;
        }
        pi.appendEntry?.("network_sent", { to: parsed.to, messageId: result.id, timestamp: Date.now() });
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
      } catch (e: any) {
        if (!stillLive()) return;
        pi.appendEntry?.(options.errorEntryType, { to: parsed.to, message: parsed.message, error: e.message, timestamp: Date.now() });
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, e);
      }
    })();
  }

  pi.events?.on?.(SUBAGENT_CONTROL_EVENT, (payload: unknown) => {
    relaySubagentPayload(payload, { sender: "subagent-control", status: "needs_attention", errorEntryType: "network_control_error" });
  });
  pi.events?.on?.(SUBAGENT_RESULT_EVENT, (payload: unknown) => {
    relaySubagentPayload(payload, { sender: "subagent-result", status: "result", errorEntryType: "network_result_error", acknowledge: true });
  });

  // ─── contact_supervisor — Full subagent-supervisor bridge (interview + decision + progress) ───
  const orchestratorTarget = process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET?.trim();
  const subRunId = process.env.PI_SUBAGENT_RUN_ID?.trim();
  const subAgent = process.env.PI_SUBAGENT_CHILD_AGENT?.trim();
  const subIndex = process.env.PI_SUBAGENT_CHILD_INDEX?.trim();

  if (orchestratorTarget && subRunId && subAgent && subIndex) {
    function formatSubagentMessage(kind: "ask" | "update" | "interview", msg: string): string {
      const heading = kind === "ask" ? "Subagent needs a supervisor decision."
        : kind === "interview" ? "Subagent requests a structured interview."
        : "Subagent progress update.";
      return [heading, `Run: ${subRunId}`, `Agent: ${subAgent}`, `Child: ${subIndex}`, "", msg].join("\n");
    }

    pi.registerTool({
      name: "contact_supervisor",
      label: "Contact Supervisor",
      description: "Subagent-only: contact the supervisor. Use 'need_decision' when blocked (blocks until reply). Use 'interview_request' for structured Q&A (blocks until reply). Use 'progress_update' for plan-changing updates (fire-and-forget). Do not use for routine completion.",
      promptSnippet: "Contact supervisor",
      promptGuidelines: [
        "Use reason='need_decision' when blocked, uncertain, or needing approval.",
        "Use reason='interview_request' when you need multiple structured answers.",
        "Use reason='progress_update' only for meaningful plan-changing updates.",
        "Do not use for routine completion handoffs.",
      ],
      parameters: Type.Object({
        reason: StringEnum(["need_decision", "progress_update", "interview_request"], { description: "Contact reason" }),
        message: Type.Optional(Type.String({ description: "Decision request, interview note, or progress update" })),
        interview: Type.Optional(Type.Object({
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          questions: Type.Array(Type.Object({
            id: Type.String(),
            type: Type.String({ description: "single|multi|text|image|info" }),
            question: Type.String(),
            options: Type.Optional(Type.Array(Type.Any())),
            context: Type.Optional(Type.String()),
          })),
        }, { description: "Structured interview for reason='interview_request'" })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { reason, message, interview } = params;

        // Validate interview if provided
        const interviewResult = reason === "interview_request" ? validateInterviewRequest(interview) : undefined;
        if (interviewResult?.ok === false) return { content: [{ type: "text", text: `Invalid interview: ${interviewResult.error}` }], isError: true };
        const validInterview = interviewResult?.ok === true ? interviewResult.interview : undefined;

        if ((reason === "need_decision" || reason === "progress_update") && typeof message !== "string") {
          return { content: [{ type: "text", text: `Missing 'message' for reason='${reason}'` }], isError: true };
        }

        // Local self-delivery
        if (currentSessionTargetMatches(orchestratorTarget)) {
          const localMsg = reason === "interview_request"
            ? formatSubagentMessage("interview", formatInterviewRequest(validInterview!, message))
            : formatSubagentMessage(reason === "need_decision" ? "ask" : "update", message!);
          deliverLocalSubagentRelayMessage("subagent-control", reason === "progress_update" ? "update" : "needs_attention", localMsg);
          if (reason === "progress_update") return { content: [{ type: "text", text: `Progress update delivered locally to ${orchestratorTarget}` }] };
          // Can't block for local reply in same process — return the formatted question
          return { content: [{ type: "text", text: `Delivered locally to supervisor. Cannot block for reply in same process.` }] };
        }

        let client: BrokerClient;
        try { client = await ensureBrokerConnected("tool"); } catch (e: any) {
          return { content: [{ type: "text", text: `❌ Not connected: ${e.message}` }], isError: true };
        }

        const requestText = reason === "interview_request"
          ? formatSubagentMessage("interview", formatInterviewRequest(validInterview!, message))
          : formatSubagentMessage(reason === "need_decision" ? "ask" : "update", message!);

        if (reason === "progress_update") {
          try {
            const result = await client.send(orchestratorTarget, { text: requestText });
            pi.appendEntry?.("network_sent", { to: orchestratorTarget, message: message!.slice(0, 200), reason, timestamp: Date.now() });
            return {
              content: [{ type: "text", text: result.delivered ? `Progress update sent to supervisor ${orchestratorTarget}` : `Not delivered: ${result.reason}` }],
              isError: !result.delivered,
            };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
          }
        }

        // need_decision or interview_request: block until reply
        if (replyWaiter) return { content: [{ type: "text", text: "Already waiting for a reply" }], isError: true };
        if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], isError: true };
        const questionId = randomUUID();
        let replyPromise: Promise<any> | null = null;
        try {
          replyPromise = waitForReply(orchestratorTarget, questionId, signal);
          const sendResult = await client.send(orchestratorTarget, { text: requestText, messageId: questionId, expectsReply: true });
          if (!sendResult.delivered) {
            if (replyWaiter?.replyTo === questionId) replyWaiter = null;
            return { content: [{ type: "text", text: `Not delivered: ${sendResult.reason}` }], isError: true };
          }
          pi.appendEntry?.("network_sent", { to: orchestratorTarget, messageId: questionId, message: (message ?? "").slice(0, 200), reason, timestamp: Date.now() });
          const reply = await replyPromise;
          const replyText = reply.message.content.text;

          // Parse structured interview reply if applicable
          if (reason === "interview_request" && validInterview) {
            const parsed = parseInterviewReply(replyText, validInterview);
            return {
              content: [{ type: "text", text: `**Reply from supervisor:**\n${replyText}` }],
              ...(parsed?.value ? { details: { structuredReply: parsed.value } } : parsed?.error ? { details: { structuredReplyParseError: parsed.error } } : {}),
            };
          }
          return { content: [{ type: "text", text: `**Reply from supervisor:**\n${replyText}` }] };
        } catch (e: any) {
          if (replyWaiter?.replyTo === questionId) replyWaiter = null;
          return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
        }
      },
      renderCall(args: any, theme: any) {
        const reason = args.reason || "contact";
        const msgPreview = previewText(args.message, 80);
        const color = reason === "need_decision" ? "warning" : reason === "interview_request" ? "accent" : "muted";
        let text = theme.fg("toolTitle", theme.bold("contact_supervisor ")) + theme.fg(color, reason);
        if (args.interview?.title) text += " " + theme.fg("accent", args.interview.title.trim());
        if (msgPreview) text += "\n  " + theme.fg("dim", msgPreview);
        return new Text(text, 0, 0);
      },
      renderResult(result: any, { isPartial }: any, theme: any) {
        if (isPartial) return new Text(theme.fg("warning", "⏳ Waiting for supervisor..."), 0, 0);
        const t = result.content?.[0]?.text ?? "";
        const failed = result.isError || t.startsWith("❌");
        const parseWarn = Boolean(result.details?.structuredReplyParseError);
        let text = (failed ? theme.fg("error", "✗ ") : parseWarn ? theme.fg("warning", "⚠ ") : theme.fg("success", "✓ "));
        text += theme.fg(failed ? "error" : "text", t.replace(/^[✅❌] /, "").slice(0, 120));
        if (parseWarn) text += "\n" + theme.fg("warning", `Parse issue: ${result.details.structuredReplyParseError}`);
        return new Text(text, 0, 0);
      },
    });
  }

  // git_sync — Git synchronization tool (worker: branch/commit/push, manager: fetch/merge/consolidate)
  pi.registerTool({
    name: "git_sync",
    label: "Git Sync",
    description: "Git branch coordination. Workers: branch/commit/push. Manager: fetch/merge/consolidate.",
    promptSnippet: "Sync git branch",
    parameters: Type.Object({
      action: StringEnum(["status", "branch", "commit", "push", "fetch", "branches", "diff", "merge", "consolidate", "abort"], { description: "Git sync action to perform" }),
      task_description: Type.Optional(Type.String({ description: "Task description for branch name or commit message" })),
      branch: Type.Optional(Type.String({ description: "Branch name for merge/diff/consolidate operations" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!gitSync) {
        return { content: [{ type: "text", text: "⬜ Git sync is not configured. Add git_sync to your config.json." }] };
      }

      switch (params.action) {
        case "status": {
          return { content: [{ type: "text", text: gitSync.getStatus() }] };
        }
        case "branch": {
          if (config.role !== "worker") {
            return { content: [{ type: "text", text: "❌ Only workers create task branches. Manager reviews and merges." }] };
          }
          const desc = params.task_description || "untitled";
          const branchName = gitSync.createTaskBranch(desc);
          return { content: [{ type: "text", text: `🌿 Created branch: ${branchName}\nYou can now edit files. They will be auto-committed when your task completes.` }] };
        }
        case "commit": {
          const desc = params.task_description || "work in progress";
          const taskId = params.branch || "manual";
          const committed = gitSync.autoCommit(desc, taskId);
          return { content: [{ type: "text", text: committed ? `✅ Changes committed and pushed to ${gitSync.getCurrentBranch()}` : "ℹ️ No changes to commit" }] };
        }
        case "push": {
          gitSync.pushCurrentBranch();
          return { content: [{ type: "text", text: `📤 Pushed ${gitSync.getCurrentBranch()}` }] };
        }
        case "fetch": {
          gitSync.fetch();
          return { content: [{ type: "text", text: "📥 Fetched all remotes" }] };
        }
        case "branches": {
          const branches = gitSync.listAgentBranches();
          if (branches.length === 0) {
            return { content: [{ type: "text", text: "No agent branches found" }] };
          }
          const lines = branches.map(b => {
            const icon = b.isClean ? "🟢" : "🔴";
            return `${icon} ${b.name} (${b.lastCommitAuthor}, ${b.aheadBy} ahead) — ${b.lastCommitMessage}`;
          });
          return { content: [{ type: "text", text: `🌿 Agent Branches:\n${lines.join("\n")}` }] };
        }
        case "diff": {
          const branchName = params.branch;
          if (!branchName) return { content: [{ type: "text", text: "❌ Specify branch name" }] };
          const diff = gitSync.getBranchDiff(branchName);
          return { content: [{ type: "text", text: `📊 Diff for ${branchName}:\n${diff}` }] };
        }
        case "merge": {
          const branchName = params.branch;
          if (!branchName) return { content: [{ type: "text", text: "❌ Specify branch name" }] };
          const result = gitSync.mergeBranch(branchName);
          if (result.merged) {
            return { content: [{ type: "text", text: `✅ Merged ${branchName} into ${gitSync.getStatus().split("base: ")[1]?.split(" ")[0] || "main"}` }] };
          } else if (result.hadConflicts) {
            return { content: [{ type: "text", text: `🔴 Conflicts in ${branchName}:\n\n${result.conflictedFiles.map(f => `  - ${f}`).join("\n")}\n\nResolve the conflicts in these files, then use git_sync action=consolidate branch=${branchName}` }] };
          } else {
            return { content: [{ type: "text", text: `❌ ${result.message}` }] };
          }
        }
        case "consolidate": {
          const branchName = params.branch;
          if (!branchName) return { content: [{ type: "text", text: "❌ Specify branch name" }] };
          const conflicts = gitSync.getConflictedFiles();
          if (conflicts.length > 0) {
            return { content: [{ type: "text", text: `⚠️ Still have conflict markers in:\n${conflicts.map(f => `  - ${f}`).join("\n")}\n\nRead each file, resolve the conflict markers (<<<<<<<, =======, >>>>>>>), then call consolidate again.` }] };
          }
          const resolved = new Map<string, string>();
          const mergeResult = gitSync.consolidateBranch(branchName, resolved);
          return { content: [{ type: "text", text: mergeResult.merged ? `✅ ${mergeResult.message}` : `❌ ${mergeResult.message}` }] };
        }
        case "abort": {
          gitSync.abortMerge();
          return { content: [{ type: "text", text: "🛑 Merge aborted" }] };
        }
        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
      }
    },
  });

  // ─── Message renderers (framed inline messages) ───
  const NETWORK_MESSAGE_TYPES = [
    "network-inbound",
    "network-queued",
    "network-result",
    "bridge-clarification",
    "bridge-result",
    "bridge-file",
  ];

  for (const customType of NETWORK_MESSAGE_TYPES) {
    pi.registerMessageRenderer(customType, (message, _options, theme) => {
      const details = message.details as ReturnType<typeof makeMessageDetails> | undefined;
      if (details) {
        return new NetworkInlineMessage(details, theme);
      }
      // Fallback: plain text
      return new Text(message.content || "", 0, 0);
    });
  }

  // ─── Slash commands ───
  pi.registerCommand("git-sync", {
    description: "Git sync: status/fetch/branches/merge/diff/consolidate. Manager-only: merge, consolidate.",
    async handler(args, ctx) {
      const parts = (args || "").trim().split(/\s+/);
      const subcommand = parts[0] || "status";
      const target = parts[1];

      if (!gitSync) {
        ctx.ui.notify("⬜ Git sync is not configured. Add git_sync to your config.json.", "info");
        return;
      }

      switch (subcommand) {
        case "status": {
          ctx.ui.notify(`🔀 Git Sync\n${gitSync.getStatus()}`, "info");
          break;
        }
        case "fetch": {
          gitSync.fetch();
          ctx.ui.notify("📥 Fetched all remotes", "info");
          break;
        }
        case "branches": {
          const branches = gitSync.listAgentBranches();
          if (branches.length === 0) {
            ctx.ui.notify("No agent branches found", "info");
          } else {
            const lines = branches.map(b => {
              const icon = b.isClean ? "🟢" : "🔴";
              const ahead = b.aheadBy > 0 ? ` +${b.aheadBy}` : "";
              const behind = b.behindBy > 0 ? ` -${b.behindBy}` : "";
              return `  ${icon} ${b.name} (${b.lastCommitAuthor}, ${b.lastCommitDate})${ahead}${behind}\n     ${b.lastCommitMessage}`;
            });
            ctx.ui.notify(`🌿 Agent Branches\n${lines.join("\n")}`, "info");
          }
          break;
        }
        case "diff": {
          if (!target) {
            ctx.ui.notify("Usage: /git-sync diff <branch-name>", "info");
            break;
          }
          const diff = gitSync.getBranchDiff(target);
          ctx.ui.notify(`📊 Diff: ${target}\n${diff}`, "info");
          break;
        }
        case "full-diff": {
          if (!target) {
            ctx.ui.notify("Usage: /git-sync full-diff <branch-name>", "info");
            break;
          }
          const fullDiff = gitSync.getBranchFullDiff(target);
          ctx.ui.notify(`📊 Full Diff: ${target}\n${fullDiff.slice(0, 5000)}`, "info");
          break;
        }
        case "merge": {
          if (!target) {
            ctx.ui.notify("Usage: /git-sync merge <branch-name>", "info");
            break;
          }
          const result = gitSync.mergeBranch(target);
          if (result.merged) {
            ctx.ui.notify(`✅ Merged ${target} into main`, "info");
          } else if (result.hadConflicts) {
            ctx.ui.notify(`🔴 Conflicts in ${target}:\n${result.conflictedFiles.join("\n")}\n\nResolve conflicts then: /git-sync consolidate ${target}`, "info");
          } else {
            ctx.ui.notify(`❌ Merge failed: ${result.message}`, "info");
          }
          break;
        }
        case "consolidate": {
          if (!target) {
            ctx.ui.notify("Usage: /git-sync consolidate <branch-name>", "info");
            break;
          }
          ctx.ui.notify(`📋 To consolidate ${target}:\n1. Resolve conflict markers in the files\n2. /git-sync finalize ${target}`, "info");
          break;
        }
        case "finalize": {
          if (!target) {
            ctx.ui.notify("Usage: /git-sync finalize <branch-name>", "info");
            break;
          }
          // Read all conflicted files and pass them as resolved
          const conflicts = gitSync.getConflictedFiles();
          if (conflicts.length === 0) {
            // No active conflicts — just stage and commit
            const resolved = new Map<string, string>();
            const mergeResult = gitSync.consolidateBranch(target, resolved);
            ctx.ui.notify(mergeResult.merged ? `✅ ${mergeResult.message}` : `❌ ${mergeResult.message}`, "info");
          } else {
            ctx.ui.notify(`⚠️ Still conflicts in: ${conflicts.join(", ")}\nResolve them first, then /git-sync finalize ${target}`, "info");
          }
          break;
        }
        case "abort": {
          gitSync.abortMerge();
          ctx.ui.notify("🛑 Merge aborted", "info");
          break;
        }
        default:
          ctx.ui.notify(`Unknown subcommand: ${subcommand}\nUsage: /git-sync [status|fetch|branches|diff|merge|consolidate|finalize|abort]`, "info");
      }
    },
  });

  pi.registerCommand("network", {
    description: "Network operations: status, send (compose message to peer), manage peers.",
    async handler(args, ctx) {
      const parts = (args || "").trim().split(/\s+/);
      const subcommand = parts[0] || "status";

      // /network status → show peers and connection info
      if (subcommand === "status" || !subcommand) {
        // Collect pi sessions from broker
        let piSessions: any[] = [];
        try { if (brokerClient?.isConnected()) piSessions = await brokerClient.listSessions(); } catch {}
        const others = piSessions.filter((s: any) => s.id !== currentSessionId);
        const me = piSessions.find((s: any) => s.id === currentSessionId);
        // Collect Claude sessions from ~/.claude/sessions/
        const claudeSessions = discoverClaudeSessions();
        let status = `📡 **Network Status**\n`;
        status += `You: **${me?.name || pi.getSessionName?.() || config.localName}** [${detectRuntime()}]\n`;
        status += `Broker: ${brokerClient?.isConnected() ? "connected" : "disconnected"}\n`;
        if (others.length > 0 || claudeSessions.length > 0) {
          status += `\nPeers:\n`;
          for (const s of others) {
            const icon = (s.status?.includes("online") || s.status?.includes("idle") || s.status?.startsWith("🟢")) ? "🟢" : (s.status?.includes("busy") || s.status?.includes("tool:")) ? "🟡" : "🔴";
            const rt = s.runtime === "claude" ? "claude" : s.runtime === "pi" ? "pi" : "?";
            const model = (s.model || "?").replace(/^(anthropic\/|openai\/|google\/|x-ai\/|meta\/)/, "");
            status += `${icon} ${s.name || s.id.slice(0, 8)} [${rt}] ${model}\n`;
          }
          for (const s of claudeSessions) {
            const icon = s.status === "idle" || s.status === "online" ? "🟢" : "🟡";
            const model = (s.model || "claude").replace(/^(anthropic\/|openai\/|google\/|x-ai\/|meta\/)/, "");
            status += `${icon} ${s.name} [claude] ${model}\n`;
          }
        } else {
          status += `No other sessions.\n`;
        }
        ctx.ui.notify(status, "info");
        return;
      }

      // /network peers → toggle peer display and layout
      if (subcommand === "peers") {
        const mode = parts[1];
        if (mode === "horizontal" || mode === "h") {
          peerLayout = "horizontal"; showPeersInFooter = true;
          ctx.ui.notify("🌐 Peers: horizontal", "info");
        } else if (mode === "vertical" || mode === "v") {
          peerLayout = "vertical"; showPeersInFooter = true;
          ctx.ui.notify("🌐 Peers: vertical", "info");
        } else {
          showPeersInFooter = !showPeersInFooter;
          if (!showPeersInFooter) ctx.ui.setStatus("bridge", undefined as any);
          else refreshAgentsFromBroker();
          ctx.ui.notify("🌐 Peers: " + (showPeersInFooter ? peerLayout : "OFF"), "info");
        }
        return;
      }

            // /network send → pick peer and compose message
      if (subcommand === "send") {
        if (!ctx.hasUI) {
          ctx.ui.notify("❌ /network send requires interactive TUI", "warning");
          return;
        }
        agents = loadRegistry();
        const onlinePeers = agents.filter(a => a.name !== config.localName && a.status === "online");
        if (onlinePeers.length === 0) {
          ctx.ui.notify("No peers online to message", "warning");
          return;
        }

        try {
          // Step 1: Pick a peer
          const pick = await ctx.ui.custom<{ peer: AgentEntry } | undefined>(
            (_tui, theme, keybindings, done) =>
              new PeerListOverlay(theme, keybindings, config.localName, onlinePeers, done),
            { overlay: true },
          );
          if (!pick?.peer) return;

          // Step 2: Compose message
          const composeResult = await ctx.ui.custom<{ sent: boolean; text?: string; mode?: string }>(
            (tui, theme, keybindings, done) =>
              new NetworkComposeOverlay(tui, theme, keybindings, pick.peer, done),
            { overlay: true },
          );

          if (composeResult?.sent && composeResult.text) {
            // Send the task via transport
            const envelope: TaskEnvelope = {
              taskId: ulid(),
              rootTaskId: "",
              task: composeResult.text,
              from: config.localName,
              fromSession: config.localName,
              deliverTo: pick.peer.name,
              deliverToSession: pick.peer.name,
              hops: 0,
              originInstructor: config.localName,
              originSession: config.localName,
              createdAt: Date.now(),
              mode: (composeResult.mode || "agent") as TaskMode,
              priority: "normal",
              status: "running",
              needsConsolidation: false,
              isConsolidated: false,
              partialResults: [],
              chain: [],
              result: "",
              files: [],
            };

            try {
              await transport.send(pick.peer.name, envelope);
              ctx.ui.notify(`✉️ Task sent to ${pick.peer.name}`, "info");
              appendAudit({ event: "task_sent", sender: config.localName, recipient: pick.peer.name, taskId: envelope.taskId, hops: 0 });
            } catch (e: any) {
              ctx.ui.notify(`❌ Failed to send: ${e.message}`, "error");
            }
          }
        } catch {
          // Overlay cancelled or errored
        }
        return;
      }

      const flags = parts;
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
      if (gitSync) lines.push(`  Git: ${gitSync.getStatus()}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── Keyboard shortcut ───
  pi.registerShortcut("alt+n", {
    description: "Open network compose (send message to mesh peer)",
    handler: async (ctx) => {
      agents = loadRegistry();
      const onlinePeers = agents.filter(a => a.name !== config.localName && a.status === "online");
      if (onlinePeers.length === 0) {
        ctx.ui.notify("No peers online to message", "warning");
        return;
      }
      try {
        const pick = await ctx.ui.custom<{ peer: AgentEntry } | undefined>(
          (_tui, theme, keybindings, done) =>
            new PeerListOverlay(theme, keybindings, config.localName, onlinePeers, done),
          { overlay: true },
        );
        if (!pick?.peer) return;

        const composeResult = await ctx.ui.custom<{ sent: boolean; text?: string; mode?: string }>(
          (tui, theme, keybindings, done) =>
            new NetworkComposeOverlay(tui, theme, keybindings, pick.peer, done),
          { overlay: true },
        );

        if (composeResult?.sent && composeResult.text) {
          const envelope: TaskEnvelope = {
            taskId: ulid(), rootTaskId: "",
            task: composeResult.text,
            from: config.localName, fromSession: config.localName,
            deliverTo: pick.peer.name, deliverToSession: pick.peer.name,
            hops: 0, originInstructor: config.localName, originSession: config.localName,
            createdAt: Date.now(), mode: (composeResult.mode || "agent") as TaskMode,
            priority: "normal", status: "running",
            needsConsolidation: false, isConsolidated: false, partialResults: [],
            chain: [], result: "", files: [],
          };
          try {
            await transport.send(pick.peer.name, envelope);
            ctx.ui.notify(`✉️ Task sent to ${pick.peer.name}`, "info");
          } catch (e: any) {
            ctx.ui.notify(`❌ Failed: ${e.message}`, "error");
          }
        }
      } catch {}
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
