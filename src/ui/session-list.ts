// Pi Network — Session list overlay for TUI
// Phase 1.3: Alt+M overlay showing all peers (local + remote) with status indicators.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentEntry } from "../core/registry";

interface SessionListOptions {
  peers: AgentEntry[];
  localName: string;
  onSelect: (peer: AgentEntry) => void;
  onDismiss: () => void;
}

export function createSessionListOverlay(pi: ExtensionAPI, options: SessionListOptions): void {
  const { peers, localName, onSelect, onDismiss } = options;

  const lines: string[] = ["╭─ 👥 Pi Network Peers ─╮", "│"];

  for (const peer of peers) {
    const statusIcon = peer.status === "online" ? "🟢" :
      peer.status === "busy" ? "🟡" :
        peer.status === "unresponsive" ? "🟠" : "🔴";

    const ctx = peer.contextUsedPct != null ? ` ${peer.contextUsedPct}%ctx` : "";
    const queue = peer.queueLength ? ` q:${peer.queueLength}` : "";
    const model = peer.model ? ` (${peer.model})` : "";
    const local = peer.name === localName ? " ← you" : "";
    const caps = peer.capabilities?.length ? ` [${peer.capabilities.join(",")}]` : "";

    lines.push(`│ ${statusIcon} ${peer.name}${caps}${model}${ctx}${queue}${local}`);
  }

  lines.push("│");
  lines.push("│ ↑↓ navigate · Enter select · Esc dismiss");
  lines.push("╰──────────────────────────────────────────╯");

  pi.sendMessage({
    customType: "network-session-list",
    content: lines.join("\n"),
    display: true,
  }, { triggerTurn: false });
}
