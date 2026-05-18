// Pi Network — Distributed line-range locking

import type { BridgeConfig } from "./config";

export interface LineRangeLock {
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

const locks: Map<string, LineRangeLock[]> = new Map();

function lockKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

export function rangesOverlap(a: LineRangeLock, b: LineRangeLock): boolean {
  if (a.filePath !== b.filePath) return false;
  if (a.agent === b.agent) return false;
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

export async function checkFileLock(
  filePath: string,
  startLine: number,
  endLine: number,
  agent: string,
  config: BridgeConfig
): Promise<LineRangeLock | null> {
  const key = lockKey(filePath);
  const fileLocks = locks.get(key) || [];

  for (const lock of fileLocks) {
    if (lock.agent === agent) continue;
    if (startLine <= lock.endLine && lock.startLine <= endLine) {
      return lock;
    }
  }

  // Also check remote locks via relay if in server/hybrid mode
  if (config.server?.url) {
    try {
      const resp = await fetch(`${config.server.url}/locks?file=${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${config.server.apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const remoteLocks: LineRangeLock[] = await resp.json();
        for (const lock of remoteLocks) {
          if (lock.agent === agent) continue;
          if (startLine <= lock.endLine && lock.startLine <= endLine) {
            return lock;
          }
        }
      }
    } catch {
      // Relay unreachable, use local locks only
    }
  }

  return null;
}

export function acquireLock(lock: LineRangeLock, config: BridgeConfig): void {
  const key = lockKey(lock.filePath);
  if (!locks.has(key)) locks.set(key, []);
  locks.get(key)!.push(lock);

  // Also push to relay if available
  if (config.server?.url) {
    fetch(`${config.server.url}/lock/acquire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.server.apiKey}`,
      },
      body: JSON.stringify(lock),
    }).catch(() => {});
  }
}

export function releaseLock(filePath: string, taskId: string, config: BridgeConfig): void {
  const key = lockKey(filePath);
  const fileLocks = locks.get(key);
  if (fileLocks) {
    const remaining = fileLocks.filter((l) => l.taskId !== taskId);
    if (remaining.length === 0) {
      locks.delete(key);
    } else {
      locks.set(key, remaining);
    }
  }

  if (config.server?.url) {
    fetch(`${config.server.url}/lock/release`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.server.apiKey}`,
      },
      body: JSON.stringify({ filePath: key, taskId }),
    }).catch(() => {});
  }
}

export function releaseAllForTask(taskId: string, config: BridgeConfig): void {
  for (const [key, fileLocks] of locks) {
    const remaining = fileLocks.filter((l) => l.rootTaskId !== taskId && l.taskId !== taskId);
    if (remaining.length === 0) {
      locks.delete(key);
    } else {
      locks.set(key, remaining);
    }
  }

  if (config.server?.url) {
    fetch(`${config.server.url}/lock/release-task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.server.apiKey}`,
      },
      body: JSON.stringify({ taskId }),
    }).catch(() => {});
  }
}

export function getAllLocks(): Map<string, LineRangeLock[]> {
  return new Map(locks);
}

export function getLocksForFile(filePath: string): LineRangeLock[] {
  return locks.get(lockKey(filePath)) || [];
}

export function shiftLocksAfterEdit(
  filePath: string,
  editStartLine: number,
  linesAdded: number,
  linesDeleted: number
): void {
  const key = lockKey(filePath);
  const fileLocks = locks.get(key);
  if (!fileLocks) return;

  const delta = linesAdded - linesDeleted;
  if (delta === 0) return;

  for (const lock of fileLocks) {
    if (editStartLine <= lock.startLine) {
      lock.startLine += delta;
      lock.endLine += delta;
    } else if (editStartLine <= lock.endLine) {
      lock.endLine += delta;
    }
  }
}
