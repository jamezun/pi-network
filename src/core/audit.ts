// Pi Network — Audit log (privacy-respecting)
// Stolen from coms.ts: appendEntry with msg_id + sender + hops only — never prompt bodies.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getBridgeDir } from "./config";

export interface AuditEntry {
  event: "outbound_prompt" | "inbound_prompt" | "response" | "blocked" | "confirmed" | "hop_exceeded" | "self_heal" | "orphan_response";
  msg_id?: string;
  taskId?: string;
  sender?: string;
  target?: string;
  hops?: number;
  reason?: string;
  timestamp: number;
}

const AUDIT_FILE = "audit-log.jsonl";

function getAuditPath(): string {
  const dir = getBridgeDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, AUDIT_FILE);
}

/**
 * Append an audit entry. Only metadata — never task text or secrets.
 */
export function appendAudit(entry: Omit<AuditEntry, "timestamp">): void {
  const path = getAuditPath();
  const line = JSON.stringify({ ...entry, timestamp: Date.now() }) + "\n";
  writeFileSync(path, line, { flag: "a" });
}

/**
 * Read audit log with optional filters.
 */
export function readAudit(filters?: {
  event?: AuditEntry["event"];
  sender?: string;
  target?: string;
  limit?: number;
}): AuditEntry[] {
  const path = getAuditPath();
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf8");
  let entries: AuditEntry[] = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  if (filters?.event) entries = entries.filter((e) => e.event === filters.event);
  if (filters?.sender) entries = entries.filter((e) => e.sender === filters.sender);
  if (filters?.target) entries = entries.filter((e) => e.target === filters.target);

  entries.reverse();
  if (filters?.limit) entries = entries.slice(0, filters.limit);

  return entries;
}

/**
 * Format audit entries for display.
 */
export function formatAudit(entries: AuditEntry[]): string {
  if (entries.length === 0) return "No audit entries found.";

  const lines: string[] = ["📋 Audit Log\n"];
  for (const e of entries) {
    const icon = e.event === "blocked" ? "🛡️" : e.event === "hop_exceeded" ? "🔄" : "📋";
    const ago = timeAgo(e.timestamp);
    lines.push(
      `  ${icon} ${e.event.padEnd(20)} ` +
      (e.msg_id ? `${e.msg_id.slice(0, 12)}  ` : "") +
      (e.sender ? `${e.sender}→` : "") +
      (e.target ? `${e.target}  ` : "") +
      (e.hops != null ? `hops=${e.hops}  ` : "") +
      (e.reason ? `(${e.reason})  ` : "") +
      ago
    );
  }
  return lines.join("\n");
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}
