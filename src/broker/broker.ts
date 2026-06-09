// Pi Network — Standalone broker process for local session auto-discovery
// Unix socket (or Windows named pipe) server that tracks connected sessions,
// routes messages, and auto-shuts down when empty for 5 seconds.
// Ported from pi-intercom's broker.ts with mesh-specific extensions.

import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing";
import { getBrokerSocketPath, getBrokerPidPath, getBrokerDir } from "./paths";
import type { SessionInfo, BrokerMessage, Attachment, ServerMessage, MediaAttachment } from "./types";
import { MAX_INLINE_BASE64_BYTES } from "./types";
import { RoutingTable, SYSTEM_TENANT } from "../core/routing";
import { authorizeRegister, AuthError, RateLimiter, type AuthConfig, type TokenClaims } from "../core/auth";
import { DedupeCache } from "../core/dedupe";

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  if (a.type !== "file" && a.type !== "snippet" && a.type !== "context") return false;
  if (typeof a.name !== "string" || typeof a.content !== "string") return false;
  return a.language === undefined || typeof a.language === "string";
}

function isMediaAttachment(value: unknown): value is MediaAttachment {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (!["image", "audio", "video", "file"].includes(m.kind as string)) return false;
  if (typeof m.url !== "string" || typeof m.bytes !== "number" || typeof m.mime !== "string") return false;
  return true;
}

// Reject oversized inline base64 (Improvement #1: no large binary in JSON).
function attachmentsWithinLimits(message: BrokerMessage): boolean {
  for (const a of message.content.attachments ?? []) {
    if (a.content.length > MAX_INLINE_BASE64_BYTES) return false;
  }
  return true;
}

function isBrokerMessage(value: unknown): value is BrokerMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.timestamp !== "number") return false;
  if (m.replyTo !== undefined && typeof m.replyTo !== "string") return false;
  if (m.expectsReply !== undefined && typeof m.expectsReply !== "boolean") return false;
  if (m.userId !== undefined && typeof m.userId !== "string") return false;
  if (m.conversationId !== undefined && typeof m.conversationId !== "string") return false;
  if (typeof m.content !== "object" || m.content === null) return false;
  const c = m.content as Record<string, unknown>;
  if (typeof c.text !== "string") return false;
  if (c.attachments !== undefined && (!Array.isArray(c.attachments) || !c.attachments.every(isAttachment))) return false;
  // media: reference-based (no inline binary), validate loosely
  if (c.media !== undefined && !Array.isArray(c.media)) return false;
  return true;
}

const BROKER_DIR = getBrokerDir();
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = getBrokerPidPath();

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return typeof s.cwd === "string" && typeof s.model === "string" &&
    typeof s.pid === "number" && typeof s.startedAt === "number" &&
    typeof s.lastActivity === "number";
}

class NetworkBroker {
  private sessions = new Map<string, ConnectedSession>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  // Improvement #4: user-scoped routing
  private routing = new RoutingTable();
  // Improvement #5: auth + rate limiting (disabled by default for Tailscale trust)
  private authConfig: AuthConfig | null = null;
  private rateLimiter = new RateLimiter();
  private sessionClaims = new Map<string, TokenClaims | null>();
  // Improvement #7: inbound dedupe (generalized WhatsApp replay protection)
  private dedupe = new DedupeCache({ ttlMs: 5 * 60 * 1000 });
  private gcInterval: NodeJS.Timeout | null = null;

  constructor() {
    mkdirSync(BROKER_DIR, { recursive: true });
    if (process.platform !== "win32") {
      try { unlinkSync(SOCKET_PATH); } catch { /* clean startup */ }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Pi Network broker started (pid: ${process.pid})`);
    });
    // Improvement #5: opt into auth via env (consumer mode). Default off → Tailscale trust.
    const requireAuth = process.env.PI_NETWORK_REQUIRE_AUTH === "1" || process.env.PI_NETWORK_REQUIRE_AUTH === "true";
    const secret = process.env.PI_NETWORK_AUTH_SECRET;
    this.authConfig = requireAuth && secret ? { secret, requireAuth: true } : { secret: secret || "disabled", requireAuth: false };
    // Improvement #7: periodic dedupe GC
    this.gcInterval = setInterval(() => this.dedupe.gc(), 5 * 60 * 1000);
    if ((this.gcInterval as any).unref) (this.gcInterval as any).unref();
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    // Enable TCP keepalive so dead connections (crashes, network drops) are detected faster
    socket.setKeepAlive(true, 15_000);

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => { sessionId = id; });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);
    socket.on("close", () => {
      if (sessionId) {
        const leaving = this.sessions.get(sessionId);
        this.sessions.delete(sessionId);
        this.sessionClaims.delete(sessionId);
        this.routing.releaseSession(sessionId);
        this.broadcastScoped({ type: "session_left", sessionId }, sessionId, leaving?.info.userId);
        this.scheduleShutdownCheck();
      }
    });
    socket.on("error", () => {});
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down broker");
        this.shutdown();
      }
    }, 5000);
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
    const clientMsg = msg as { type: string } & Record<string, unknown>;

    if (currentId === null && clientMsg.type !== "register") return;

    switch (clientMsg.type) {
      case "register": {
        if (!isSessionRegistration(clientMsg.session)) return;
        if (currentId) return; // duplicate
        // Improvement #5: JWT auth gate
        let claims: TokenClaims | null = null;
        if (this.authConfig) {
          try {
            claims = authorizeRegister(typeof clientMsg.token === "string" ? clientMsg.token : undefined, this.authConfig);
          } catch (e) {
            const reason = e instanceof AuthError ? e.message : "Auth failed";
            writeMessage(socket, { type: "error", error: `Auth: ${reason}` });
            socket.end();
            return;
          }
        }
        const id = randomUUID();
        setId(id);
        const info: SessionInfo = { ...clientMsg.session, id, userId: claims?.userId ?? clientMsg.session.userId };
        this.sessions.set(id, { socket, info });
        this.sessionClaims.set(id, claims);
        // Improvement #4: bind session to user namespace
        if (info.userId) this.routing.bindSession(info.userId, id);
        if (this.shutdownTimer) { clearTimeout(this.shutdownTimer); this.shutdownTimer = null; }
        writeMessage(socket, { type: "registered", sessionId: id });
        // Only broadcast to sessions in the same tenant
        this.broadcastScoped({ type: "session_joined", session: info }, id, info.userId);
        break;
      }

      case "unregister": {
        if (currentId) {
          this.sessions.delete(currentId);
          this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
          setId(null);
          this.scheduleShutdownCheck();
        }
        break;
      }

      case "list": {
        if (typeof clientMsg.requestId !== "string") return;
        const all = Array.from(this.sessions.values()).map(s => s.info);
        const senderClaims = currentId ? this.sessionClaims.get(currentId) : null;
        const tenant = senderClaims?.userId;
        // Improvement #4: filter to the caller's tenant (system tenant sees all)
        const visible = tenant ? this.routing.visibleSessions(tenant, all) : all;
        writeMessage(socket, { type: "sessions", requestId: clientMsg.requestId, sessions: visible });
        break;
      }

      case "send": {
        if (currentId === null) return;
        const message = clientMsg.message;
        if (typeof clientMsg.to !== "string" || !isBrokerMessage(message)) {
          let failId = "unknown";
          if (message && typeof message === "object" && typeof (message as { id?: unknown }).id === "string") {
            failId = (message as { id: string }).id;
          }
          writeMessage(socket, { type: "delivery_failed", messageId: failId, reason: "Invalid message" });
          break;
        }
        // Improvement #1: reject oversized inline base64
        if (!attachmentsWithinLimits(message)) {
          writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: `Attachment exceeds ${MAX_INLINE_BASE64_BYTES}B inline limit — use a media reference` });
          break;
        }
        // Improvement #5: rate limiting (only when claims present)
        const sendClaims = currentId ? this.sessionClaims.get(currentId) : null;
        if (sendClaims && !this.rateLimiter.check(sendClaims.userId, sendClaims.rateLimitPerMin)) {
          writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: "Rate limit exceeded" });
          break;
        }
        // Improvement #7: idempotent inbound (drop replays within TTL)
        const tenant = sendClaims?.userId ?? message.userId;
        if (!this.dedupe.seen(tenant, message.id)) {
          writeMessage(socket, { type: "delivered", messageId: message.id }); // already-seen → ack silently
          break;
        }
        const targets = this.findSessions(clientMsg.to);
        if (targets.length === 1) {
          const fromSession = this.sessions.get(currentId);
          if (!fromSession) {
            writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: "Sender not found" });
            break;
          }
          // Improvement #4: cross-tenant isolation — block routing outside the tenant
          if (!this.routing.canRoute(tenant, targets[0].info.id) && tenant !== SYSTEM_TENANT && targets[0].info.userId !== tenant) {
            writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: "Not allowed: target outside your tenant" });
            break;
          }
          writeMessage(targets[0].socket, { type: "message", from: fromSession.info, message });
          writeMessage(socket, { type: "delivered", messageId: message.id });
          // Improvement #6: richer receipts (best-effort; target may or may not emit them)
          writeMessage(socket, { type: "seen", messageId: message.id });
        } else if (targets.length > 1) {
          writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: `Multiple sessions named "${clientMsg.to}"` });
        } else {
          writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: "Session not found" });
        }
        break;
      }

      case "presence": {
        if (currentId === null) return;
        const session = this.sessions.get(currentId);
        if (session) {
          if (typeof clientMsg.name === "string") session.info.name = clientMsg.name;
          if (typeof clientMsg.status === "string") session.info.status = clientMsg.status;
          if (typeof clientMsg.model === "string") session.info.model = clientMsg.model;
          session.info.lastActivity = Date.now();
          this.broadcast({ type: "presence_update", session: session.info }, currentId);
        }
        break;
      }
    }
  }

  private findSessions(nameOrId: string): ConnectedSession[] {
    const byId = this.sessions.get(nameOrId);
    if (byId) return [byId];
    const lower = nameOrId.toLowerCase();
    return Array.from(this.sessions.values()).filter(s => s.info.name?.toLowerCase() === lower);
  }

  private broadcast(msg: ServerMessage, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) writeMessage(session.socket, msg);
    }
  }

  /** Improvement #4: broadcast only within a tenant (system tenant = broadcast to all). */
  private broadcastScoped(msg: ServerMessage, exclude: string, tenant: string | undefined): void {
    if (!tenant || tenant === SYSTEM_TENANT) { this.broadcast(msg, exclude); return; }
    for (const [id, session] of this.sessions) {
      if (id === exclude) continue;
      if (session.info.userId === tenant || this.routing.ownerOf(id) === tenant) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private shutdown(): void {
    if (this.gcInterval) clearInterval(this.gcInterval);
    for (const session of this.sessions.values()) session.socket.end();
    this.sessions.clear();
    if (process.platform !== "win32") {
      try { unlinkSync(SOCKET_PATH); } catch {}
    }
    try { unlinkSync(PID_PATH); } catch {}
    this.server.close();
    process.exit(0);
  }
}

new NetworkBroker().start();
