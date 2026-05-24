// Pi Network — Network Settings UI
// Toggle which peers can auto-claim tasks. Syncs across network.
// Up/Down to navigate, Enter to toggle, Ctrl+S to save & sync.

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { AgentEntry } from "../core/registry";

export interface NetworkSettings {
  /** Peers allowed to auto-claim tasks */
  autoClaimPeers: string[];
  /** Whether this node posts open tasks to the network */
  enableTaskBoard: boolean;
}

export const DEFAULT_SETTINGS: NetworkSettings = {
  autoClaimPeers: [],
  enableTaskBoard: true,
};

export interface SettingsResult {
  settings: NetworkSettings;
  saved: boolean;
}

export class NetworkSettingsOverlay implements Component {
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private peers: AgentEntry[];
  private settings: NetworkSettings;
  private done: (result: SettingsResult | undefined) => void;
  private selectedIndex = 0;
  private maxVisible = 10;
  private statusMessage = "";

  constructor(
    theme: Theme,
    keybindings: KeybindingsManager,
    peers: AgentEntry[],
    settings: NetworkSettings,
    done: (result: SettingsResult | undefined) => void,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.peers = peers.filter(p => (p as any).runtime !== "whatsapp"); // Exclude WhatsApp
    this.settings = { ...settings, autoClaimPeers: [...settings.autoClaimPeers] };
    this.done = done;
  }

  invalidate(): void {}

  private isToggled(name: string): boolean {
    return this.settings.autoClaimPeers.includes(name);
  }

  private toggle(name: string): void {
    const idx = this.settings.autoClaimPeers.indexOf(name);
    if (idx >= 0) {
      this.settings.autoClaimPeers.splice(idx, 1);
    } else {
      this.settings.autoClaimPeers.push(name);
    }
  }

  handleInput(data: string): void {
    // Ctrl+S or Ctrl+D to save
    if (data === "\x13" || data === "\x04") {
      this.done({ settings: this.settings, saved: true });
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      const totalItems = this.peers.length + 1; // +1 for task board toggle
      this.selectedIndex = this.selectedIndex === 0 ? totalItems - 1 : this.selectedIndex - 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      const totalItems = this.peers.length + 1;
      this.selectedIndex = this.selectedIndex === totalItems - 1 ? 0 : this.selectedIndex + 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.selectedIndex === 0) {
        // Toggle task board
        this.settings.enableTaskBoard = !this.settings.enableTaskBoard;
      } else {
        const peer = this.peers[this.selectedIndex - 1];
        if (peer) this.toggle(peer.name);
      }
      return;
    }

    // Space also toggles
    if (data === " ") {
      if (this.selectedIndex === 0) {
        this.settings.enableTaskBoard = !this.settings.enableTaskBoard;
      } else {
        const peer = this.peers[this.selectedIndex - 1];
        if (peer) this.toggle(peer.name);
      }
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(40, Math.min(width - 2, 88));
    const contentWidth = Math.max(1, innerWidth - 2);
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(" ⚙️ Pi Network Settings")));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));

    // Task board toggle (index 0)
    const boardChecked = this.settings.enableTaskBoard;
    const boardCursor = this.selectedIndex === 0 ? " ›" : "  ";
    const boardCheck = boardChecked ? this.theme.fg("success", "✓") : this.theme.fg("dim", "○");
    const boardLine = `${boardCursor} ${boardCheck} Enable Task Board`;
    lines.push(row(this.selectedIndex === 0 ? this.theme.fg("accent", boardLine) : boardLine));

    // Separator
    lines.push(row(this.theme.fg("dim", " ── Auto-Claim Peers (default: off) ──")));

    if (this.peers.length === 0) {
      lines.push(row(this.theme.fg("dim", " No peers discovered")));
    } else {
      const startIndex = Math.max(0, Math.min(
        this.selectedIndex - 1 - Math.floor(this.maxVisible / 2),
        this.peers.length - this.maxVisible,
      ));
      const endIndex = Math.min(startIndex + this.maxVisible, this.peers.length);

      for (let i = startIndex; i < endIndex; i++) {
        const peer = this.peers[i]!;
        const displayIdx = i + 1;
        const selected = displayIdx === this.selectedIndex;
        const checked = this.isToggled(peer.name);
        const cursor = selected ? " ›" : "  ";
        const check = checked ? this.theme.fg("success", "✓") : this.theme.fg("dim", "○");

        const rt = (peer as any).runtime === "claude" ? " [claude]" : (peer as any).runtime === "pi" ? " [pi]" : "";
        const model = peer.model ? ` ${peer.model?.replace(/^(anthropic\/|openai\/|google\/|x-ai\/|meta\/)/, "")}` : "";
        const statusIcon = peer.status === "online" ? "🟢" : peer.status === "busy" ? "🟡" : "🔴";

        const line = `${cursor} ${check} ${statusIcon} ${peer.name}${this.theme.fg("dim", rt + model)}`;
        lines.push(row(selected ? this.theme.fg("accent", line) : line));
      }
    }

    // Footer
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    const toggle = this.keybindings.getKeys("tui.select.confirm").join("/");
    const save = "Ctrl+S";
    const cancel = this.keybindings.getKeys("tui.select.cancel").join("/");
    lines.push(row(this.theme.fg("dim", ` ${toggle} Toggle • ${save} Save & Sync • ${cancel} Cancel`)));

    if (this.settings.autoClaimPeers.length > 0) {
      lines.push(row(this.theme.fg("dim", ` Auto-claim: ${this.settings.autoClaimPeers.join(", ")}`)));
    }

    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));
    return lines;
  }
}
