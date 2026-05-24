// Pi Network — WhatsApp/CLI command parser
// Normalized: all subcommands go through /network <subcommand>
// Direct peer targeting: /<peer> <task>

export interface ParsedCommand {
  type: "task" | "broadcast" | "status" | "peers" | "help" | "kill" | "history" | "tasks" | "grab" | "post" | "settings" | "unknown";
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

// Known peer names for fuzzy matching (set at runtime)
let knownPeers: string[] = [];

export function setKnownPeers(peers: string[]): void {
  knownPeers = peers.map(p => p.toLowerCase());
}

/**
 * Fuzzy match a peer name: exact → case-insensitive → substring → prefix → Levenshtein
 */
export function fuzzyMatchPeer(input: string, peers: string[]): string | null {
  const lower = input.toLowerCase();
  // 1. Exact (case-insensitive)
  const exact = peers.find(p => p.toLowerCase() === lower);
  if (exact) return exact;
  // 2. Substring
  const substring = peers.find(p => p.toLowerCase().includes(lower) || lower.includes(p.toLowerCase()));
  if (substring) return substring;
  // 3. Prefix
  const prefix = peers.find(p => p.toLowerCase().startsWith(lower));
  if (prefix) return prefix;
  // 4. Levenshtein
  const threshold = lower.length <= 6 ? 2 : 3;
  let bestMatch: string | null = null;
  let bestDist = Infinity;
  for (const peer of peers) {
    const d = levenshtein(lower, peer.toLowerCase());
    if (d < bestDist && d <= threshold) { bestDist = d; bestMatch = peer; }
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
 * Network subcommands — shared between TUI (/network xxx) and WhatsApp (/network xxx)
 */
const NETWORK_SUBCOMMANDS: Record<string, ParsedCommand["type"]> = {
  status: "status",
  peers: "peers",
  list: "peers",
  help: "help",
  "?": "help",
  kill: "kill",
  cancel: "kill",
  history: "history",
  tasks: "tasks",
  post: "post",
  request: "post",
  grab: "grab",
  claim: "grab",
  settings: "settings",
  config: "settings",
  broadcast: "broadcast",
  all: "broadcast",
  send: "task",  // /network send <peer> <task>
  ask: "task",   // /network ask <peer> <task>
  tell: "task",  // /network tell <peer> <task>
};

/**
 * Parse a command string into a structured command object.
 *
 * All commands use /network <subcommand> (same as TUI):
 *   /network status
 *   /network peers
 *   /network tasks
 *   /network post <task>
 *   /network grab
 *   /network send <peer> <task>
 *   /network broadcast <task>
 *   /network history
 *   /network kill <taskId>
 *   /network settings
 *   /network help
 *
 * Direct peer targeting (shortcut):
 *   /<peer> <task>
 *   @<peer> <task>
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
    return { type: "task", peer: matched || rawPeer, task: stripFlags(rest), options: parseFlags(rest), raw: input };
  }

  // Extract command word and rest
  const spaceIdx = body.indexOf(" ");
  const command = spaceIdx >= 0 ? body.slice(0, spaceIdx).toLowerCase() : body.toLowerCase();
  const rest = spaceIdx >= 0 ? body.slice(spaceIdx + 1).trim() : "";

  // ── /network <subcommand> — unified entry point ──
  if (command === "network") {
    return parseNetworkSubcommand(rest, input, peers);
  }

  // ── Direct shortcuts (backward compat) ──
  // These still work but are treated as /network <subcommand> equivalents
  if (command === "status") return { type: "status", raw: input };
  if (command === "help" || command === "?") return { type: "help", raw: input };

  // ── /<peer> <task> — direct peer targeting ──
  if (rest) {
    const matched = fuzzyMatchPeer(command, peers);
    if (matched) {
      const flags = parseFlags(rest);
      return { type: "task", peer: matched, task: stripFlags(rest), options: flags, raw: input };
    }
    // Not a known peer — could be unknown peer or typo
    const flags = parseFlags(rest);
    return { type: "task", peer: command, task: stripFlags(rest), options: flags, raw: input };
  }

  // Bare command with no rest — check if it's a peer name
  const matched = fuzzyMatchPeer(command, peers);
  if (matched) return { type: "unknown", raw: input };

  return { type: "unknown", raw: input };
}

/**
 * Parse /network <subcommand> [args]
 */
function parseNetworkSubcommand(rest: string, raw: string, peers: string[]): ParsedCommand {
  if (!rest) return { type: "status", raw }; // bare /network → status

  const spaceIdx = rest.indexOf(" ");
  const sub = (spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest).toLowerCase();
  const subRest = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : "";

  const resolvedType = NETWORK_SUBCOMMANDS[sub];
  if (!resolvedType) {
    // /network <peer> <task> — treat as peer targeting
    if (subRest) {
      const matched = fuzzyMatchPeer(sub, peers);
      const flags = parseFlags(subRest);
      return { type: "task", peer: matched || sub, task: stripFlags(subRest), options: flags, raw };
    }
    return { type: "unknown", raw };
  }

  switch (resolvedType) {
    case "status":
    case "peers":
    case "help":
    case "history":
    case "tasks":
    case "grab":
    case "settings":
      return { type: resolvedType, raw };

    case "kill":
      return { type: "kill", taskId: subRest || undefined, raw };

    case "post":
      return { type: "post", task: stripFlags(subRest), options: parseFlags(subRest), raw };

    case "broadcast":
      return { type: "broadcast", task: stripFlags(subRest), options: parseFlags(subRest), raw };

    case "task": {
      // /network send <peer> <task>
      if (!subRest) return { type: "unknown", raw };
      const peerSpace = subRest.indexOf(" ");
      if (peerSpace < 0) return { type: "unknown", raw };
      const rawPeer = subRest.slice(0, peerSpace);
      const taskText = subRest.slice(peerSpace + 1).trim();
      const matched = fuzzyMatchPeer(rawPeer, peers);
      return { type: "task", peer: matched || rawPeer, task: stripFlags(taskText), options: parseFlags(taskText), raw };
    }

    default:
      return { type: "unknown", raw };
  }
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

All commands start with /network:

/network status — Show network status
/network peers — List all peers
/network tasks — List open tasks
/network post <task> — Post task for anyone to claim
/network grab — Claim first open task
/network send <peer> <task> — Send task to peer
/network broadcast <task> — Send to all peers
/network history — Recent task history
/network kill <taskId> — Cancel a task
/network settings — Toggle auto-claim peers
/network help — Show this help

_Shortcut: /<peer> <task> also works_
_Examples:_
/network send venus calculate 1+1
/network post review auth.ts for security issues
/network grab
/venus calculate 1+1

_Flags: --priority=urgent|high|normal|low  --mode=agent|raw|inbox  --deliver-to=<peer>_

_Send images/documents to attach files to tasks._`;
}
