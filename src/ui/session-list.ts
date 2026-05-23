// Pi Network — Peer list overlay for TUI
// Shows online mesh peers, lets user pick one to message.

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { AgentEntry } from "../core/registry";

function middleTruncate(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return truncateToWidth(text, maxWidth, "");
  const chars = [...text];
  const targetSide = Math.max(1, Math.floor((maxWidth - 1) / 2));
  let left = "";
  for (const c of chars) {
    if (visibleWidth(left + c) > targetSide) break;
    left += c;
  }
  let right = "";
  for (const c of chars.slice().reverse()) {
    if (visibleWidth(c + right) > targetSide) break;
    right = c + right;
  }
  return truncateToWidth(`${left}…${right}`, maxWidth, "");
}

export interface PeerPickResult {
  peer: AgentEntry;
}

export class PeerListOverlay implements Component {
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private localName: string;
  private done: (result: PeerPickResult | undefined) => void;
  private peers: AgentEntry[];
  private selectedIndex = 0;
  private maxVisible = 8;

  constructor(
    theme: Theme,
    keybindings: KeybindingsManager,
    localName: string,
    peers: AgentEntry[],
    done: (result: PeerPickResult | undefined) => void,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.localName = localName;
    this.peers = peers;
    this.done = done;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    if (this.peers.length === 0) return;

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0
        ? this.peers.length - 1
        : this.selectedIndex - 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === this.peers.length - 1
        ? 0
        : this.selectedIndex + 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const peer = this.peers[this.selectedIndex];
      if (peer) this.done({ peer });
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(36, Math.min(width - 2, 88));
    const contentWidth = Math.max(1, innerWidth - 2);
    const footer = `${this.keybindings.getKeys("tui.select.confirm").join("/")} Send • ${this.keybindings.getKeys("tui.select.cancel").join("/")} Close`;
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(" 🌐 Mesh Network — Select Peer")));
    lines.push(row(this.theme.fg("dim", ` You: ${this.localName}`)));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());

    if (this.peers.length === 0) {
      lines.push(row(this.theme.fg("dim", " No peers online")));
      lines.push(row(this.theme.fg("dim", " Peers appear when they connect to the mesh")));
    } else {
      const startIndex = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(this.maxVisible / 2),
          this.peers.length - this.maxVisible,
        ),
      );
      const endIndex = Math.min(startIndex + this.maxVisible, this.peers.length);

      for (let i = startIndex; i < endIndex; i++) {
        const peer = this.peers[i]!;
        const selected = i === this.selectedIndex;
        const statusIcon = peer.status === "online" ? "🟢"
          : peer.status === "busy" ? "🟡"
          : peer.status === "unresponsive" ? "🔴"
          : "⬜";
        const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
        const peerLine = `${statusIcon} ${peer.name} (${peer.role})`;
        const caps = peer.capabilities.length > 0
          ? ` ${this.theme.fg("dim", peer.capabilities.slice(0, 3).join(", "))}`
          : "";

        lines.push(row(`${prefix}${selected ? this.theme.fg("accent", peerLine) : peerLine}${caps}`));

        if (selected && i < endIndex - 1) {
          lines.push(row());
        }
      }

      if (startIndex > 0 || endIndex < this.peers.length) {
        lines.push(row());
        lines.push(row(this.theme.fg("dim", ` ${this.selectedIndex + 1}/${this.peers.length}`)));
      }
    }

    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.fg("dim", ` ${footer}`)));
    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));

    return lines;
  }
}
