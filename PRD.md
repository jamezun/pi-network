# Pi Network — Product Requirements Document

> **Version:** 1.0.0  
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
5. **File safety** — Distributed file locking prevents concurrent edits.
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
  lockScope: string[];          // files this task intends to touch
  requiresConsolidation: boolean;
  deliverTo: string;            // who gets the result
}

interface ChainHop {
  agent: string;
  session: string;
  role: "instructor" | "manager" | "worker";
  timestamp: number;
}
```

**Guarantee:** Every result traces back through the chain to the original instructor. No work is lost.

### 3.5 File Locking

Distributed file locks prevent concurrent edits:

- Before any `write` or `edit` tool call, the extension checks if the file is locked.
- Locks are stored on the relay server (server/hybrid mode) or tracked locally (tailscale mode).
- Locks are scoped to a `rootTaskId` and released when the task chain completes.
- Auto-expire after 1 hour as a safety net.
- Agents can request a lock with a timeout using `request_file_lock` tool.

### 3.6 Result Routing

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

Shows: online/offline, role, session name, capabilities, Tailscale IP, bridge status.

### 4.5 `list_locks`

Show all active file locks across the network.

### 4.6 `request_file_lock`

Request a lock on a file, blocking until available or timeout.

| Parameter | Type | Description |
|---|---|---|
| `path` | string | File path to lock |
| `timeout` | number (optional) | Max seconds to wait (default: 300) |

### 4.7 `manage_agent`

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

### 🟢 Online
- 👤 **laptop** (worker) — coding, design, testing | css, react, ui-testing
- 👤 **vps** (worker) — devops, deployment | docker, nginx, linux

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
| Concurrent tasks on same receiver | Queue on receiver, process sequentially |

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
│   │   ├── locks.ts              # Distributed file locking
│   │   ├── queue.ts              # Offline message queue
│   │   ├── tasks.ts              # Task envelope + chain of custody
│   │   ├── files.ts              # File transfer + storage
│   │   └── prompt.ts             # System prompt builder
│   └── tools/
│       ├── remote-task.ts        # remote_task tool
│       ├── send-file.ts          # send_file tool
│       ├── broadcast.ts          # broadcast_task tool
│       ├── peer-status.ts        # peer_status tool
│       ├── list-locks.ts         # list_locks tool
│       ├── request-lock.ts       # request_file_lock tool
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
- [ ] Distributed file locking
- [ ] `list_locks` + `request_file_lock` tools
- [ ] Task envelope with chain of custody
- [ ] Manager consolidation (wait for all sub-tasks, merge results)
- [ ] `broadcast_task` tool
- [ ] File attachment in results
- [ ] Dead letter handling

### Phase 4: Intelligence
- [ ] Agent registry on relay (capabilities, roles, hierarchy)
- [ ] Registry push to all agents on update
- [ ] Smart system prompt (online/offline, capabilities, delegation hints)
- [ ] `manage_agent` tool (register/update/remove agents)
- [ ] Auto-registration on startup (self-declare capabilities)
- [ ] Tailscale status integration (native peer discovery)

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

---

## 18. Success Metrics

1. **Setup time:** < 5 minutes from install to first task sent (Tailscale mode).
2. **Latency:** < 100ms task delivery on Tailscale LAN, < 500ms via relay.
3. **Reliability:** 99.9% task delivery (with retry) or user notification of failure.
4. **Token efficiency:** Zero tokens for file transfer, raw commands, and notifications.
5. **Visibility:** Full task chain and real-time TUI visibility on every hop.
6. **Offline resilience:** Zero tasks lost due to peer downtime.
