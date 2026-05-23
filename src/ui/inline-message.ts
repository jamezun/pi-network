// Pi Network — Framed inline message component
// Renders inbound messages with a bordered frame, like pi-intercom.
// Uses the Component API for proper TUI rendering.

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AgentEntry } from "../core/registry";

export interface NetworkMessageDetails {
  from: string;
  fromPeer?: AgentEntry;
  type: "task_result" | "file_received" | "clarification" | "status_update" | "inbound_task" | "queued";
  content: string;
  timestamp?: number;
  replyCommand?: string;
  taskId?: string;
  hops?: number;
  color?: string;
}

export class NetworkInlineMessage implements Component {
  private details: NetworkMessageDetails;
  private theme: Theme;

  constructor(details: NetworkMessageDetails, theme: Theme) {
    this.details = details;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const borderChar = "─";

    if (width < 3) {
      return [truncateToWidth(`From ${this.details.from}`, width)];
    }

    const bodyWidth = Math.max(1, width - 2);
    const d = this.details;
    const icon = this.getIcon();
    const ts = d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : "";
    const hopsInfo = d.hops !== undefined ? ` • ${d.hops} hop${d.hops !== 1 ? "s" : ""}` : "";
    const peerInfo = d.fromPeer ? ` (${d.fromPeer.role})` : "";

    // Header
    const header = ` ${icon} From: ${d.from}${peerInfo} ${ts}${hopsInfo} `;
    const headerText = truncateToWidth(header, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    lines.push(this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`));

    // Body content
    const contentLines = wrapTextWithAnsi(d.content, bodyWidth);
    for (const line of contentLines) {
      const text = truncateToWidth(line, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    // Reply hint
    if (d.replyCommand) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      const replyLines = wrapTextWithAnsi(
        this.theme.fg("dim", ` ↩ To reply: ${d.replyCommand}`),
        bodyWidth
      );
      for (const line of replyLines) {
        const text = truncateToWidth(line, bodyWidth, "");
        const padding = Math.max(0, bodyWidth - visibleWidth(text));
        lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
      }
    }

    // Task ID footer
    if (d.taskId) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      const taskIdLine = this.theme.fg("dim", ` 🆔 ${d.taskId.slice(0, 16)}`);
      const text = truncateToWidth(taskIdLine, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    // Close
    lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));

    return lines;
  }

  private getIcon(): string {
    switch (this.details.type) {
      case "task_result": return "📬";
      case "file_received": return "📎";
      case "clarification": return "❓";
      case "status_update": return "📊";
      case "inbound_task": return "📨";
      case "queued": return "📥";
      default: return "○";
    }
  }
}

/**
 * Format message details for inline rendering.
 * Used as the `details` field in pi.sendMessage() calls.
 */
export function makeMessageDetails(
  type: NetworkMessageDetails["type"],
  from: string,
  content: string,
  extra?: Partial<NetworkMessageDetails>,
): NetworkMessageDetails {
  return {
    type,
    from,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}
