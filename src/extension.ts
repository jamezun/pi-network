// Pi Network — Pi Coding Agent Extension
// The main entry point. Registers tools, manages tasks, handles communication.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { resolve, dirname, join } from "node:path";
import { existsSync, readFileSync, mkdirSync } from "node:fs";

import { loadConfig, resolveMode, getBridgeDir, getPeerUrl, getTailnetPeers } from "./core/config";
import type { BridgeConfig, NetworkMode, AgentStatus } from "./core/config";
import { createEnvelope, extractResultFromMessages, generateId } from "./core/tasks";
import type { TaskEnvelope, TaskResult } from "./core/tasks";
import { createTransport } from "./transport";
import type { Transport } from "./transport";
import { ConcurrencyManager } from "./core/concurrency";
import { acquireLock, releaseLock, releaseAllForTask, checkFileLock, shiftLocksAfterEdit, getAllLocks, getLocksForFile } from "./core/locks";
import { loadRegistry, updateAgentInRegistry } from "./core/registry";
import type { AgentEntry } from "./core/registry";
import { pushToOutbox, readAllOutbox } from "./core/queue";
import { buildAgentPrompt } from "./core/prompt";
import { getSecret, listSecretNames, encryptForTransfer, decryptTransfer } from "./core/vault";
import { appendHistory, readHistory, updateHistoryStatus, formatHistory } from "./core/task-history";
import { readFileForSend, saveReceivedFile } from "./core/files";

// ─── State ───

let config: BridgeConfig;
let mode: NetworkMode;
let transport: Transport;
let concurrency: ConcurrencyManager;
let agents: AgentEntry[] = [];
let localStatus: AgentStatus = "online";
const activeEnvelopes: Map<string, TaskEnvelope> = new Map();
const pendingClarifications: Map<string, {
  question: string;
  fromAgent: string;
  resolve: (answer: string) => void;
}> = new Map();

let bridgeServer: any;
let pi: ExtensionAPI;

// ─── Local Bridge Server ───

function startLocalBridge(port: number) {
  const http = require("http");
  bridgeServer = http.createServer(async (req: any, res: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    let body: any = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try { body = JSON.parse(raw); } catch {}
    }

    if (req.method === "GET" && url.pathname === "/ping") {
      res.end(JSON.stringify({ pong: true, name: config.localName }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      res.end(JSON.stringify({
        name: config.localName, sessionName: "active", role: config.role,
        online: true, status: localStatus,
        queueLength: concurrency.getQueueLength(),
        activeTaskCount: concurrency.getRunningCount(),
        maxConcurrentTasks: config.maxConcurrentTasks,
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/task") {
      const envelope: TaskEnvelope = body;
      const action = concurrency.enqueue(envelope);
      updateHistoryStatus(envelope.taskId, action === "queued" ? "queued" : "running");
      res.end(JSON.stringify({ accepted: true, status: action }));
      if (action === "running") injectTask(envelope);
      return;
    }

    if (req.method === "POST" && url.pathname === "/result") {
      const result: TaskResult = body;
      res.end(JSON.stringify({ delivered: true }));
      const clar = pendingClarifications.get(result.taskId);
      if (clar) { clar.resolve(result.result); pendingClarifications.delete(result.taskId); return; }
      deliverResult(result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/file") {
      res.end(JSON.stringify({ received: true }));
      const dir = getBridgeDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const dest = body.remotePath || join(dir, "inbox", body.filename);
      const { writeFile } = require("node:fs");
      const { dirname: dn } = require("node:path");
      const destDir = dn(dest);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      writeFile(dest, Buffer.from(body.content, "base64"), () => {});
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
  bridgeServer.listen(port, () => {});
}

function stopLocalBridge() { bridgeServer?.close(); }

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
    `Root task: ${envelope.rootTaskId.slice(0, 12)}\n` +
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
}

// ─── The Extension ───

export default function extension(api: ExtensionAPI) {
  pi = api;

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadConfig();
    } catch (e: any) {
      ctx.ui.notify(`⚠️ Pi Network: ${e.message}`, "error");
      return;
    }

    mode = resolveMode(config);
    const tailnet = getTailnetPeers();

    ctx.ui.notify(
      `🌐 Bridge: ${mode.toUpperCase()} mode` +
      (tailnet.size > 0 ? ` (${tailnet.size} tailnet peers)` : "") +
      (config.server ? ` (Server: ${config.server.url})` : ""),
      "info"
    );

    agents = loadRegistry();
    transport = createTransport(mode, config);
    await transport.start();
    concurrency = new ConcurrencyManager(config);
    startLocalBridge(config.bridgePort);

    updateAgentInRegistry(agents, {
      name: config.localName, role: config.role,
      capabilities: config.capabilities, specialties: config.specialties,
      manages: config.manages, reportTo: config.reportTo,
      status: "online",
      sessionName: ctx.sessionManager?.getSessionFile?.()?.split("/").pop(),
      model: ctx.model?.id,
      maxConcurrentTasks: config.maxConcurrentTasks,
    });

    const onlineCount = agents.filter((a) => a.status !== "offline" && a.name !== config.localName).length;
    ctx.ui.setStatus("bridge", `🌐 ${mode.toUpperCase()} | ${onlineCount}/${Object.keys(config.peers).length} peers`);

    transport.onMessage((msg) => {
      if (msg.type === "message" && msg.payload) {
        if (msg.payload.type === "result") {
          deliverResult(msg.payload);
        } else if (msg.payload.type === "file") {
          pi.sendMessage({ customType: "bridge-file", content: `📂 File from ${msg.from}: ${msg.payload.filename}`, display: true });
        } else {
          const envelope = msg.payload as TaskEnvelope;
          const action = concurrency.enqueue(envelope);
          if (action === "running") injectTask(envelope);
        }
      } else if (msg.type === "registry_update") {
        agents = loadRegistry();
      }
    });
  });

  pi.on("session_shutdown", async () => {
    await transport?.stop();
    stopLocalBridge();
    updateAgentInRegistry(agents, { name: config.localName, status: "offline" });
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const tailnet = mode === "tailscale" || mode === "hybrid" ? getTailnetPeers() : null;
    const prompt = buildAgentPrompt(agents, config, mode, concurrency, localStatus, tailnet || undefined);
    if (!prompt) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + prompt };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!["write", "edit"].includes(event.toolName)) return;
    const filePath = event.input.path;
    if (!filePath) return;
    const absolutePath = resolve(ctx.cwd, filePath);

    if (event.toolName === "write") {
      const lock = await checkFileLock(absolutePath, 1, Infinity, config.localName, config);
      if (lock) {
        return { block: true, reason: `🔒 ${filePath} is locked by ${lock.agent}/${lock.session} (lines ${lock.startLine}-${lock.endLine}).` };
      }
      acquireLock({ filePath: absolutePath, startLine: 1, endLine: Infinity, agent: config.localName, session: pi.getSessionName?.() || "", taskId: "local-write", rootTaskId: "local", since: Date.now() }, config);
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
      const resultPayload: TaskResult = {
        taskId: envelope.taskId, rootTaskId: envelope.rootTaskId,
        from: config.localName, fromSession: pi.getSessionName?.() || "unknown",
        deliverTo: envelope.deliverTo,
        deliverToSession: envelope.chain.length > 0 ? envelope.chain[envelope.chain.length - 1].session : undefined,
        result, files: [], chain: envelope.chain,
        originInstructor: envelope.originInstructor, originSession: envelope.originSession,
        needsConsolidation: envelope.requiresConsolidation,
        isConsolidated: false, partialResults: [], status: "completed",
      };

      activeEnvelopes.delete(taskId);
      concurrency.complete(taskId);
      releaseAllForTask(envelope.rootTaskId, config);
      updateHistoryStatus(taskId, "completed", result.slice(0, 200));

      await transport.sendResult(envelope.deliverTo, resultPayload).catch(() => {
        pushToOutbox(envelope.deliverTo, envelope);
      });

      const next = concurrency.dequeue();
      if (next) injectTask(next);
      return;
    }
  });

  pi.on("message_update", async () => {
    for (const [taskId] of activeEnvelopes) concurrency.heartbeat(taskId);
  });

  // ─── Tools ───

  pi.registerTool({
    name: "remote_task",
    label: "Remote Task",
    description: "Send a task to a remote agent. Results arrive as messages.",
    promptSnippet: "Delegate work to remote agent",
    promptGuidelines: ["Match task to agent specialties", "Use peer name from config"],
    parameters: Type.Object({
      peer: Type.String({ description: "Peer name from config" }),
      task: Type.String({ description: "Task to execute" }),
      mode: Type.Optional(StringEnum(["agent", "inbox", "raw"] as const, { description: "agent (default), inbox, or raw" })),
      priority: Type.Optional(StringEnum(["urgent", "high", "normal", "low"] as const, { description: "Priority level" })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const { peer, task, mode: taskMode, priority } = params;
      onUpdate?.({ content: [{ type: "text", text: `Sending task to ${peer}...` }] });

      const envelope = createEnvelope({
        task, taskType: taskMode || "agent", priority: priority || "normal",
        from: config.localName, fromSession: pi.getSessionName?.() || "unknown",
        deliverTo: config.localName, requiresConsolidation: false, userId: config.userId,
      });

      const sendResult = await transport.send(peer, envelope);
      appendHistory({
        taskId: envelope.taskId, rootTaskId: envelope.rootTaskId,
        direction: "sent", peer, task,
        status: sendResult.delivered ? "running" : "queued",
        priority: envelope.priority, timestamp: Date.now(), userId: config.userId,
      });

      return {
        content: [{ type: "text", text: sendResult.delivered
          ? `✅ Task sent to ${peer}. They're online. Results will arrive when done.`
          : `📭 ${peer} is offline. Task queued (retry every ${config.retryInterval}s).`
        }],
        details: { peer, delivered: sendResult.delivered, taskId: envelope.taskId },
      };
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
    description: "Send a task to all online agents or filtered by capability.",
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

      const results: string[] = [];
      for (const agent of targets) {
        const envelope = createEnvelope({
          task: params.task, taskType: "agent", priority: params.priority || "normal",
          from: config.localName, fromSession: pi.getSessionName?.() || "unknown",
          deliverTo: config.localName, requiresConsolidation: true, userId: config.userId,
        });
        const sr = await transport.send(agent.name, envelope);
        results.push(`${agent.name}: ${sr.delivered ? "✅" : "📭 queued"}`);
        appendHistory({
          taskId: envelope.taskId, rootTaskId: envelope.rootTaskId,
          direction: "sent", peer: agent.name, task: params.task,
          status: sr.delivered ? "running" : "queued",
          priority: envelope.priority, timestamp: Date.now(), userId: config.userId,
        });
      }

      return { content: [{ type: "text", text: `Broadcast to ${targets.length} agents:\n${results.join("\n")}` }] };
    },
  });

  pi.registerTool({
    name: "peer_status",
    label: "Peer Status",
    description: "Get detailed status of all peers or a specific peer.",
    parameters: Type.Object({
      peer: Type.Optional(Type.String({ description: "Specific peer name (omit for all)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (params.peer) {
        const agent = agents.find((a) => a.name === params.peer);
        if (!agent) return { content: [{ type: "text", text: `Unknown peer: ${params.peer}` }] };
        const reachable = await transport.ping(params.peer);
        return {
          content: [{ type: "text", text:
            `**${agent.name}** (${agent.role})\n` +
            `Status: ${reachable ? "🟢 reachable" : "🔴 unreachable"}\n` +
            `Capabilities: ${agent.capabilities.join(", ")}\n` +
            `Specialties: ${agent.specialties.join(", ")}\n` +
            `Model: ${agent.model || "unknown"}\n` +
            `Session: ${agent.sessionName || "none"}`
          }],
        };
      }

      const lines: string[] = ["## Network Status\n"];
      for (const agent of agents) {
        if (agent.name === config.localName) continue;
        const icon = agent.status === "online" ? "🟢" : agent.status === "busy" ? "🟡" : agent.status === "unresponsive" ? "🟠" : "🔴";
        lines.push(`${icon} **${agent.name}** (${agent.role}) — ${agent.capabilities.join(", ")}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "ask_origin",
    label: "Ask Origin",
    description: "Ask a clarification question that routes through the chain back to the origin. If nobody knows, asks the human user.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to clarify" }),
      question: Type.String({ description: "Your question" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const envelope = activeEnvelopes.get(params.taskId);
      if (!envelope) {
        return { content: [{ type: "text", text: `No active task ${params.taskId}` }] };
      }

      // Route through chain
      const chainHead = envelope.chain.length > 0 ? envelope.chain[0] : null;
      if (chainHead && chainHead.agent !== config.localName) {
        await transport.sendClarification(chainHead.agent, params.taskId, params.question);
        return { content: [{ type: "text", text: `💬 Sent clarification to ${chainHead.agent}. Waiting for answer...` }] };
      }

      // We're the origin — ask the human
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
        task: `VAULT:${params.key}:${encrypted.encrypted}:${params.taskId}`,
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
        // Push to peer's bare repo
        const { execSync } = require("node:child_process");
        try {
          execSync(`git remote remove pi-${params.peer} 2>/dev/null || true`, { cwd: projectPath });
          execSync(`git remote add pi-${params.peer} ${peerUrl}/git/${params.project || "default"}`, { cwd: projectPath });
          execSync(`git push pi-${params.peer} HEAD --force`, { cwd: projectPath, timeout: 30000 });
          return { content: [{ type: "text", text: `✅ Pushed to ${params.peer}` }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `❌ Push failed: ${e.message}` }] };
        }
      } else {
        // Pull from peer
        const { execSync } = require("node:child_process");
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
}