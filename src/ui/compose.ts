// Pi Network — Compose overlay for TUI
// Phase 1.3: Text input overlay for composing messages/tasks to a selected peer.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentEntry } from "../core/registry";

export interface ComposeResult {
  peer: AgentEntry;
  task: string;
  mode: "agent" | "raw" | "inbox";
}

export function createComposeOverlay(
  pi: ExtensionAPI,
  peer: AgentEntry,
  onSend: (result: ComposeResult) => void,
  onDismiss: () => void,
): void {
  const lines: string[] = [
    `╭─ 📝 Compose to ${peer.name} ─╮`,
    `│ Mode: agent (default) │`,
    `│ _Type your task below, then press Enter to send_ │`,
    `│`,
    `│ /mode raw — change to raw mode │`,
    `│ /mode inbox — change to inbox mode │`,
    `│ Esc — cancel │`,
    `╰──────────────────────────────────────────╯`,
  ];

  pi.sendMessage({
    customType: "network-compose",
    content: lines.join("\n"),
    display: true,
  }, { triggerTurn: true });
}
