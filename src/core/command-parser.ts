// Pi Network — WhatsApp/CLI command parser
// Phase 2.3: Parse /command formats for WhatsApp and other chat interfaces.
// Supports strict commands, fuzzy peer matching, and natural language fallback.

export interface ParsedCommand {
  type: "task" | "broadcast" | "status" | "peers" | "help" | "kill" | "history" | "tasks" | "grab" | "post" | "unknown";
  peer?: string;
  task?: string;
  options?: {
    priority?: "urgent" | "high" | "normal" | "low";
    mode?: "agent" | "raw" | "inbox";
    deliverTo?: string;
  };
  taskId?: string;
  media?: {
    type: "image" | "document" | "video" | "audio";
    url?: string;
    base64?: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
  };
  raw: string;
}

// Known peer names for fuzzy matching (set at runtime)
let knownPeers: string[] = [];

export function setKnownPeers(peers: string[]): void {
  knownPeers = peers.map(p => p.toLowerCase());
}

/**
 * Fuzzy match a peer name: exact → case-insensitive → substring → prefix
 */
export function fuzzyMatchPeer(input: string, peers: string[]): string | null {
  const lower = input.toLowerCase();

  // 1. Exact match (case-insensitive)
  const exact = peers.find(p => p.toLowerCase() === lower);
  if (exact) return exact;

  // 2. Substring match (peer name contains input)
  const substring = peers.find(p => p.toLowerCase().includes(lower) || lower.includes(p.toLowerCase()));
  if (substring) return substring;

  // 3. Prefix match
  const prefix = peers.find(p => p.toLowerCase().startsWith(lower));
  if (prefix) return prefix;

  // 4. Levenshtein distance for typos (threshold: 2 edits for names <= 6 chars, 3 for longer)
  const threshold = lower.length <= 6 ? 2 : 3;
  let bestMatch: string | null = null;
  let bestDist = Infinity;
  for (const peer of peers) {
    const d = levenshtein(lower, peer.toLowerCase());
    if (d < bestDist && d <= threshold) {
      bestDist = d;
      bestMatch = peer;
    }
  }
  return bestMatch;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Parse a command string into a structured command object.
 * Supports formats:
 *   /venus calculate 1+1
 *   /Venus please calculate 1+1 and tell me what it is  (fuzzy peer match)
 *   /ask venus what is 1+1                              (explicit ask)
 *   /laptop review auth.ts --deliver-to=desktop
 *   /broadcast report status
 *   /status, /help, /peers, /kill, /history
 *   @vps can you check the nginx logs
 *   plain text without / → sent to default peer or parsed as LLM instruction
 */
export function parseCommand(input: string, prefix = "/", peers: string[] = knownPeers): ParsedCommand {
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
    const rawPeer = body.slice(1, spaceIdx);
    const matched = fuzzyMatchPeer(rawPeer, peers);
    const rest = body.slice(spaceIdx + 1).trim();
    if (!rest) return { type: "unknown", raw: input };
    return {
      type: "task",
      peer: matched || rawPeer,
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
  if (command === "history" || command === "tasks" || command === "list") {
    return { type: "history", raw: input };
  }
  if (command === "grab" || command === "claim") {
    return { type: "grab", raw: input };
  }
  if (command === "post" || command === "request") {
    const flags = parseFlags(rest);
    return {
      type: "post",
      task: stripFlags(rest),
      options: flags,
      raw: input,
    };
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

  // /ask <peer> <task> — explicit ask syntax
  if (command === "ask" || command === "send" || command === "tell") {
    const askSpaceIdx = rest.indexOf(" ");
    if (askSpaceIdx < 0) return { type: "unknown", raw: input };
    const rawPeer = rest.slice(0, askSpaceIdx);
    const taskText = rest.slice(askSpaceIdx + 1).trim();
    const matched = fuzzyMatchPeer(rawPeer, peers);
    return {
      type: "task",
      peer: matched || rawPeer,
      task: stripFlags(taskText),
      options: parseFlags(taskText),
      raw: input,
    };
  }

  // Peer-targeted task: /<peer> <task>
  if (rest) {
    const matched = fuzzyMatchPeer(command, peers);
    const flags = parseFlags(rest);
    return {
      type: "task",
      peer: matched || command,
      task: stripFlags(rest),
      options: flags,
      raw: input,
    };
  }

  // Just a peer name with no task — /venus (no text)
  if (peers.length > 0) {
    const matched = fuzzyMatchPeer(command, peers);
    if (matched) {
      return { type: "unknown", raw: input };
    }
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

/${"{"}peer${"}"} <task> — Send task (fuzzy match)
/ask <peer> <task> — Explicit ask syntax
/broadcast <task> — Send to all online peers
/post <task> — Post task for anyone to claim
/grab — Claim the first open task
/status — Show network status
/peers — List all peers
/history — Recent task history
/kill <taskId> — Cancel a task
/help — Show this help

_Examples:_
/venus calculate 1+1
/Venus please calculate 1+1 and tell me
/ask ven what is the weather?
/send laptop review auth.ts

_Flags: --priority=urgent|high|normal|low  --mode=agent|raw|inbox  --deliver-to=<peer>_

_Send images/documents to attach files to tasks._`;
}
