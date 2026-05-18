// Pi Network — Agent registry management

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getBridgeDir } from "./config";

export interface AgentEntry {
  name: string;
  role: "manager" | "worker";
  sessionName?: string;
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
}

const REGISTRY_FILE = "agents-cache.json";

export function getRegistryPath(): string {
  return join(getBridgeDir(), REGISTRY_FILE);
}

export function loadRegistry(): AgentEntry[] {
  const path = getRegistryPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export function saveRegistry(agents: AgentEntry[]): void {
  writeFileSync(getRegistryPath(), JSON.stringify(agents, null, 2));
}

export function updateAgentInRegistry(
  agents: AgentEntry[],
  update: Partial<AgentEntry> & { name: string }
): AgentEntry[] {
  const idx = agents.findIndex((a) => a.name === update.name);
  if (idx >= 0) {
    agents[idx] = { ...agents[idx], ...update, lastSeen: Date.now() };
  } else {
    agents.push({
      role: "worker",
      capabilities: [],
      specialties: [],
      manages: [],
      reportTo: null,
      status: "online",
      lastSeen: Date.now(),
      ...update,
    });
  }
  saveRegistry(agents);
  return agents;
}

export function removeAgentFromRegistry(agents: AgentEntry[], name: string): AgentEntry[] {
  const filtered = agents.filter((a) => a.name !== name);
  saveRegistry(filtered);
  return filtered;
}
