// Pi Network — Compose overlay for TUI
// Text input overlay for composing messages/tasks to a selected peer.

import type { Component, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { AgentEntry } from "../core/registry";

export interface NetworkComposeResult {
  sent: boolean;
  text?: string;
  mode?: "agent" | "raw" | "inbox";
}

export class NetworkComposeOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private peer: AgentEntry;
  private done: (result: NetworkComposeResult) => void;
  private inputBuffer: string = "";
  private mode: "agent" | "raw" | "inbox" = "agent";
  private sending: boolean = false;
  private error: string | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    peer: AgentEntry,
    done: (result: NetworkComposeResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.peer = peer;
    this.done = done;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.sending) return;

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ sent: false });
      return;
    }

    // Ctrl+M to cycle mode
    if (data === "\x0d" && !this.inputBuffer.trim()) {
      // bare enter with empty input — cycle mode
      const modes: Array<"agent" | "raw" | "inbox"> = ["agent", "raw", "inbox"];
      const idx = modes.indexOf(this.mode);
      this.mode = modes[(idx + 1) % modes.length]!;
      this.tui.requestRender();
      return;
    }

    if (data.startsWith("\x1b")) return;

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.inputBuffer.trim()) {
        this.done({ sent: true, text: this.inputBuffer.trim(), mode: this.mode });
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.inputBuffer = [...this.inputBuffer].slice(0, -1).join("");
      this.tui.requestRender();
      return;
    }

    const printable = [...data].filter(c => c >= " ").join("");
    if (printable) {
      this.inputBuffer += printable;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(28, Math.min(width - 2, 72));
    const contentWidth = Math.max(1, innerWidth - 2);
    const modeLabel = this.mode === "agent" ? "🤖 agent" : this.mode === "raw" ? "📄 raw" : "📥 inbox";
    const footer = `Enter: Send • Esc: Close • Mode: ${modeLabel}`;
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    const statusIcon = this.peer.status === "online" ? "🟢"
      : this.peer.status === "busy" ? "🟡"
      : "⬜";

    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(` 📝 Send to: ${statusIcon} ${this.peer.name}`)));
    lines.push(row(this.theme.fg("dim", ` ${this.peer.role} • ${modeLabel}`)));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());

    if (this.error) {
      lines.push(row(this.theme.fg("error", ` Error: ${this.error}`)));
      lines.push(row());
    }

    // Input area (3 lines)
    const inputLines = this.wrapInput(contentWidth - 3);
    for (let i = 0; i < 3; i++) {
      const lineText = inputLines[i] || "";
      const cursor = i === inputLines.length - 1 ? "█" : "";
      lines.push(row(` > ${lineText}${cursor}`));
    }

    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.fg("dim", ` ${footer}`)));
    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));

    return lines;
  }

  private wrapInput(maxWidth: number): string[] {
    if (!this.inputBuffer) return [];
    const result: string[] = [];
    let remaining = this.inputBuffer;
    while (remaining.length > 0 && result.length < 3) {
      const chunk = remaining.slice(0, maxWidth);
      result.push(chunk);
      remaining = remaining.slice(maxWidth);
    }
    return result;
  }
}
