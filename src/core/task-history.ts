// Pi Network — Task history / audit log

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getBridgeDir } from "./config";
import type { TaskStatus, TaskPriority } from "./config";

export interface TaskHistoryEntry {
  taskId: string;
  rootTaskId: string;
  direction: "sent" | "received";
  peer: string;
  task: string;
  status: TaskStatus;
  priority: TaskPriority;
  timestamp: number;
  completedAt?: number;
  resultSummary?: string;
  chainSummary?: string;
  userId?: string;
}

const HISTORY_FILE = "task-history.jsonl";

function getHistoryPath(): string {
  const dir = getBridgeDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, HISTORY_FILE);
}

export function appendHistory(entry: TaskHistoryEntry): void {
  const path = getHistoryPath();
  const line = JSON.stringify(entry) + "\n";
  writeFileSync(path, line, { flag: "a" });
}

export function readHistory(filters?: {
  status?: TaskStatus;
  peer?: string;
  taskId?: string;
  direction?: "sent" | "received";
  limit?: number;
}): TaskHistoryEntry[] {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf8");
  let entries: TaskHistoryEntry[] = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  if (filters?.status) entries = entries.filter((e) => e.status === filters.status);
  if (filters?.peer) entries = entries.filter((e) => e.peer === filters.peer);
  if (filters?.taskId) entries = entries.filter((e) => e.taskId === filters.taskId || e.rootTaskId === filters.taskId);
  if (filters?.direction) entries = entries.filter((e) => e.direction === filters.direction);

  // Most recent first
  entries.reverse();
  if (filters?.limit) entries = entries.slice(0, filters.limit);

  return entries;
}

export function updateHistoryStatus(taskId: string, status: TaskStatus, resultSummary?: string): void {
  const path = getHistoryPath();
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim());

  const updated = lines.map((line) => {
    const entry = JSON.parse(line);
    if (entry.taskId === taskId) {
      entry.status = status;
      if (resultSummary) entry.resultSummary = resultSummary;
      if (status === "completed" || status === "failed" || status === "killed") {
        entry.completedAt = Date.now();
      }
    }
    return JSON.stringify(entry);
  });

  writeFileSync(path, updated.join("\n") + "\n");
}

export function formatHistory(entries: TaskHistoryEntry[]): string {
  if (entries.length === 0) return "No tasks found.";

  const sent = entries.filter((e) => e.direction === "sent");
  const received = entries.filter((e) => e.direction === "received");

  let output = "📋 Task History\n\n";

  if (sent.length > 0) {
    output += "📤 Sent:\n";
    for (const e of sent) {
      const icon = statusIcon(e.status);
      const ago = timeAgo(e.timestamp);
      output += `  ${icon} ${e.taskId.slice(0, 12)}  → ${e.peer.padEnd(10)} ${e.status.padEnd(12)} "${e.task.slice(0, 40)}${e.task.length > 40 ? "..." : ""}"  ${ago}\n`;
    }
    output += "\n";
  }

  if (received.length > 0) {
    output += "📥 Received:\n";
    for (const e of received) {
      const icon = statusIcon(e.status);
      const ago = timeAgo(e.timestamp);
      output += `  ${icon} ${e.taskId.slice(0, 12)}  ← ${e.peer.padEnd(10)} ${e.status.padEnd(12)} "${e.task.slice(0, 40)}${e.task.length > 40 ? "..." : ""}"  ${ago}\n`;
    }
  }

  return output;
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "queued": return "⏳";
    case "running": return "🔄";
    case "completed": return "✅";
    case "failed": return "❌";
    case "killed": return "💀";
    case "reassigned": return "↩️";
    case "waiting_for_answer": return "💬";
    default: return "❓";
  }
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
