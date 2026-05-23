// Pi Network — WhatsApp security hardening
// Phase 2.6: Rate limiting, allowlist, replay protection, audit logging.

import { appendAudit } from "./audit";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class WhatsAppSecurity {
  private allowedNumbers: Set<string>;
  private rateLimitMap = new Map<string, RateLimitEntry>();
  private maxCommandsPerMinute: number;
  private replayWindowMs: number;
  private seenMessageIds = new Map<string, number>();
  private maxSeenIds = 1000;

  constructor(config: {
    allowedNumbers: string[];
    maxCommandsPerMinute?: number;
    replayWindowMs?: number;
  }) {
    this.allowedNumbers = new Set(config.allowedNumbers.map(n => n.replace("+", "")));
    this.maxCommandsPerMinute = config.maxCommandsPerMinute ?? 10;
    this.replayWindowMs = config.replayWindowMs ?? 5 * 60 * 1000; // 5 min
  }

  /**
   * Check if an incoming WhatsApp message is allowed.
   * Returns { allowed: true } or { allowed: false, reason: string }
   */
  checkMessage(msg: {
    from: string;
    messageId?: string;
    timestamp?: number;
    isForwarded?: boolean;
  }): { allowed: true } | { allowed: false; reason: string } {

    // 1. Number allowlist
    const normalizedFrom = msg.from.replace("+", "").replace("@s.whatsapp.net", "");
    if (!this.isAllowedNumber(normalizedFrom)) {
      appendAudit({ event: "blocked", sender: `wa:${normalizedFrom}`, reason: "number_not_allowed" });
      return { allowed: false, reason: "Number not in allowlist" };
    }

    // 2. Reject forwarded messages
    if (msg.isForwarded) {
      appendAudit({ event: "blocked", sender: `wa:${normalizedFrom}`, reason: "forwarded_message" });
      return { allowed: false, reason: "Forwarded messages are not accepted" };
    }

    // 3. Replay protection (reject messages older than window)
    if (msg.timestamp && Date.now() - msg.timestamp > this.replayWindowMs) {
      appendAudit({ event: "blocked", sender: `wa:${normalizedFrom}`, reason: "replay_expired" });
      return { allowed: false, reason: "Message too old (replay protection)" };
    }

    // 4. Dedup by message ID
    if (msg.messageId) {
      if (this.seenMessageIds.has(msg.messageId)) {
        return { allowed: false, reason: "Duplicate message" };
      }
      this.seenMessageIds.set(msg.messageId, Date.now());
      this.pruneSeenIds();
    }

    // 5. Rate limiting
    if (!this.checkRateLimit(normalizedFrom)) {
      appendAudit({ event: "blocked", sender: `wa:${normalizedFrom}`, reason: "rate_limited" });
      return { allowed: false, reason: `Rate limit exceeded (${this.maxCommandsPerMinute}/min)` };
    }

    return { allowed: true };
  }

  private isAllowedNumber(from: string): boolean {
    for (const allowed of this.allowedNumbers) {
      if (from.includes(allowed)) return true;
    }
    return false;
  }

  private checkRateLimit(from: string): boolean {
    const now = Date.now();
    const entry = this.rateLimitMap.get(from);

    if (!entry || now - entry.windowStart > 60_000) {
      this.rateLimitMap.set(from, { count: 1, windowStart: now });
      return true;
    }

    entry.count++;
    return entry.count <= this.maxCommandsPerMinute;
  }

  private pruneSeenIds(): void {
    if (this.seenMessageIds.size <= this.maxSeenIds) return;
    const cutoff = Date.now() - this.replayWindowMs;
    for (const [id, ts] of this.seenMessageIds) {
      if (ts < cutoff) this.seenMessageIds.delete(id);
    }
  }

  /**
   * Log a WhatsApp command to the audit log.
   */
  logCommand(from: string, command: string, result: string): void {
    appendAudit({
      event: "confirmed" as any,
      sender: `wa:${from}`,
      reason: `${command} → ${result}`,
    });
  }
}
