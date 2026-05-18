// Pi Network — Relay Server
// Deploy to VPS. Handles message queue, registry, file locks, file store, WebSocket hub.
//
// Usage: BRIDGE_API_KEY=your-secret node relay.js

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PORT = parseInt(process.env.BRIDGE_PORT || "9765");
const API_KEY = process.env.BRIDGE_API_KEY || "change-me";
const FILE_DIR = process.env.BRIDGE_FILE_DIR || "/tmp/pi-bridge-files";

// ─── State ───

interface PeerState {
  name: string;
  sessionName?: string;
  role: string;
  capabilities: string[];
  specialties: string[];
  manages: string[];
  reportTo: string | null;
  online: boolean;
  lastSeen: number;
}

interface Message {
  id: string;
  from: string;
  to: string;
  payload: any;
  timestamp: number;
  acked: boolean;
}

interface FileLock {
  filePath: string;
  startLine: number;
  endLine: number;
  agent: string;
  session: string;
  taskId: string;
  rootTaskId: string;
  since: number;
  description?: string;
}

interface AgentRegistryEntry {
  name: string;
  role: string;
  capabilities: string[];
  specialties: string[];
  manages: string[];
  reportTo: string | null;
  lastUpdated: number;
}

const peers: Map<string, PeerState> = new Map();
const messageQueue: Map<string, Message[]> = new Map();
const fileLocks: Map<string, FileLock> = new Map();
const agentRegistry: Map<string, AgentRegistryEntry> = new Map();
const wsClients: Map<string, WebSocket> = new Map();
let registryVersion = 0;

// ─── Helpers ───

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function authenticate(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  return auth === `Bearer ${API_KEY}`;
}

function ensureFileDir(): void {
  if (!existsSync(FILE_DIR)) mkdirSync(FILE_DIR, { recursive: true });
}

// ─── HTTP Server ───

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.end(); return; }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.pathname;

  // ── Register ──
  if (req.method === "POST" && path === "/register") {
    const body = await readBody(req);
    peers.set(body.name, {
      name: body.name,
      sessionName: body.sessionName,
      role: body.role || "worker",
      capabilities: body.capabilities || [],
      specialties: body.specialties || [],
      manages: body.manages || [],
      reportTo: body.reportTo || null,
      online: true,
      lastSeen: Date.now(),
    });
    if (body.capabilities) {
      agentRegistry.set(body.name, {
        name: body.name,
        role: body.role || "worker",
        capabilities: body.capabilities,
        specialties: body.specialties || [],
        manages: body.manages || [],
        reportTo: body.reportTo || null,
        lastUpdated: Date.now(),
      });
      registryVersion++;
      broadcastRegistryUpdate();
    }
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Deregister ──
  if (req.method === "POST" && path === "/deregister") {
    const body = await readBody(req);
    const peer = peers.get(body.name);
    if (peer) peer.online = false;
    wsClients.delete(body.name);
    registryVersion++;
    broadcastRegistryUpdate();
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Send message ──
  if (req.method === "POST" && path === "/send") {
    const body = await readBody(req);
    const { to, from, payload } = body;
    const wsClient = wsClients.get(to);
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({ type: "message", from, payload }));
      const peerOnline = peers.get(to)?.online ?? false;
      res.end(JSON.stringify({ delivered: true, queued: false, peerOnline }));
    } else {
      if (!messageQueue.has(to)) messageQueue.set(to, []);
      messageQueue.get(to)!.push({ id: generateId(), from, to, payload, timestamp: Date.now(), acked: false });
      const peerOnline = peers.get(to)?.online ?? false;
      res.end(JSON.stringify({ delivered: false, queued: true, peerOnline }));
    }
    return;
  }

  // ── Poll inbox ──
  if (req.method === "GET" && path === "/inbox") {
    const peer = url.searchParams.get("peer")!;
    const since = parseInt(url.searchParams.get("since") || "0");
    const messages = (messageQueue.get(peer) || []).filter((m) => m.timestamp > since && !m.acked);
    if (peers.has(peer)) peers.get(peer)!.lastSeen = Date.now();
    res.end(JSON.stringify({ messages }));
    return;
  }

  // ── Ack ──
  if (req.method === "POST" && path === "/ack") {
    const body = await readBody(req);
    const queue = messageQueue.get(body.peer) || [];
    const msg = queue.find((m) => m.id === body.id);
    if (msg) msg.acked = true;
    // Clean old acked messages
    const cleaned = queue.filter((m) => !m.acked || Date.now() - m.timestamp < 300000);
    messageQueue.set(body.peer, cleaned);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Status ──
  if (req.method === "GET" && path === "/status") {
    const peer = url.searchParams.get("peer");
    if (peer) {
      const p = peers.get(peer);
      res.end(JSON.stringify({ online: p?.online ?? false, lastSeen: p?.lastSeen }));
      return;
    }
    const status: any = {};
    for (const [name, p] of peers) {
      status[name] = { online: p.online, lastSeen: p.lastSeen, session: p.sessionName };
    }
    res.end(JSON.stringify(status));
    return;
  }

  // ── Health ──
  if (req.method === "GET" && path === "/health") {
    res.end(JSON.stringify({
      status: "ok",
      peers: peers.size,
      connected: wsClients.size,
      queuedMessages: Array.from(messageQueue.values()).reduce((s, q) => s + q.filter(m => !m.acked).length, 0),
      activeLocks: fileLocks.size,
      registryVersion,
      uptime: process.uptime(),
    }));
    return;
  }

  // ── File upload ──
  if (req.method === "POST" && path === "/file/upload") {
    const body = await readBody(req);
    ensureFileDir();
    const fileId = generateId();
    writeFileSync(join(FILE_DIR, fileId), Buffer.from(body.content, "base64"));
    if (!messageQueue.has(body.to)) messageQueue.set(body.to, []);
    messageQueue.get(body.to)!.push({
      id: fileId, from: body.from, to: body.to,
      payload: { type: "file", from: body.from, filename: body.filename, remotePath: body.remotePath, fileId, size: body.content.length },
      timestamp: Date.now(), acked: false,
    });
    res.end(JSON.stringify({ fileId, queued: true }));
    return;
  }

  // ── File download ──
  if (req.method === "GET" && path === "/file/download") {
    const fileId = url.searchParams.get("id")!;
    const filePath = join(FILE_DIR, fileId);
    if (existsSync(filePath)) {
      res.end(readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "File not found" }));
    }
    return;
  }

  // ── Lock acquire ──
  if (req.method === "POST" && path === "/lock/acquire") {
    const body = await readBody(req);
    const key = body.filePath.replace(/\\/g, "/").toLowerCase();
    const existing = fileLocks.get(key);
    if (existing && existing.agent !== body.agent) {
      res.writeHead(409);
      res.end(JSON.stringify({ locked: true, by: existing }));
      return;
    }
    fileLocks.set(key, { ...body, since: Date.now() });
    res.end(JSON.stringify({ locked: false, acquired: true }));
    return;
  }

  // ── Lock release ──
  if (req.method === "POST" && path === "/lock/release") {
    const body = await readBody(req);
    const key = (body.filePath || "").replace(/\\/g, "/").toLowerCase();
    fileLocks.delete(key);
    res.end(JSON.stringify({ released: true }));
    return;
  }

  // ── Lock release task ──
  if (req.method === "POST" && path === "/lock/release-task") {
    const body = await readBody(req);
    for (const [key, lock] of fileLocks) {
      if (lock.rootTaskId === body.taskId || lock.taskId === body.taskId) fileLocks.delete(key);
    }
    res.end(JSON.stringify({ released: true }));
    return;
  }

  // ── List locks ──
  if (req.method === "GET" && path === "/locks") {
    const file = url.searchParams.get("file");
    const result: any = {};
    for (const [key, lock] of fileLocks) {
      if (!file || key === file) result[key] = lock;
    }
    res.end(JSON.stringify(result));
    return;
  }

  // ── Registry ──
  if (req.method === "GET" && path === "/registry") {
    const agents: any = {};
    for (const [name, entry] of agentRegistry) agents[name] = entry;
    res.end(JSON.stringify({ agents, version: registryVersion }));
    return;
  }

  if (req.method === "GET" && path === "/registry/version") {
    res.end(JSON.stringify({ version: registryVersion }));
    return;
  }

  if (req.method === "POST" && path === "/registry/update") {
    const body = await readBody(req);
    agentRegistry.set(body.agent.name, { ...body.agent, lastUpdated: Date.now() });
    registryVersion++;
    broadcastRegistryUpdate();
    res.end(JSON.stringify({ ok: true, version: registryVersion }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

// ─── WebSocket Server ───

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const peerName = req.headers["x-peer-name"] as string;
  const auth = req.headers.authorization?.replace("Bearer ", "");
  if (auth !== API_KEY) { ws.close(4001, "Unauthorized"); return; }

  wsClients.set(peerName, ws);
  if (peers.has(peerName)) peers.get(peerName)!.online = true;

  // Flush queued messages
  const queued = messageQueue.get(peerName) || [];
  for (const msg of queued.filter((m) => !m.acked)) {
    ws.send(JSON.stringify({ type: "message", from: msg.from, payload: msg.payload }));
    msg.acked = true;
  }

  ws.on("close", () => {
    wsClients.delete(peerName);
    if (peers.has(peerName)) peers.get(peerName)!.online = false;
    registryVersion++;
    broadcastRegistryUpdate();
  });
});

function broadcastRegistryUpdate(): void {
  const payload = JSON.stringify({ type: "registry_update", version: registryVersion });
  for (const [, ws] of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ─── Cleanup intervals ───

// Mark peers offline after 30s
setInterval(() => {
  for (const [name, peer] of peers) {
    if (Date.now() - peer.lastSeen > 30000 && !wsClients.has(name)) {
      peer.online = false;
    }
  }
}, 10000);

// Auto-release locks after 1 hour
setInterval(() => {
  for (const [key, lock] of fileLocks) {
    if (Date.now() - lock.since > 3600000) fileLocks.delete(key);
  }
}, 60000);

// Clean old acked messages
setInterval(() => {
  for (const [peer, queue] of messageQueue) {
    const cleaned = queue.filter((m) => !m.acked || Date.now() - m.timestamp < 300000);
    messageQueue.set(peer, cleaned);
  }
}, 300000);

// ─── Start ───

server.listen(PORT, () => {
  console.log(`Pi Network Relay running on :${PORT}`);
  console.log(`WebSocket: enabled`);
  console.log(`API key: ${API_KEY.slice(0, 8)}...`);
});
