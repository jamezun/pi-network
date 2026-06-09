// Pi Network — Broker types for local auto-discovery
// Adapted from pi-intercom's types.ts for mesh network use.
//
// Protocol v2 (additive, backward-compatible):
//   - MediaAttachment (reference-based media; no base64 in JSON)
//   - userId / conversationId on BrokerMessage (multi-tenant routing)
//   - modalities on SessionInfo (vision/voice capability)
//   - token on register (JWT auth handshake)
//   - richer delivery receipts (seen / turn_started / turn_complete)
// All new fields are OPTIONAL so v1 callers keep working.

// ─── Improvement #1: Reference-based Media Envelope ────────────────────────
// Binary never travels inline. Inline base64 allowed only <256 KB for tiny
// snippets (backward-compat); real media lives at `url` (object storage).
export interface MediaAttachment {
  id: string;
  kind: "image" | "audio" | "video" | "file";
  mime: string;
  url: string;            // object-storage reference (s3://, r2://, https://...); NEVER large base64
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

// Legacy string-bodied attachment (kept for backward compat — file/snippet/context).
export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;        // small text/base64 only (<256 KB); binary must use MediaAttachment
  language?: string;
}

// Media enrichment populated by the modality layer before dispatch.
export interface MediaEnrichment {
  transcript?: string | null;       // STT result for audio
  imageSummary?: string | null;     // [Image] summary for non-vision models
  voiceReplyUrl?: string | null;    // outbound TTS reply
}

// ─── Improvement #3: Presence Modalities ───────────────────────────────────
export interface SessionModalities {
  vision?: boolean;       // can the driving model ingest images natively?
  voice?: boolean;        // can it handle audio / produce voice replies?
}

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  runtime?: "pi" | "claude" | "unknown";
  role?: string;
  capabilities?: string[];
  specialties?: string[];
  color?: string;
  purpose?: string;
  project?: string;
  localName?: string;
  modalities?: SessionModalities;     // NEW (Improvement #3)
  // ─── Improvement #4: Multi-tenant scoping ──────────────────────────────
  userId?: string;                    // tenant owner; undefined = legacy/single-user
}

export interface BrokerMessage {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  // ─── Improvement #4: Multi-tenant routing ──────────────────────────────
  userId?: string;                    // which user owns this message
  conversationId?: string;            // conversation thread scope
  content: {
    text: string;
    attachments?: Attachment[];       // legacy small attachments
    media?: MediaAttachment[];        // NEW: reference-based media
  };
  media?: MediaEnrichment;            // NEW: populated by modality layer
}

// ─── Improvement #5: JWT auth in register handshake ────────────────────────
// `token` is optional for v1 / trusted Tailscale transports; required when the
// broker is exposed to untrusted (consumer) connections.

export type ClientMessage =
  | { type: "register"; session: Omit<SessionInfo, "id">; token?: string }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: BrokerMessage }
  | { type: "presence"; name?: string; status?: string; model?: string };

// ─── Improvement #6: Richer delivery receipts ──────────────────────────────
export type ServerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: BrokerMessage }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string }
  // NEW (Improvement #6): maps to mobile "delivered" / "typing…" / "online" indicators
  | { type: "seen"; messageId: string }
  | { type: "turn_started"; messageId: string }
  | { type: "turn_complete"; messageId: string };

export interface IntercomContext {
  from: SessionInfo;
  message: BrokerMessage;
  receivedAt: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────
/** Inline base64 over this size MUST use a MediaAttachment url instead. */
export const MAX_INLINE_BASE64_BYTES = 256 * 1024;
