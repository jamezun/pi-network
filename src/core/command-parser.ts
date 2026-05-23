// Pi Network — WhatsApp/CLI command parser
// Phase 2.3: Parse /command formats for WhatsApp and other chat interfaces.

export interface ParsedCommand {
  type: "task" | "broadcast" | "status" | "peers" | "help" | "kill" | "history" | "unknown";
  peer?: string;
  task?: string;
  options?: {
    priority?: "urgent" | "high" | "normal" | "low";
    mode?: "agent" | "raw" | "inbox";
    deliverTo?: string;
  };
  taskId?: string;
  raw: string;
}

/**
 * Parse a command string into a structured command object.
 * Supports formats:
 *   /vps check disk space
 *   /laptop review auth.ts --deliver-to=desktop
 *   /broadcast report status
 *   /status
 *   /help
 *   /peers
 *   /kill task-abc123
 *   /history
 *   @vps can you check the nginx logs
 */
export function parseCommand(input: string, prefix = "/"): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed) return { type: "unknown", raw: input };

  // Strip prefix
  let body = trimmed;
  if (body.startsWith(prefix)) {
    body = body.slice(prefix.length);
  } else if (body.startsWith("@")) {
    // @peer natural language format
    const spaceIdx = body.indexOf(" ");
    if (spaceIdx < 0) return { type: "unknown", raw: input };
    const peer = body.slice(1, spaceIdx);
    const rest = body.slice(spaceIdx + 1).trim();
    if (!rest) return { type: "unknown", raw: input };
    return {
      type: "task",
      peer,
      task: stripFlags(rest),
      options: parseFlags(rest),
      raw: input,
    };
  }

  // Extract command word and rest
  const spaceIdx = body.indexOf(" ");
  const command = spaceIdx >= 0 ? body.slice(0, spaceIdx).toLowerCase() : body.toLowerCase();
  const rest = spaceIdx >= 0 ? body.slice(spaceIdx + 1).trim() : "";

  // Meta commands (no peer)
  if (command === "status" || command === "network") {
    return { type: "status", raw: input };
  }
  if (command === "help" || command === "?") {
    return { type: "help", raw: input };
  }
  if (command === "peers" || command === "list") {
    return { type: "peers", raw: input };
  }
  if (command === "kill" || command === "cancel") {
    return { type: "kill", taskId: rest || undefined, raw: input };
  }
  if (command === "history" || command === "tasks") {
    return { type: "history", raw: input };
  }
  if (command === "broadcast" || command === "all") {
    const flags = parseFlags(rest);
    return {
      type: "broadcast",
      task: stripFlags(rest),
      options: flags,
      raw: input,
    };
  }

  // Peer-targeted task: /<peer> <task>
  if (rest) {
    const flags = parseFlags(rest);
    return {
      type: "task",
      peer: command,
      task: stripFlags(rest),
      options: flags,
      raw: input,
    };
  }

  return { type: "unknown", raw: input };
}

const FLAG_PATTERN = /--([a-zA-Z_-]+)=([^\s]+)/g;

function parseFlags(text: string): ParsedCommand["options"] {
  const options: NonNullable<ParsedCommand["options"]> = {};
  let match: RegExpExecArray | null;

  FLAG_PATTERN.lastIndex = 0;
  while ((match = FLAG_PATTERN.exec(text)) !== null) {
    const key = match[1].toLowerCase().replace(/-/g, "");
    const value = match[2];

    switch (key) {
      case "priority":
        if (["urgent", "high", "normal", "low"].includes(value)) options.priority = value as any;
        break;
      case "mode":
        if (["agent", "raw", "inbox"].includes(value)) options.mode = value as any;
        break;
      case "deliverto":
        options.deliverTo = value;
        break;
    }
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function stripFlags(text: string): string {
  return text.replace(/--([a-zA-Z_-]+)=([^\s]+)/g, "").trim();
}

export function formatHelpText(): string {
  return `*Pi Network Commands*

/<peer> <task> — Send task to a peer
/broadcast <task> — Send to all online peers
/status — Show network status
/peers — List all peers
/history — Recent task history
/kill <taskId> — Cancel a task
/help — Show this help

_Flags: --priority=urgent|high|normal|low  --mode=agent|raw|inbox  --deliver-to=<peer>_`;
}
