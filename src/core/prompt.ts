// Pi Network — System prompt builder

import type { AgentEntry } from "./registry";
import type { BridgeConfig, NetworkMode, AgentStatus } from "./config";
import type { ConcurrencyManager } from "./concurrency";

export function buildAgentPrompt(
  agents: AgentEntry[],
  config: BridgeConfig,
  mode: NetworkMode,
  concurrency: ConcurrencyManager,
  localStatus: AgentStatus,
  tailnetPeers?: Map<string, { online: boolean; ip: string }>
): string {
  if (agents.length === 0 && Object.keys(config.peers).length <= 1) return "";

  const myName = config.localName;
  const otherAgents = agents.filter((a) => a.name !== myName);

  let prompt = `## 🌐 Agent Network (${mode.toUpperCase()} mode)\n\n`;

  // Mode explanation
  switch (mode) {
    case "tailscale":
      prompt += "Connected via Tailscale VPN. Direct peer-to-peer.\n\n";
      break;
    case "server":
      prompt += `Connected via relay server. Messages routed through relay.\n\n`;
      break;
    case "hybrid":
      prompt += "Connected via Tailscale (preferred) + relay server (fallback).\n\n";
      break;
    case "local":
      prompt += "Local network only. Direct LAN connections.\n\n";
      break;
  }

  // Categorize agents
  const online: AgentEntry[] = [];
  const busy: AgentEntry[] = [];
  const unresponsive: AgentEntry[] = [];
  const offline: AgentEntry[] = [];

  for (const agent of otherAgents) {
    // Determine real status from tailnet if available
    let status = agent.status;
    if (tailnetPeers) {
      const ts = tailnetPeers.get(agent.name);
      if (ts && !ts.online) status = "offline";
      else if (ts && ts.online) status = agent.activeTaskCount ? "busy" : "online";
    }

    switch (status) {
      case "online": online.push(agent); break;
      case "busy": busy.push(agent); break;
      case "unresponsive": unresponsive.push(agent); break;
      default: offline.push(agent); break;
    }
  }

  if (online.length > 0) {
    prompt += "### 🟢 Online (idle)\n";
    for (const a of online) {
      const icon = a.role === "manager" ? "⭐" : "👤";
      prompt += `- ${icon} **${a.name}** (${a.role}) — ${a.capabilities.join(", ")} | ${a.specialties.join(", ")}\n`;
    }
    prompt += "\n";
  }

  if (busy.length > 0) {
    prompt += "### 🟡 Online (busy)\n";
    for (const a of busy) {
      const slots = a.maxConcurrentTasks || 3;
      const active = a.activeTaskCount || 0;
      const queued = a.queueLength || 0;
      prompt += `- 👤 **${a.name}** (${a.role}) — ${active}/${slots} slots used${queued > 0 ? `, ${queued} queued` : ""} | ${a.capabilities.join(", ")}\n`;
    }
    prompt += "\n";
  }

  if (unresponsive.length > 0) {
    prompt += "### 🟠 Unresponsive\n";
    for (const a of unresponsive) {
      prompt += `- ⚠️ **${a.name}** (${a.role}) — no activity | ${a.capabilities.join(", ")}\n`;
    }
    prompt += "\n";
  }

  if (offline.length > 0) {
    prompt += "### 🔴 Offline (tasks will be queued)\n";
    for (const a of offline) {
      prompt += `- ~~**${a.name}**~~ (${a.role})\n`;
    }
    prompt += "\n";
  }

  // Local status
  const localSlots = concurrency.getAvailableSlots();
  const localRunning = concurrency.getRunningCount();
  const localQueued = concurrency.getQueueLength();
  prompt += `**Local:** ${localStatus === "busy" ? "🟡" : "🟢"} ${localRunning}/${config.maxConcurrentTasks} slots used${localQueued > 0 ? `, ${localQueued} queued` : ""}\n\n`;

  // Delegation guidelines
  prompt += "### Delegation\n";
  prompt += "- Use `remote_task` to delegate to any agent by name\n";
  prompt += "- Match task to agent specialties for best results\n";
  prompt += "- Use `peer_status` for detailed status\n";
  prompt += "- Use `list_locks` to check file conflicts\n";
  prompt += "- Use `task_history` to track all tasks\n";
  if (config.role === "manager") {
    prompt += "- You are a **manager**. Delegate to workers and consolidate results.\n";
    prompt += "- If a worker returns a task (`return_task`), reassign to a better-suited worker or handle yourself.\n";
  }

  return prompt;
}
