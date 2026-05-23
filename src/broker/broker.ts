// Pi Network — Standalone broker process for local session auto-discovery
// Unix socket (or Windows named pipe) server that tracks connected sessions,
// routes messages, and auto-shuts down when empty for 5 seconds.
// Ported from pi-intercom's broker.ts with mesh-specific extensions.

import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import { getBrokerSocketPath, getBrokerPidPath, getBrokerDir } from "./paths.js";
import type { SessionInfo, BrokerMessage, ServerMessage } from "./types.js";

const BROKER_DIR = getBrokerDir();
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = getBrokerPidPath();

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

function isBrokerMessage(value: unknown): value is BrokerMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.timestamp !== "number") return false;
  if (typeof m.content !== "object" || m.content === null) return false;
  const c = m.content as Record<string, unknown>;
  if (typeof c.text !== "string") return false;
  return true;
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
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => { sessionId = id; });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);
    socket.on("close", () => {
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.broadcast({ type: "session_left", sessionId }, sessionId);
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
        const id = randomUUID();
        setId(id);
        const info: SessionInfo = { ...clientMsg.session, id };
        this.sessions.set(id, { socket, info });
        if (this.shutdownTimer) { clearTimeout(this.shutdownTimer); this.shutdownTimer = null; }
        writeMessage(socket, { type: "registered", sessionId: id });
        this.broadcast({ type: "session_joined", session: info }, id);
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
        const sessions = Array.from(this.sessions.values()).map(s => s.info);
        writeMessage(socket, { type: "sessions", requestId: clientMsg.requestId, sessions });
        break;
      }

      case "send": {
        const message = clientMsg.message;
        if (typeof clientMsg.to !== "string" || !isBrokerMessage(message)) {
          writeMessage(socket, { type: "delivery_failed", messageId: message?.id ?? "unknown", reason: "Invalid message" });
          break;
        }
        const targets = this.findSessions(clientMsg.to);
        if (targets.length === 1) {
          const fromSession = this.sessions.get(currentId);
          if (!fromSession) {
            writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: "Sender not found" });
            break;
          }
          writeMessage(targets[0].socket, { type: "message", from: fromSession.info, message });
          writeMessage(socket, { type: "delivered", messageId: message.id });
        } else if (targets.length > 1) {
          writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: `Multiple sessions named "${clientMsg.to}"` });
        } else {
          writeMessage(socket, { type: "delivery_failed", messageId: message.id, reason: "Session not found" });
        }
        break;
      }

      case "presence": {
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

  private shutdown(): void {
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
