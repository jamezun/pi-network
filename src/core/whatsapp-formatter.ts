// Pi Network — WhatsApp message formatter
// Phase 2.5: Format results, status, and history for WhatsApp display.

import type { AgentEntry } from "./registry";
import type { TaskResult } from "./tasks";

export function formatTaskResult(result: TaskResult): string {
  const icon = result.status === "completed" ? "✅" : result.status === "failed" ? "❌" : "📬";
  const preview = result.result.length > 800 ? result.result.slice(0, 800) + "…" : result.result;
  return `${icon} *Result from ${result.from}*\n\n${preview}\n\n_${new Date().toISOString()}_`;
}

export function formatNetworkStatus(peers: AgentEntry[], localName: string): string {
  const lines: string[] = ["🌐 *Pi Network Status*\n"];

  for (const peer of peers) {
    const statusIcon = peer.status === "online" ? "🟢" :
      peer.status === "busy" ? "🟡" :
        peer.status === "unresponsive" ? "🟠" : "🔴";
    const ctx = peer.contextUsedPct ? ` — ${peer.contextUsedPct}% ctx` : "";
    const caps = peer.capabilities?.length ? `\n   _${peer.capabilities.join(", ")}_` : "";
    const local = peer.name === localName ? " (you)" : "";
    lines.push(`${statusIcon} ${peer.name}${local} (${peer.role})${ctx}${caps}`);
  }

  const online = peers.filter(p => p.status === "online" || p.status === "busy").length;
  lines.push(`\n_${online}/${peers.length} peers online_`);
  return lines.join("\n");
}

export function formatTaskHistory(tasks: any[]): string {
  if (tasks.length === 0) return "📭 No task history.";

  const lines: string[] = ["📋 *Task History*\n"];
  for (const t of tasks.slice(0, 10)) {
    const icon = t.status === "completed" ? "✅" :
      t.status === "failed" ? "❌" :
        t.status === "running" ? "🔄" : "⏳";
    const preview = (t.task || "").slice(0, 60);
    lines.push(`${icon} ${t.peer} → ${preview}${t.task?.length > 60 ? "…" : ""}`);
  }
  return lines.join("\n");
}

export function formatPeerList(peers: AgentEntry[]): string {
  const lines: string[] = ["👥 *Available Peers*\n"];
  for (const peer of peers) {
    const statusIcon = peer.status === "online" ? "🟢" :
      peer.status === "busy" ? "🟡" : "🔴";
    const caps = peer.capabilities?.join(", ") || "general";
    lines.push(`${statusIcon} ${peer.name} — ${caps}`);
  }
  return lines.join("\n");
}

export function formatError(message: string): string {
  return `❌ ${message}`;
}

export function formatOfflinePeer(peerName: string): string {
  return `📭 ${peerName} is offline. Task queued for delivery when they reconnect.`;
}

export function formatUnknownPeer(peerName: string, available: string[]): string {
  return `❌ Unknown peer "${peerName}". Available: ${available.join(", ")}`;
}

export function formatParseError(): string {
  return "❓ Couldn't parse that. Try: /<peer> <task>";
}
