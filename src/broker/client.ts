// Pi Network — Broker client for connecting to the local auto-discovery broker
// Ported from pi-intercom's client.ts with mesh-specific extensions.

import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing";
import { getBrokerSocketPath } from "./paths";
import type { SessionInfo, BrokerMessage, Attachment, MediaAttachment } from "./types";

const BROKER_SOCKET = getBrokerSocketPath();

interface SendOptions {
  text: string;
  attachments?: Attachment[];
  media?: MediaAttachment[];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
  userId?: string;
  conversationId?: string;
}

interface SendResult {
  id: string;
  delivered: boolean;
  reason?: string;
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s.id === "string" && typeof s.cwd === "string" &&
    typeof s.model === "string" && typeof s.pid === "number";
}

function isBrokerMessage(value: unknown): value is BrokerMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.timestamp !== "number") return false;
  if (typeof m.content !== "object" || m.content === null) return false;
  const c = m.content as Record<string, unknown>;
  return typeof c.text === "string";
}

export class BrokerClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private pendingSends = new Map<string, { resolve: (r: SendResult) => void; reject: (e: Error) => void }>();
  private pendingLists = new Map<string, { resolve: (s: SessionInfo[]) => void; reject: (e: Error) => void }>();
  private disconnecting = false;
  private disconnectError: Error | null = null;

  private failPending(error: Error): void {
    for (const p of this.pendingSends.values()) p.reject(error);
    this.pendingSends.clear();
    for (const p of this.pendingLists.values()) p.reject(error);
    this.pendingLists.clear();
  }

  get sessionId(): string | null { return this._sessionId; }

  isConnected(): boolean {
    const s = this.socket;
    return Boolean(s && this._sessionId && !this.disconnecting && !s.destroyed && s.writable);
  }

  connect(session: Omit<SessionInfo, "id">, token?: string): Promise<void> {
    if (this.socket) return Promise.reject(new Error("Already connected"));

    return new Promise((resolve, reject) => {
      const socket = net.connect(BROKER_SOCKET);
      this.socket = socket;
      let settled = false;

      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanup();
          socket.destroy();
          if (this.socket === socket) this.socket = null;
          reject(new Error("Connection timeout"));
        }
      }, 10000);

      let connected = false;

      const onRegistered = () => {
        settled = true; connected = true; cleanup(); resolve();
      };

      const onError = (err: Error) => {
        settled = true; cleanup();
        if (this.socket === socket) this.socket = null;
        socket.destroy(); reject(err);
      };

      const onClose = () => {
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanup();
        this.failPending(disconnectError);
        this._sessionId = null;
        if (this.socket === socket) this.socket = null;
        this.disconnectError = null;
        if (!settled) reject(new Error("Connection closed before registration"));
        if (connected) this.emit("disconnected", disconnectError);
      };

      const onReaderError = (error: Error) => {
        if (!connected) { onError(error); return; }
        this.emit("error", error);
        socket.destroy();
      };

      const reader = createMessageReader((msg) => this.handleBrokerMessage(msg), onReaderError);

      const cleanup = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        socket.off("close", onClose);
        // NOTE: do NOT remove reader — it's needed for ongoing message handling
        clearTimeout(timeout);
      };

      socket.on("data", reader);
      socket.on("error", (err: Error) => { if (connected) { this.disconnectError = err; this.emit("error", err); } });
      socket.on("close", onClose);
      this.once("_registered", onRegistered);

      try {
        writeMessage(socket, token ? { type: "register", session, token } : { type: "register", session });
      } catch (error) {
        cleanup();
        if (this.socket === socket) this.socket = null;
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleBrokerMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
    const m = msg as { type: string } & Record<string, unknown>;

    switch (m.type) {
      case "registered": {
        if (typeof m.sessionId !== "string") return;
        this._sessionId = m.sessionId;
        this.emit("_registered", { type: "registered", sessionId: m.sessionId });
        break;
      }

      case "sessions": {
        const { requestId, sessions } = m;
        if (typeof requestId !== "string" || !Array.isArray(sessions)) return;
        const pending = this.pendingLists.get(requestId);
        if (pending) { this.pendingLists.delete(requestId); pending.resolve(sessions as SessionInfo[]); }
        break;
      }

      case "message": {
        const { from, message } = m;
        if (isSessionInfo(from) && isBrokerMessage(message)) this.emit("message", from, message);
        break;
      }

      case "delivered": {
        if (typeof m.messageId !== "string") return;
        const pending = this.pendingSends.get(m.messageId);
        if (pending) { this.pendingSends.delete(m.messageId); pending.resolve({ id: m.messageId, delivered: true }); }
        break;
      }

      case "delivery_failed": {
        if (typeof m.messageId !== "string" || typeof m.reason !== "string") return;
        const pending = this.pendingSends.get(m.messageId);
        if (pending) { this.pendingSends.delete(m.messageId); pending.resolve({ id: m.messageId, delivered: false, reason: m.reason }); }
        break;
      }

      case "session_joined": {
        if (isSessionInfo(m.session)) this.emit("session_joined", m.session);
        break;
      }

      case "session_left": {
        if (typeof m.sessionId === "string") this.emit("session_left", m.sessionId);
        break;
      }

      case "presence_update": {
        if (isSessionInfo(m.session)) this.emit("presence_update", m.session);
        break;
      }

      // Improvement #6: richer delivery receipts
      case "seen": {
        if (typeof m.messageId === "string") this.emit("seen", m.messageId);
        break;
      }
      case "turn_started": {
        if (typeof m.messageId === "string") this.emit("turn_started", m.messageId);
        break;
      }
      case "turn_complete": {
        if (typeof m.messageId === "string") this.emit("turn_complete", m.messageId);
        break;
      }
    }
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.disconnecting = true;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => socket.destroy(), 2000);
      socket.once("close", () => { clearTimeout(timeout); resolve(); });
      try { writeMessage(socket, { type: "unregister" }); socket.end(); }
      catch { socket.destroy(); }
    });

    this.socket = null;
    this._sessionId = null;
    this.disconnecting = false;
  }

  listSessions(): Promise<SessionInfo[]> {
    if (!this.socket || !this._sessionId) return Promise.reject(new Error("Not connected"));
    const socket = this.socket;

    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timeout = setTimeout(() => {
        this.pendingLists.delete(requestId);
        reject(new Error("List sessions timeout"));
      }, 5000);

      this.pendingLists.set(requestId, { resolve: (s) => { clearTimeout(timeout); resolve(s); }, reject: (e) => { clearTimeout(timeout); reject(e); } });
      try { writeMessage(socket, { type: "list", requestId }); }
      catch (e) { clearTimeout(timeout); this.pendingLists.delete(requestId); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  send(to: string, options: SendOptions): Promise<SendResult> {
    if (!this.socket || !this._sessionId) return Promise.reject(new Error("Not connected"));
    const socket = this.socket;
    const messageId = options.messageId ?? randomUUID();

    const message: BrokerMessage = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      userId: options.userId,
      conversationId: options.conversationId,
      content: { text: options.text, attachments: options.attachments, media: options.media },
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(messageId);
        reject(new Error("Send timeout"));
      }, 10000);

      this.pendingSends.set(messageId, { resolve: (r) => { clearTimeout(timeout); resolve(r); }, reject: (e) => { clearTimeout(timeout); reject(e); } });
      try { writeMessage(socket, { type: "send", to, message }); }
      catch (e) { clearTimeout(timeout); this.pendingSends.delete(messageId); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  updatePresence(updates: { name?: string; status?: string; model?: string }): void {
    if (this.disconnecting || !this.socket || !this._sessionId) return;
    if (this.socket.destroyed || !this.socket.writable) return;
    try { writeMessage(this.socket, { type: "presence", ...updates }); } catch {}
  }
}
