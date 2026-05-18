# Pi Network — Product Requirements Document

> **Version:** 1.1.0  
> **Date:** 2026-05-19  
> **Status:** Draft  
> **Repository:** https://github.com/jamezun/pi-network

---

## 1. Overview

### 1.1 What Is Pi Network?

Pi Network is a Pi coding agent extension that turns multiple Pi instances (and Claude Code instances) into a coordinated agent mesh. Any Pi agent can send tasks to any other agent, delegate work based on capabilities, transfer files, and route results back through a chain of custody — all without losing track of work.

### 1.2 Problem Statement

- Running a single Pi agent is limited to one machine's context and tools.
- Users with multiple machines (desktop, laptop, VPS) must manually coordinate work between them.
- No mechanism exists for Pi agents to delegate tasks to specialized agents on other machines.
- Concurrent agents working on the same codebase can conflict and overwrite each other's work.
- Results from remote agents can be lost if there is no tracking chain back to the original requester.

### 1.3 Goals

1. **Peer-to-peer agent mesh** — Any Pi can talk to any other Pi by name.
2. **Capability-based delegation** — Agents know what other agents are good at and delegate accordingly.
3. **Hierarchy** — Manager and worker roles with proper chain of command.
4. **Task chain tracking** — Every result traces back to the original instructor.
5. **File safety** — Distributed line-range locking prevents concurrent edits on the same lines, while allowing multiple agents to work on different parts of the same file simultaneously.
6. **Offline resilience** — Tasks queue and auto-deliver when peers come back online.
7. **Multi-network** — Tailscale (default), public server, hybrid, or local-only.
8. **Claude Code integration** — Claude Code instances participate as workers via a bridge server.
9. **Token efficiency** — File transfers, notifications, and raw commands are token-free.
10. **Zero-config Tailscale** — If Tailscale is running, everything works automatically.

---

## 2. Architecture

### 2.1 High-Level Topology

```
TAILNET (default)                    PUBLIC SERVER (fallback)
                                    
  desktop ◄──────► laptop             laptop ──►┐
     │                │                desktop ──►├──► RELAY:9765
     │                │                vps ──────►┘    (public IP)
     └──────► vps ◄───┘                               ◄── routes
                                                    
```

### 2.2 Components

| Component | Description | Runs On |
|---|---|---|
| **Pi Extension** | Registers tools, intercepts file writes, injects system prompt, manages task chains | Every Pi machine |
| **Transport Layer** | Handles communication (Tailscale direct / server WebSocket+poll / hybrid) | Inside Pi Extension |
| **Local Bridge Server** | HTTP listener on port 9764 for incoming tasks, files, pings | Every Pi machine |
| **Claude Bridge Server** | HTTP listener on port 9766 that wraps `claude -p` | Claude Code machines |
| **Relay Server** | Central message queue, registry, file locks, file store | VPS (server/hybrid mode) |

### 2.3 Network Modes

| Mode | Default? | Transport | Server Required | Use Case |
|---|---|---|---|---|
| `tailscale` | **Yes** | Direct HTTP over WireGuard | No (optional for offline queue) | Personal machines on same tailnet |
| `server` | No | WebSocket + HTTP polling via relay | Yes | Machines behind NAT without Tailscale |
| `hybrid` | No | Tailscale direct + server fallback | Yes | Mixed: some on tailnet, some not |
| `local` | No | Direct HTTP on LAN only | No | Isolated / no network |

Mode is **auto-detected** on startup:
- Tailscale running + no server config → `tailscale`
- Tailscale running + server config → `hybrid`
- No Tailscale + server config → `server`
- Neither → `local`

### 2.4 Security Model

| Mode | Encryption | Authentication | Authorization |
|---|---|---|---|
| Tailscale | WireGuard (automatic) | Tailscale identity | Tailscale ACLs (`tag:pi-agent`) |
| Server | TLS (Let's Encrypt / Caddy) | API key | API key per agent |
| Hybrid | Both | Both | Both |
| Local | None (LAN trusted) | None | None |

---

## 3. Core Concepts

### 3.1 Peers

Every machine running Pi with the extension installed is a **peer**. Peers are identified by a human-readable name (e.g. `"desktop"`, `"laptop"`, `"vps"`).

Peers are defined in `~/.pi/agent/bridge/config.json`:

```json
{
  "localName": "desktop",
  "peers": {
    "desktop": { "type": "pi" },
    "laptop":  { "type": "pi" },
    "vps":     { "type": "pi" },
    "claude-laptop": { "type": "claude", "bridgePort": 9766 }
  }
}
```

### 3.2 Roles

| Role | Description | Sees | Delegates to |
|---|---|---|---|
| `manager` | Coordinates workers, consolidates results | All workers it manages + other managers | Any visible worker |
| `worker` | Executes tasks, reports results | Its manager only | Its manager (to report status) |

### 3.3 Capabilities & Specialties

Each peer declares what it's good at:

```json
{
  "capabilities": ["coding", "design", "testing"],
  "specialties": ["css", "react", "ui-testing"]
}
```

The extension injects this information into the system prompt of every agent, so the LLM can make intelligent delegation decisions without extra tool calls.

### 3.4 Task Envelope

Every task carries a **chain-of-custody envelope**:

```typescript
interface TaskEnvelope {
  taskId: string;
  parentTaskId: string | null;
  rootTaskId: string;
  originInstructor: string;     // who started it all
  originSession: string;        // their session name
  chain: ChainHop[];            // every hop in order
  task: string;
  taskType: "agent" | "raw" | "file" | "notification";
  status: "queued" | "running" | "completed" | "failed" | "killed" | "reassigned" | "waiting_for_answer";
  lockScope: string[];          // files this task intends to touch
  requiresConsolidation: boolean;
  deliverTo: string;            // who gets the result
  projectContext?: ProjectContext;
  requiredSecrets?: string[];  // names of secrets from vault
  partialWork?: string;        // work done so far (if reassigned)
}

interface ChainHop {
  agent: string;
  session: string;
  role: "instructor" | "manager" | "worker";
  timestamp: number;
  action: "delegated" | "reassigned" | "clarified";
}

interface ProjectContext {
  cwd: string;            // working directory on the worker's machine
  repo?: string;          // git remote URL (if applicable)
  branch?: string;       // branch to checkout
  keyFiles: string[];    // file list only — worker reads on demand
}
```

**Guarantee:** Every result traces back through the chain to the original instructor. No work is lost.

### 3.5 Line-Range Locking

Distributed line-range locks prevent conflicting edits while maximizing parallelism:

- Locks are scoped to **specific line ranges** within a file, not the entire file.
- Multiple agents can edit the same file simultaneously as long as their line ranges don't overlap.
- Before any `write` or `edit` tool call, the extension checks if the affected lines overlap with any existing lock.
- The `edit` tool's `oldText` is used to resolve the exact line range being modified.
- The `write` tool locks the entire file (since it replaces the whole content).
- Locks are stored on the relay server (server/hybrid mode) or tracked locally (tailscale mode).
- Locks are scoped to a `rootTaskId` and released when the task chain completes.
- Auto-expire after 1 hour as a safety net.
- Agents can request a lock with a timeout using `request_file_lock` tool.

**Example — Two agents editing the same file:**

```
File: src/app.ts (200 lines)

Agent A locks:   lines 1-50    (imports and config)
Agent B locks:   lines 120-180 (utility functions)

Both work simultaneously. No conflict.

If Agent A tries to edit lines 120-130 → BLOCKED (overlaps with B's lock)
If Agent A tries to edit lines 60-80   → ALLOWED (no overlap)
```

**Line range resolution:**

The extension resolves line ranges differently per tool:

| Tool | Lock Scope | How Resolved |
|------|-----------|-------------|
| `edit` | Lines matching `oldText` | Read file, find `oldText`, compute start/end line |
| `write` | Entire file | All lines (full file replacement) |
| `bash` | No lock | Shell commands are not tracked (user responsibility) |

**Line shift tracking:**

When an edit inserts or deletes lines, all other locks on the same file have their line ranges adjusted:

- Lines inserted above a lock → lock's start/end shift down by the inserted line count
- Lines deleted above a lock → lock's start/end shift up by the deleted line count
- This ensures locks stay accurate relative to the content they protect

**Lock data structure:**

```typescript
interface LineRangeLock {
  filePath: string;
  startLine: number;       // 1-based inclusive
  endLine: number;         // 1-based inclusive
  agent: string;
  session: string;
  taskId: string;
  rootTaskId: string;
  since: number;
  description?: string;   // human-readable: "refactoring imports"
}
```

**Overlap detection:**

Two locks conflict if they are on the same file AND their line ranges overlap:

```typescript
function rangesOverlap(a: LineRangeLock, b: LineRangeLock): boolean {
  if (a.filePath !== b.filePath) return false;
  if (a.agent === b.agent) return false; // same agent can overlap own locks
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}
```

### 3.6 Task Lifecycle & Concurrency

Each agent can handle multiple tasks concurrently:

- **Default concurrency:** 3 tasks (configurable via `maxConcurrentTasks` in config).
- Tasks run in the **background** — the agent's listener is never blocked.
- Incoming messages, clarification questions, and kill commands are always received immediately, even while tasks are running.
- If the LLM crashes or freezes on one task, other tasks and the listener continue unaffected.
- If an agent is at capacity (all slots full), new tasks queue until a slot frees up.

```json
{
  "maxConcurrentTasks": 3
}
```

**Task states:**

```
queued → running → completed
                 → failed
                 → reassigned (sent back to manager)
                 → waiting_for_answer (asked origin a question)
                 → killed (instructor or manager cancelled)
```

### 3.7 Task Intake — Idle-Aware Injection

When a remote task arrives at an agent:

1. Check if the agent is idle (`ctx.isIdle()`).
2. If idle → inject the task immediately via `pi.sendUserMessage()`.
3. If busy → queue the task and show a widget: `📬 2 remote tasks waiting`.
4. When the agent finishes its current work → inject the next queued task.

This prevents context pollution — two unrelated conversations never get tangled in the same turn.

### 3.8 Two-Way Clarification

Any agent in the chain can ask a clarifying question and get an answer before continuing:

```
Worker → asks question → Manager → answers (or asks Instructor) → answer flows back to Worker
```

- Worker calls `ask_origin({ question: "Which auth module?" })`.
- Question routes through the chain to the sender (one hop back).
- If the sender (manager) knows the answer → responds directly.
- If the manager is unsure → routes question further up to its sender (instructor).
- If the instructor is unsure → asks the human user via Pi's TUI.
- Answer flows back down the chain to the asking worker.
- Worker's task is paused until the answer arrives (slot stays occupied).

### 3.9 Task Reassignment

If a worker cannot complete a task:

1. Worker sends the task back to its manager with `return_task({ reason: "need devops specialist" })`.
2. Manager receives the returned task.
3. Manager decides:
   - **Reassign** to a better-suited worker: `remote_task({ peer: "vps", task: ... })`.
   - **Do it themselves**: inject the task into their own session.
   - **Ask instructor**: route up the chain via `ask_origin`.
4. The task envelope records the reassignment in the chain.
5. Partial work done by the first worker is included in the forwarded envelope.

### 3.10 Result Routing

```
Instructor → Manager → Worker A
                    → Worker B

Worker A finishes → sends result to Manager
Worker B finishes → sends result to Manager
Manager consolidates → sends consolidated result to Instructor
```

The `deliverTo` field in the envelope ensures results always flow uphill through the chain.

---

## 4. Tools (Pi Extension)

The extension registers the following tools for the LLM:

### 4.1 `remote_task`

Send a task to a remote agent.

| Parameter | Type | Description |
|---|---|---|
| `peer` | string | Peer name from config |
| `task` | string | The task description |
| `mode` | string (optional) | `"agent"` (default), `"inbox"`, `"raw"` |

**Modes:**
- `agent` — Full LLM processing on receiver (costs tokens on receiver)
- `inbox` — Token-free notification, stored in inbox for user review
- `raw` — Token-free command execution, output returned directly

**Returns:** Acknowledgment (fire-and-forget delivery). Results arrive asynchronously via `pi.sendMessage()`.

### 4.2 `broadcast_task`

Send a task to all online peers (or a filtered subset).

| Parameter | Type | Description |
|---|---|---|
| `task` | string | The task description |
| `filter` | string (optional) | Filter peers by capability or tag |
| `mode` | string (optional) | `"agent"`, `"inbox"`, `"raw"` |

### 4.3 `send_file`

Send a file to a remote agent.

| Parameter | Type | Description |
|---|---|---|
| `peer` | string | Peer name |
| `path` | string | Local file path |
| `remotePath` | string (optional) | Destination path on remote |

Token-free. Uses direct HTTP (Tailscale) or relay upload (server mode).

### 4.4 `peer_status`

Check status of one or all remote agents.

| Parameter | Type | Description |
|---|---|---|
| `peer` | string (optional) | Specific peer, or all if omitted |

Shows: status (🟢 online / 🟡 busy / 🔴 offline), role, session name, capabilities, queue depth, Tailscale IP, bridge status.

### 4.5 `list_locks`

Show all active line-range locks across the network.

```
list_locks()
list_locks({ path: "./src/app.ts" })  // filter by file
```

| Parameter | Type | Description |
|---|---|---|
| `path` | string (optional) | Filter to a specific file |

Output:
```
🔒 ./src/app.ts
   lines 1-50     → laptop/build (since 14:32) — "refactoring imports"
   lines 120-180  → vps/deploy (since 14:33) — "updating utilities"
🔒 ./src/config.ts
   lines 10-30    → vps/deploy (since 14:34) — "database config"
```

### 4.6 `request_file_lock`

Wait for a line-range lock to become available.

```
request_file_lock({ path: "./src/app.ts", startLine: 1, endLine: 50 })
request_file_lock({ path: "./src/app.ts", startLine: 120, endLine: 180, timeout: 120 })
```

| Parameter | Type | Description |
|---|---|---|
| `path` | string | File to lock |
| `startLine` | number (optional) | Start line, 1-based inclusive (default: 1) |
| `endLine` | number (optional) | End line, 1-based inclusive (default: last line = entire file) |
| `description` | string (optional) | Human-readable reason for the lock |
| `timeout` | number (optional) | Max seconds to wait (default: 300) |

If `startLine` and `endLine` are omitted, locks the entire file (backward compatible with full-file locking).

### 4.7 `task_history`

View all tasks across the network — sent, received, pending, running, completed, or failed.

```
task_history()
task_history({ status: "running" })
task_history({ peer: "vps" })
task_history({ taskId: "task-abc123" })
```

| Parameter | Type | Description |
|---|---|---|
| `status` | string (optional) | Filter: `queued`, `running`, `completed`, `failed`, `killed`, `reassigned` |
| `peer` | string (optional) | Filter by peer name |
| `taskId` | string (optional) | Look up a specific task |

Output:
```
📋 Task History

📤 Sent:
  task-abc123  → vps       running    "deploy to production"    2 min ago
  task-abc124  → laptop    completed  "run test suite"          5 min ago

📥 Received:
  task-abc125  ← desktop   queued     "check docker"            just now
  task-abc126  ← desktop   completed  "refactor auth"           1 hour ago
```

### 4.8 `ask_origin`

Ask a clarifying question to the sender of the current task. Routes through the chain. Pauses the current task until answered.

```
ask_origin({ question: "Which auth module should I refactor? auth.ts or auth-v2.ts?" })
```

| Parameter | Type | Description |
|---|---|---|
| `question` | string | The question to ask |

### 4.9 `kill_task`

Kill a queued or running task on any agent in the network. Only the instructor or a manager can kill tasks.

```
kill_task({ taskId: "task-abc123" })
kill_task({ taskId: "task-abc123", peer: "vps" })
```

| Parameter | Type | Description |
|---|---|---|
| `taskId` | string | The task to kill |
| `peer` | string (optional) | Which agent to kill it on (default: all agents in chain) |

### 4.10 `return_task`

Worker returns a task to its manager because it cannot complete it. Includes partial work.

```
return_task({ reason: "this needs devops expertise, I only do frontend" })
```

| Parameter | Type | Description |
|---|---|---|
| `reason` | string | Why the task is being returned |

### 4.11 `sync_project`

Git-based project sync between agents. Pushes code to a shared bare repo over Tailscale so the worker can pull the latest version. Token-free.

```
sync_project({ peer: "laptop", path: "~/projects/my-app", branch: "feature-oauth" })
```

| Parameter | Type | Description |
|---|---|---|
| `peer` | string | Peer to sync with |
| `path` | string | Local project path (must be a git repo) |
| `branch` | string (optional) | Branch to push/pull (default: current branch) |

**Flow:**
1. Manager: `git push` to bare repo over Tailscale (token-free raw command)
2. Worker: `git pull` from bare repo (token-free raw command)
3. Worker has full codebase locally, can read files and run tests
4. Worker: does work, commits, `git push` back
5. Manager: `git pull` to collect results

**Setup (one-time):**
```bash
# On manager machine
mkdir -p ~/git-remote
# For each project
cd ~/projects/my-app
git init --bare ~/git-remote/my-app.git
git remote add shared ~/git-remote/my-app.git
```

**Worker config:**
```json
{
  "sharedRepos": {
    "my-app": "ssh://desktop/~/git-remote/my-app.git"
  }
}
```

### 4.12 `send_vault`

Send encrypted secrets to a remote agent. Secrets never touch git or travel in plaintext.

```
send_vault({ peer: "vps", secrets: ["prod_db_password", "deploy_token"] })
```

| Parameter | Type | Description |
|---|---|---|
| `peer` | string | Peer to send secrets to |
| `secrets` | string[] | Names of secrets from local vault to send |

**Security:**
- Secrets are encrypted with a network-wide `vaultKey` (set once in config on each machine)
- Encrypted payload sent over Tailscale HTTP (double-encrypted: app-level AES + WireGuard)
- Worker decrypts with same key, injects as env vars during task
- Temporary secrets deleted from worker's vault after task completes
- Secrets **never** go through git, relay, or LLM prompts

### 4.13 `manage_agent`

Update the agent registry (capabilities, roles, hierarchy).

| Parameter | Type | Description |
|---|---|---|
| `action` | enum | `"register"`, `"update"`, `"remove"`, `"list"` |
| `name` | string (optional) | Agent name |
| `role` | string (optional) | `"manager"` or `"worker"` |
| `capabilities` | string[] (optional) | Capabilities list |
| `specialties` | string[] (optional) | Specialties list |
| `manages` | string[] (optional) | Workers this manager oversees |
| `reportTo` | string (optional) | Manager this worker reports to |

---

## 5. System Prompt Injection

On every turn, the extension injects a section into the system prompt:

```
## 🌐 Agent Network (TAILSCALE mode)

Connected via Tailscale VPN. All peers reachable directly.

### 🟢 Online (idle)
- 👤 **laptop** (worker) — coding, design, testing | css, react, ui-testing

### 🟡 Online (busy)
- 👤 **vps** (worker) — 1 task running, 1 queued | devops, docker, nginx

### 🔴 Offline (tasks will be queued)
- ~~**staging**~~ (worker) — testing | integration-testing

### Delegation
- Use `remote_task` to delegate to any agent by name
- Match task to agent specialties
- Use `peer_status` for detailed status
- Use `list_locks` to check file conflicts
```

This allows the LLM to make delegation decisions without additional tool calls.

---

## 6. Offline Handling

### 6.1 Outbox

When a peer is offline, tasks are queued to a persistent local outbox:

```
~/.pi/agent/bridge/
  outbox/
    laptop.jsonl      ← pending tasks for laptop
    vps.jsonl         ← pending tasks for vps
  inbox/
    desktop.jsonl     ← received messages from desktop
  files/
    task-abc123/      ← received files grouped by task
```

### 6.2 Retry Loop

A background process checks offline peers at a configurable interval (default: 5 minutes):

1. Read outbox for each peer.
2. Ping the peer (Tailscale: direct HTTP; Server: `/status` endpoint).
3. If peer is online, flush the queue.
4. If mid-flush fails, stop and retry next cycle.

### 6.3 Dead Letter

Messages that remain undelivered after a configurable deadline (default: 48 hours) are moved to a dead letter directory and the user is notified.

### 6.4 Configurable Settings

| Setting | Default | Description |
|---|---|---|
| `pollInterval` | 3000 ms | How often to check for incoming messages (server mode) |
| `retryInterval` | 300 sec | How often to retry offline peers |
| `deadLetterHours` | 48 | Hours before undelivered messages expire |
| `taskTimeout` | 600 sec | Seconds before a remote task is considered timed out |
| `maxQueueSize` | 50 | Max messages per peer outbox |
| `maxConcurrentTasks` | 3 | Max tasks an agent processes simultaneously |
| `vaultKey` | — | Network-wide encryption key for secret transfers (set once) |

---

## 7. File Transfer

### 7.1 Token-Free

File transfers never touch the LLM. They are pure HTTP transport:
- **Sender:** Reads file, base64 encodes, POSTs to peer's bridge or relay.
- **Receiver:** Decodes, saves to disk, shows notification (via `pi.sendMessage` with `customType`, not an LLM prompt).

### 7.2 Large Files

- Files are transferred as binary payloads over HTTP, not embedded in prompts.
- Relay server stores files on disk and serves them for download.
- Files travel with task results through the chain of custody.

### 7.3 Files in Results

When a worker finishes a task that created/modified files:
1. Worker captures the files (tracked via `lockScope` in the envelope).
2. Files are uploaded to the relay or sent directly to the manager.
3. Manager consolidates files from all workers.
4. Manager sends consolidated result + all files to the instructor.
5. Instructor's Pi saves files to `~/.pi/agent/bridge/files/{rootTaskId}/`.

---

## 8. Hierarchy & Chain of Custody

### 8.1 Manager Role

- Receives tasks from instructors or other managers.
- Delegates to workers based on capability matching.
- Waits for all sub-tasks to complete.
- Consolidates results from all workers into a single response.
- Forwards consolidated result upstream.

### 8.2 Worker Role

- Receives tasks from its manager.
- Executes the task using its full LLM + tools.
- Returns result and any created files to the manager.
- Can only see its manager in the network (limited visibility).

### 8.3 Chain of Custody Guarantee

Every task tracks:

1. **Origin** — Who originally gave the command (instructor + session).
2. **Chain** — Every agent that handled the task, in order.
3. **Deliver-to** — Where results should be sent (always one hop back in the chain).
4. **Consolidation** — Whether the current agent needs to wait for all sub-tasks and merge results.

**No work is lost.** Even if a worker delegates to another worker, the result eventually flows back through the entire chain to the original instructor.

---

## 9. Claude Code Integration

### 9.1 Architecture

Claude Code does not have an extension API or persistent listener. Integration works through:

1. **Claude Bridge Server** — A small Node.js HTTP server on the Claude Code machine.
2. **MCP Server** — Exposes `remote_task`, `send_file`, `check_inbox`, `list_peers` as MCP tools.

### 9.2 Claude as Worker

When Pi sends a task to a Claude Code peer:

```
Pi → (Tailscale/Server) → Claude Bridge → runs `claude -p "task"` → captures output → sends result back
```

- The bridge runs Claude Code in `--print` mode as a subprocess.
- `--continue` flag maintains context across sequential tasks.
- Results are sent back to the calling Pi via the same transport.

### 9.3 Claude as Boss

Claude Code can also initiate tasks via MCP tools:

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "pi-network": {
      "command": "node",
      "args": ["/path/to/pi-network/mcp-server.js"]
    }
  }
}
```

### 9.4 Subscription Transparency

The bridge runs `claude -p` which is the official CLI making direct API calls from the user's machine. From Anthropic's perspective, this is identical to the user typing in the terminal. No third-party app is wrapping or proxying the API.

### 9.5 Limitations

- Claude Code cannot be injected into a running TUI session (no `sendUserMessage` equivalent).
- Claude Code cannot participate in file locking (no tool interception).
- Claude Code tasks are one-shot (`claude -p`) rather than persistent sessions.
- Claude Code visibility is limited to `check_inbox` rather than real-time TUI.

---

## 10. Relay Server

### 10.1 Purpose

The relay server handles:
- **Message queue** — Store-and-forward for offline peers.
- **Agent registry** — Central source of truth for capabilities, roles, hierarchy.
- **File locks** — Distributed lock coordination across agents.
- **File store** — Temporary storage for files in transit.
- **Task chain state** — Track which tasks are pending, who owes what to whom.
- **WebSocket hub** — Instant delivery for connected server-mode agents.

The relay does NOT:
- Run any AI models.
- Process prompts.
- Store API keys.
- Act as a proxy for LLM calls.

### 10.2 Deployment

- Runs as a Node.js process on a VPS.
- Accessible at a public IP or domain on port 9765.
- TLS via Caddy reverse proxy (recommended) or direct HTTPS.
- Docker and systemd deployment supported.

### 10.3 API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/register` | Register/heartbeat an agent |
| POST | `/deregister` | Mark agent offline |
| POST | `/send` | Send message to a peer |
| GET | `/inbox` | Poll inbox for messages |
| POST | `/ack` | Acknowledge processed message |
| GET | `/status` | Check peer online status |
| GET | `/health` | Server health check |
| POST | `/file/upload` | Upload file for a peer |
| GET | `/file/download` | Download file by ID |
| POST | `/lock/acquire` | Acquire file lock |
| POST | `/lock/release` | Release file lock |
| POST | `/lock/release-task` | Release all locks for a task |
| GET | `/locks` | List all active locks |
| GET | `/registry` | Get full agent registry |
| GET | `/registry/version` | Get registry version number |
| POST | `/registry/update` | Update an agent's registry entry |
| WebSocket | `/ws` | Real-time message delivery |

### 10.4 Cleanup

- Peers not seen in 30 seconds are marked offline.
- Acked messages older than 5 minutes are deleted.
- File locks older than 1 hour are auto-released (safety net).
- Peers not seen in 48 hours are removed from registry.
- Stored files older than 7 days are deleted.

---

## 11. Configuration

### 11.1 Config File

Location: `~/.pi/agent/bridge/config.json`

```jsonc
{
  // ─── Identity (required) ───
  "localName": "desktop",
  "bridgePort": 9764,

  // ─── Role & Capabilities (required) ───
  "role": "manager",                         // "manager" | "worker"
  "capabilities": ["coding", "architecture"],
  "specialties": ["typescript", "python"],
  "manages": ["laptop", "vps"],              // for managers
  "reportTo": null,                          // for workers

  // ─── Network Mode (auto-detected if omitted) ───
  // "mode": "tailscale",

  // ─── Server Config (only for server/hybrid mode) ───
  // "server": {
  //   "url": "https://bridge.example.com:9765",
  //   "apiKey": "your-secret-key"
  // },

  // ─── Timing ───
  "pollInterval": 3000,
  "retryInterval": 300,
  "deadLetterHours": 48,
  "taskTimeout": 600,
  "maxQueueSize": 50,

  // ─── Peers ───
  "peers": {
    "desktop": { "type": "pi" },
    "laptop":  { "type": "pi" },
    "vps":     { "type": "pi" },
    "cloud-worker": { "type": "pi", "forceServer": true },
    "claude-laptop": { "type": "claude", "bridgePort": 9766 }
  }
}
```

### 11.2 Local Data

```
~/.pi/agent/bridge/
  config.json              # Agent configuration
  agents-cache.json        # Cached registry from relay
  outbox/                  # Pending outgoing messages
    laptop.jsonl
    vps.jsonl
  inbox/                   # Received messages (token-free)
    desktop.jsonl
  files/                   # Received files grouped by task
    task-abc123/
      auth.ts
      Dockerfile
  dead-letter/             # Expired undelivered messages
  vault.json               # Encrypted local secrets vault
  task-history.jsonl       # Persistent task audit log
  locks-cache.json         # Local cache of file locks
```

---

## 12. Token Efficiency

| Operation | Tokens Used | How |
|---|---|---|
| File transfer | **Zero** | HTTP transport, no LLM involved |
| Raw command execution (`mode: "raw"`) | **Zero** | Runs command, returns stdout |
| Notifications (`mode: "inbox"`) | **Zero** | Saved to file, displayed via `pi.sendMessage` |
| Health check / ping | **Zero** | HTTP `/ping` endpoint |
| Registry sync | **Zero** | HTTP fetch, saved to disk |
| File lock check | **Zero** | HTTP or local check |
| Queue management | **Zero** | File I/O only |
| Agent task (`mode: "agent"`) | **Receiver's tokens** | Full LLM processing on receiver |
| LLM delegation decision | **Sender's tokens** | Included in system prompt (minimal) |
| LLM reading results | **Sender's tokens** | Result injected via `pi.sendMessage` |

---

## 13. Error Handling

| Scenario | Behavior |
|---|---|
| Peer offline during send | Queue in outbox, retry on interval |
| Peer goes offline mid-task | Task continues on receiver, result queued for delivery |
| Task times out | Notify sender with partial results if available |
| File lock conflict | Block the `write`/`edit` tool call with a message |
| Lock expires (1 hour safety net) | Auto-release, next agent can acquire |
| Relay server unreachable | Fall back to local queue (tailscale/hybrid) or retry (server) |
| WebSocket disconnects | Auto-reconnect after 3 seconds |
| Claude Bridge crash | Task fails, error returned to sender |
| Large result (>50KB) | Truncate in message, save full result as file |
| Dead letter (48h undelivered) | Move to dead-letter directory, notify user |
| Concurrent tasks on same receiver | Queue on receiver, process up to `maxConcurrentTasks` in parallel |
| Worker cannot complete task | `return_task` to manager, manager reassigns or handles |
| Instructor closes Pi before result arrives | Result queued, delivered when instructor comes back online (retry every `retryInterval`) |
| Worker needs clarification | `ask_origin` routes question through chain, task pauses until answered |
| Instructor wants to cancel | `kill_task` kills task on any agent in the network |
| Agent LLM crashes during task | Other tasks and listener unaffected (background execution) |

---

## 14. Project Structure

```
pi-network/
├── src/
│   ├── extension.ts              # Pi extension entry point
│   ├── claude-bridge.ts          # Claude Code bridge server
│   ├── relay.ts                  # Relay server (deploy to VPS)
│   ├── mcp-server.ts             # MCP tools for Claude Code
│   ├── transport/
│   │   ├── index.ts              # Transport factory + interface
│   │   ├── tailscale.ts          # Direct HTTP over Tailscale
│   │   ├── server.ts             # WebSocket + polling via relay
│   │   ├── hybrid.ts             # Tailscale + server fallback
│   │   └── local.ts              # LAN-only fallback
│   ├── core/
│   │   ├── config.ts             # Config loading + mode detection
│   │   ├── registry.ts           # Agent registry management
│   │   ├── locks.ts              # Distributed line-range locking
│   │   ├── queue.ts              # Offline message queue
│   │   ├── tasks.ts              # Task envelope + chain of custody
│   │   ├── concurrency.ts        # Concurrent task manager (N slots)
│   │   ├── clarification.ts      # Two-way clarification routing
│   │   ├── reassignment.ts       # Task return + reassignment logic
│   │   ├── project-sync.ts       # Git-based project sync
│   │   ├── vault.ts              # Encrypted secret management
│   │   ├── task-history.ts       # Task audit log + history
│   │   ├── files.ts              # File transfer + storage
│   │   └── prompt.ts             # System prompt builder
│   └── tools/
│       ├── remote-task.ts        # remote_task tool
│       ├── send-file.ts          # send_file tool
│       ├── broadcast.ts          # broadcast_task tool
│       ├── peer-status.ts        # peer_status tool
│       ├── list-locks.ts         # list_locks tool
│       ├── request-lock.ts       # request_file_lock tool
│       ├── task-history.ts       # task_history tool
│       ├── ask-origin.ts         # ask_origin tool
│       ├── kill-task.ts          # kill_task tool
│       ├── return-task.ts        # return_task tool
│       ├── sync-project.ts      # sync_project tool
│       ├── send-vault.ts         # send_vault tool
│       └── manage-agent.ts       # manage_agent tool
├── deploy/
│   ├── docker-compose.yml        # Docker deployment
│   ├── Caddyfile                 # TLS reverse proxy config
│   └── pi-bridge.service         # systemd unit file
├── config/
│   ├── config.tailscale.json     # Example: Tailscale mode
│   ├── config.server.json        # Example: Server mode
│   ├── config.hybrid.json        # Example: Hybrid mode
│   └── config.local.json         # Example: Local-only mode
├── package.json
├── tsconfig.json
├── PRD.md                        # This document
├── README.md                     # User-facing documentation
└── LICENSE
```

---

## 15. Milestones

### Phase 1: Core Mesh
- [ ] Pi extension with transport layer
- [ ] Tailscale mode (direct HTTP)
- [ ] `remote_task` tool (fire-and-forget + async result delivery)
- [ ] `send_file` tool (token-free)
- [ ] `peer_status` tool
- [ ] Basic system prompt injection (peer list + capabilities)
- [ ] Local outbox + retry loop
- [ ] Session-aware result routing

### Phase 2: Server Mode
- [ ] Relay server (message queue + registry + WebSocket)
- [ ] Server transport (WebSocket + polling fallback)
- [ ] Hybrid transport (tailscale direct + server fallback)
- [ ] Auto mode detection
- [ ] TLS deployment (Caddy + Let's Encrypt)
- [ ] Docker + systemd deployment

### Phase 3: Coordination
- [ ] Distributed line-range locking
- [ ] `list_locks` + `request_file_lock` tools
- [ ] Task envelope with chain of custody
- [ ] Manager consolidation (wait for all sub-tasks, merge results)
- [ ] `broadcast_task` tool
- [ ] File attachment in results
- [ ] Dead letter handling
- [ ] Idle-aware task injection (wait for agent to be idle)
- [ ] Concurrent task execution (configurable slots, default 3)
- [ ] Background execution (listener always free, LLM crash isolation)

### Phase 3.5: Communication & Control
- [ ] `task_history` tool (audit log of all tasks across network)
- [ ] `ask_origin` tool (two-way clarification through chain, human fallback)
- [ ] `kill_task` tool (instructor can kill any task on any agent)
- [ ] `return_task` tool (worker returns task to manager, manager reassigns)
- [ ] Agent load status (🟢 online / 🟡 busy / 🔴 offline)
- [ ] Result persistence (wait for offline instructor, configurable retry interval)

### Phase 4: Intelligence & Project Sync
- [ ] Agent registry on relay (capabilities, roles, hierarchy)
- [ ] Registry push to all agents on update
- [ ] Smart system prompt (online/busy/offline, capabilities, load, delegation hints)
- [ ] `manage_agent` tool (register/update/remove agents)
- [ ] Auto-registration on startup (self-declare capabilities)
- [ ] Tailscale status integration (native peer discovery)
- [ ] `sync_project` tool (git-based project sync over Tailscale)
- [ ] Project context in task envelopes (cwd, keyFiles list)

### Phase 4.5: Security
- [ ] Encrypted vault system (`vault.json` + network-wide `vaultKey`)
- [ ] `send_vault` tool (encrypted secret transfer, separate from git)
- [ ] Temporary secrets auto-deleted after task completes
- [ ] Secrets never touch git, relay, or LLM prompts

### Phase 5: Claude Integration
- [ ] Claude Bridge server (`claude -p` wrapper)
- [ ] MCP server (`remote_task`, `send_file`, `check_inbox`, `list_peers`)
- [ ] Claude Code settings.json config
- [ ] File receive via inbox directory

### Phase 6: Polish
- [ ] `peer_status` with Tailscale native status
- [ ] Status bar widget (online/offline count)
- [ ] Result streaming (partial results during long tasks)
- [ ] Task cancellation
- [ ] Error recovery and self-healing
- [ ] README with install instructions for all modes
- [ ] Config validation + helpful error messages

---

## 16. Non-Goals

- **Not a replacement for Pi.** Pi Network is an extension, not a standalone agent.
- **Not a multi-agent orchestration framework.** This is specifically for Pi and Claude Code agents.
- **Not a cloud service.** The relay server is self-hosted.
- **Not an LLM proxy.** No AI API calls pass through the relay or bridge.
- **Not a replacement for SSH.** Tailscale handles networking; SSH is used only as a fallback.

---

## 17. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tailscale not installed | Medium | Falls back to server/local mode | Auto-detection with clear messaging |
| Relay server goes down | Low | Server-mode agents lose connectivity | Hybrid mode uses Tailscale as primary; local queue buffers |
| File lock deadlock | Low | Agent stuck waiting for lock | Auto-expire after 1 hour; manual release via tool |
| Task chain breaks (agent crashes) | Medium | Result not delivered | Dead letter detection; retry with backoff |
| Large context from system prompt | Low | Token cost increase | Keep agent descriptions concise (~50 tokens per peer) |
| Security (unauthorized access) | Low | Untrusted agent joins network | Tailscale ACLs + API key auth + allowlist |
| Secret leakage through git | Medium | API keys committed to git | Vault system separates secrets from code; `send_vault` never touches git |
| LLM crash during concurrent task | Low | Task interrupted, slot freed | Background execution isolates tasks; listener always available |
| Stale result delivered late | Medium | Result arrives after user moved on | `task_history` shows pending results; old results clearly timestamped |

---

## 18. Success Metrics

1. **Setup time:** < 5 minutes from install to first task sent (Tailscale mode).
2. **Latency:** < 100ms task delivery on Tailscale LAN, < 500ms via relay.
3. **Reliability:** 99.9% task delivery (with retry) or user notification of failure.
4. **Token efficiency:** Zero tokens for file transfer, raw commands, and notifications.
5. **Visibility:** Full task chain and real-time TUI visibility on every hop.
6. **Offline resilience:** Zero tasks lost due to peer downtime.
