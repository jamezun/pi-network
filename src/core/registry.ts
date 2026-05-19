// Pi Network — Atomic per-agent registry with PID-based liveness pruning
// Replaces the old single agents-cache.json with per-agent files under
// ~/.pi/agent/bridge/agents/<name>.json + PID validation + stale counter.
// Stolen from coms.ts: writeRegistryAtomic + pruneDeadEntries.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getBridgeDir } from "./config";

export interface AgentEntry {
  name: string;
  role: "manager" | "worker";
  sessionName?: string;
  sessionId?: string;
  capabilities: string[];
  specialties: string[];
  manages: string[];
  reportTo: string | null;
  status: "online" | "busy" | "unresponsive" | "offline";
  lastSeen: number;
  model?: string;
  queueLength?: number;
  maxConcurrentTasks?: number;
  activeTaskCount?: number;
  ipAddress?: string;
  pid?: number;
  contextUsedPct?: number;
  color?: string;
  purpose?: string;
  explicit?: boolean;
  heartbeatAt?: number;
  staleCount?: number;
}

const AGENTS_DIR = "agents";

function getAgentsDir(): string {
  const dir = join(getBridgeDir(), AGENTS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function agentFilePath(name: string): string {
  // Sanitise name to be filesystem-safe
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(getAgentsDir(), `${safe}.json`);
}

/**
 * Atomic write: write to .tmp then rename, so crash mid-write never corrupts.
 */
export function writeRegistryAtomic(entry: AgentEntry): void {
  const filePath = agentFilePath(entry.name);
  const tmpPath = filePath + ".tmp";
  const data = JSON.stringify({ ...entry, lastSeen: Date.now() }, null, 2);
  try {
    writeFileSync(tmpPath, data, "utf8");
    // On most OS, rename is atomic — crash mid-write never corrupts the live file.
    renameSync(tmpPath, filePath);
  } catch {
    // Fallback: direct write (not atomic but better than nothing)
    try { writeFileSync(filePath, data, "utf8"); } catch {}
  }
}

/**
 * Check if a PID is still alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = existence check, doesn't actually send a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prune entries whose PID is dead. Returns list of pruned names.
 */
export function pruneDeadEntries(): string[] {
  const entries = readAllRegistryEntries();
  const pruned: string[] = [];
  for (const entry of entries) {
    if (entry.pid && !isPidAlive(entry.pid)) {
      // PID is dead — remove registry file
      try { unlinkSync(agentFilePath(entry.name)); } catch {}
      pruned.push(entry.name);
    }
  }
  return pruned;
}

/**
 * Increment stale counter for peers that failed ping.
 * After STALE_THRESHOLD consecutive misses, mark as offline.
 */
const STALE_THRESHOLD = 3;

export function markStale(name: string): AgentEntry | null {
  const entry = readRegistryEntry(name);
  if (!entry) return null;
  entry.staleCount = (entry.staleCount || 0) + 1;
  if (entry.staleCount >= STALE_THRESHOLD) {
    entry.status = "offline";
  } else if (entry.staleCount >= 1) {
    entry.status = "unresponsive";
  }
  writeRegistryAtomic(entry);
  return entry;
}

export function markReachable(name: string, card?: Partial<AgentEntry>): AgentEntry | null {
  const entry = readRegistryEntry(name);
  if (!entry) return null;
  entry.staleCount = 0;
  entry.status = "online";
  entry.heartbeatAt = Date.now();
  if (card) Object.assign(entry, card);
  writeRegistryAtomic(entry);
  return entry;
}

/**
 * Read a single agent's registry entry.
 */
export function readRegistryEntry(name: string): AgentEntry | null {
  const filePath = agentFilePath(name);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read all registry entries from the per-agent files.
 */
export function readAllRegistryEntries(): AgentEntry[] {
  const dir = getAgentsDir();
  const entries: AgentEntry[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry: AgentEntry = JSON.parse(readFileSync(join(dir, file), "utf8"));
        entries.push(entry);
      } catch {}
    }
  } catch {}
  return entries;
}

/**
 * Remove a single agent's registry file.
 */
export function removeRegistryEntry(name: string): void {
  const filePath = agentFilePath(name);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch {}
  }
}

// ─── Backwards compat with old API ───

export function loadRegistry(): AgentEntry[] {
  return readAllRegistryEntries();
}

export function updateAgentInRegistry(
  _agents: AgentEntry[], // ignored — we use per-file storage now
  update: Partial<AgentEntry> & { name: string }
): AgentEntry[] {
  const existing = readRegistryEntry(update.name);
  const entry: AgentEntry = {
    role: "worker",
    capabilities: [],
    specialties: [],
    manages: [],
    reportTo: null,
    status: "online",
    lastSeen: Date.now(),
    staleCount: 0,
    ...(existing || {}),
    ...update,
  };
  writeRegistryAtomic(entry);
  return readAllRegistryEntries();
}

export function removeAgentFromRegistry(
  _agents: AgentEntry[],
  name: string
): AgentEntry[] {
  removeRegistryEntry(name);
  return readAllRegistryEntries();
}

export function saveRegistry(_agents: AgentEntry[]): void {
  // No-op: we now write per-agent files atomically in updateAgentInRegistry
  // This function exists for backward compat only.
}
