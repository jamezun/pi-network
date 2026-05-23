// Pi Network — Config loading + mode detection

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export type NetworkMode = "tailscale" | "server" | "hybrid" | "local" | "whatsapp";
export type AgentRole = "manager" | "worker";
export type TaskPriority = "urgent" | "high" | "normal" | "low";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "killed" | "reassigned" | "waiting_for_answer";
export type AgentStatus = "online" | "busy" | "unresponsive" | "offline";
export type TaskMode = "agent" | "inbox" | "raw";
export type PeerType = "pi" | "claude";

export interface PeerConfig {
  type: PeerType;
  host?: string;
  bridgePort?: number;
  forceServer?: boolean;
}

export interface ServerConfig {
  url: string;
  apiKey: string;
}

export interface BridgeConfig {
  localName: string;
  bridgePort: number;
  role: AgentRole;
  capabilities: string[];
  specialties: string[];
  manages: string[];
  reportTo: string | null;
  mode?: NetworkMode;
  server?: ServerConfig;
  peers: Record<string, PeerConfig>;
  pollInterval: number;
  retryInterval: number;
  deadLetterHours: number;
  taskTimeout: number;
  maxQueueSize: number;
  maxConcurrentTasks: number;
  heartbeatTimeout: number;
  maxHops: number;             // Max delegation hops (default 5)
  project: string;             // Project namespace for discovery
  damageControl: boolean;      // Enable damage-control rules engine
  color?: string;              // Hex color for this agent in the pool widget
  purpose?: string;            // Short purpose description shown in pool
  explicit?: boolean;          // Hide from auto-discovery if true
  vaultKey?: string;
  userId?: string;
}

const BRIDGE_DIR = ".pi/agent/bridge";
const CONFIG_FILE = "config.json";

export function getBridgeDir(): string {
  return join(homedir(), BRIDGE_DIR);
}

export function getConfigPath(): string {
  return join(getBridgeDir(), CONFIG_FILE);
}

export function loadConfig(): BridgeConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`Pi Network config not found at ${configPath}. Run: mkdir -p ~/.pi/agent/bridge && create config.json`);
  }

  let raw: any;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e: any) {
    throw new Error(`Invalid JSON in ${configPath}: ${e.message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Config must be a JSON object in ${configPath}`);
  }

  // Validate critical fields
  if (raw.localName !== undefined && typeof raw.localName !== "string") {
    throw new Error(`"localName" must be a string`);
  }
  if (raw.localName && !/^[a-zA-Z0-9_-]+$/.test(raw.localName)) {
    throw new Error(`"localName" must contain only alphanumeric, dash, underscore: ${raw.localName}`);
  }
  if (raw.role !== undefined && raw.role !== "manager" && raw.role !== "worker") {
    throw new Error(`"role" must be "manager" or "worker", got: ${raw.role}`);
  }
  if (raw.bridgePort !== undefined && (typeof raw.bridgePort !== "number" || raw.bridgePort < 1 || raw.bridgePort > 65535)) {
    throw new Error(`"bridgePort" must be a number 1-65535`);
  }
  if (raw.mode !== undefined && !["tailscale", "server", "hybrid", "local", "whatsapp"].includes(raw.mode)) {
    throw new Error(`"mode" must be tailscale|server|hybrid|local|whatsapp, got: ${raw.mode}`);
  }
  if (raw.pollInterval !== undefined && typeof raw.pollInterval !== "number") {
    throw new Error(`"pollInterval" must be a number`);
  }
  if (raw.maxHops !== undefined && (typeof raw.maxHops !== "number" || raw.maxHops < 1)) {
    throw new Error(`"maxHops" must be a positive number`);
  }
  if (raw.capabilities !== undefined && !Array.isArray(raw.capabilities)) {
    throw new Error(`"capabilities" must be an array`);
  }
  if (raw.peers !== undefined && (typeof raw.peers !== "object" || Array.isArray(raw.peers))) {
    throw new Error(`"peers" must be an object`);
  }
  if (raw.server !== undefined && (typeof raw.server !== "object" || !raw.server.url)) {
    throw new Error(`"server" must have a "url" field`);
  }
  // Duplicate session name detection warning
  if (raw.peers) {
    const names = Object.values(raw.peers).map((p: any) => p?.type).filter(Boolean);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) {
      console.warn(`⚠️ Duplicate peer types in config: ${[...new Set(dupes)].join(", ")}`);
    }
  }

  const config: BridgeConfig = {
    localName: raw.localName || "unknown",
    bridgePort: raw.bridgePort || 9764,
    role: raw.role || "worker",
    capabilities: raw.capabilities || [],
    specialties: raw.specialties || [],
    manages: raw.manages || [],
    reportTo: raw.reportTo || null,
    mode: raw.mode,
    server: raw.server,
    peers: raw.peers || {},
    pollInterval: raw.pollInterval || 3000,
    retryInterval: raw.retryInterval || 300,
    deadLetterHours: raw.deadLetterHours || 48,
    taskTimeout: raw.taskTimeout || 600,
    maxQueueSize: raw.maxQueueSize || 50,
    maxConcurrentTasks: raw.maxConcurrentTasks || 3,
    heartbeatTimeout: raw.heartbeatTimeout || 600,
    maxHops: raw.maxHops || Number(process.env.PI_NETWORK_MAX_HOPS) || 5,
    project: raw.project || process.env.PI_NETWORK_PROJECT || "default",
    damageControl: raw.damageControl !== false,
    color: raw.color,
    purpose: raw.purpose,
    explicit: raw.explicit || false,
    vaultKey: raw.vaultKey,
    userId: raw.userId,
  };

  return config;
}

export function resolveMode(config: BridgeConfig): NetworkMode {
  if (config.mode) return config.mode;

  const hasTailscale = isTailscaleRunning();
  const hasServer = !!config.server?.url;

  if (hasTailscale && hasServer) return "hybrid";
  if (hasTailscale) return "tailscale";
  if (hasServer) return "server";
  return "local";
}

function isTailscaleRunning(): boolean {
  try {
    execSync("tailscale status --json", {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function getTailnetPeers(): Map<string, { online: boolean; ip: string; lastSeen?: number }> {
  const result = new Map<string, { online: boolean; ip: string; lastSeen?: number }>();
  try {
    const raw = execSync("tailscale status --json", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const status = JSON.parse(raw);
    for (const peer of status.Peers || []) {
      const name = peer.HostName || peer.DNSName?.replace(/\..*/, "") || peer.TailscaleIPs?.[0];
      if (name) {
        result.set(name, {
          online: peer.Online === true,
          ip: peer.TailscaleIPs?.[0] || "unknown",
          lastSeen: peer.LastSeen,
        });
      }
    }
  } catch {
    // Tailscale not available
  }
  return result;
}

export function getPeerUrl(peerName: string, config: BridgeConfig): string {
  const peer = config.peers[peerName];
  if (!peer) throw new Error(`Unknown peer: ${peerName}`);
  const port = peer.bridgePort || config.bridgePort;
  // Tailscale: use MagicDNS name
  return `http://${peerName}:${port}`;
}
