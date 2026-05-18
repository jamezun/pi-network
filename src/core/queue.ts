// Pi Network — Offline message queue

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getBridgeDir } from "./config";
import type { TaskEnvelope } from "./tasks";

const OUTBOX_DIR = "outbox";
const INBOX_DIR = "inbox";
const DEAD_LETTER_DIR = "dead-letter";

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Outbox ───

export function getOutboxDir(): string {
  const dir = join(getBridgeDir(), OUTBOX_DIR);
  ensureDir(dir);
  return dir;
}

export function getOutboxPath(peer: string): string {
  return join(getOutboxDir(), `${peer}.jsonl`);
}

export function pushToOutbox(peer: string, envelope: TaskEnvelope): void {
  const filePath = getOutboxPath(peer);
  const line = JSON.stringify(envelope) + "\n";
  writeFileSync(filePath, line, { flag: "a" });
}

export function readOutbox(peer: string): TaskEnvelope[] {
  const filePath = getOutboxPath(peer);
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function readAllOutbox(): Record<string, TaskEnvelope[]> {
  const dir = getOutboxDir();
  const result: Record<string, TaskEnvelope[]> = {};
  if (!existsSync(dir)) return result;
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".jsonl")) {
      const peer = file.replace(".jsonl", "");
      result[peer] = readOutbox(peer);
    }
  }
  return result;
}

export function removeFromOutbox(peer: string, taskId: string): void {
  const tasks = readOutbox(peer).filter((t) => t.taskId !== taskId);
  const filePath = getOutboxPath(peer);
  if (tasks.length === 0) {
    if (existsSync(filePath)) unlinkSync(filePath);
  } else {
    writeFileSync(filePath, tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  }
}

export function clearOutbox(peer: string): void {
  const filePath = getOutboxPath(peer);
  if (existsSync(filePath)) unlinkSync(filePath);
}

// ─── Inbox ───

export function getInboxDir(): string {
  const dir = join(getBridgeDir(), INBOX_DIR);
  ensureDir(dir);
  return dir;
}

export function getInboxPath(from: string): string {
  return join(getInboxDir(), `${from}.jsonl`);
}

export function pushToInbox(from: string, message: any): void {
  const filePath = getInboxPath(from);
  const line = JSON.stringify({ ...message, receivedAt: Date.now() }) + "\n";
  writeFileSync(filePath, line, { flag: "a" });
}

export function readInbox(from: string): any[] {
  const filePath = getInboxPath(from);
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// ─── Dead Letter ───

export function getDeadLetterDir(): string {
  const dir = join(getBridgeDir(), DEAD_LETTER_DIR);
  ensureDir(dir);
  return dir;
}

export function moveToDeadLetter(peer: string, envelope: TaskEnvelope): void {
  const dir = getDeadLetterDir();
  const filePath = join(dir, `${peer}-${envelope.taskId}.json`);
  writeFileSync(filePath, JSON.stringify(envelope, null, 2));
  removeFromOutbox(peer, envelope.taskId);
}
