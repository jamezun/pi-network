// Pi Network — Inline message rendering component
// Phase 1.4: Styled rendering of inbound results, file receipts, and clarification requests.

import type { AgentEntry } from "../core/registry";
import type { TaskResult } from "../core/tasks";

export interface InlineMessageOptions {
  type: "task_result" | "file_received" | "clarification" | "status_update";
  from: string;
  color?: string;
  timestamp?: number;
  content: string;
  peer?: AgentEntry;
}

export function formatInlineMessage(options: InlineMessageOptions): string {
  const { type, from, color, content } = options;
  const ts = options.timestamp ? new Date(options.timestamp).toLocaleTimeString() : "";
  const colorDot = color ? `●` : "○";

  switch (type) {
    case "task_result": {
      const icon = "📬";
      const preview = content.length > 300 ? content.slice(0, 300) + "…" : content;
      return [
        `${icon} ${colorDot} *${from}* ${ts}`,
        "─".repeat(40),
        preview,
        `_Reply with follow-up, or dismiss_`,
      ].join("\n");
    }

    case "file_received": {
      return `${colorDot} 📎 *${from}* sent file: ${content} ${ts}`;
    }

    case "clarification": {
      return [
        `${colorDot} ❓ *${from}* asks:`,
        "─".repeat(40),
        content,
        `_Reply to answer, or dismiss_`,
      ].join("\n");
    }

    case "status_update": {
      return `${colorDot} 📊 ${from}: ${content} ${ts}`;
    }
  }
}

export function formatResultInline(result: TaskResult, peer?: AgentEntry): string {
  return formatInlineMessage({
    type: result.status === "completed" ? "task_result" : "task_result",
    from: result.from,
    color: peer?.color,
    timestamp: Date.now(),
    content: result.result,
    peer,
  });
}
