# Pi Network

> Turn multiple Pi coding agents into a coordinated agent mesh. Delegate tasks, transfer files, and route results — all from your Pi terminal.

## What It Does

```
You (at Desktop Pi):  "deploy to production and ask laptop to run tests"

Desktop Pi (manager):
  ├── remote_task({ peer: "vps", task: "deploy to production" })
  └── remote_task({ peer: "laptop", task: "run the test suite" })

VPS Pi:     deploys → sends result back to desktop
Laptop Pi:  runs tests → sends result back to desktop

Desktop Pi: "✅ Deployed to production. Tests: 44/45 passing (1 flaky)."
```

**One Pi extension. Any number of machines. Pi or Claude Code.**

## Features

### Core mesh

- 🌐 **Peer-to-peer agent mesh** — Any Pi talks to any other Pi by name
- 🧠 **Smart delegation** — Agents know what other agents are good at
- 📂 **File transfer** — Send files between agents, token-free
- 🔒 **File locking** — Prevent concurrent edits across agents
- 🔗 **Chain of custody** — Every result traces back to the original requester
- 🏗️ **Hierarchy** — Manager and worker roles
- 📴 **Offline queue** — Tasks delivered when peers come back online
- 🐱 **Tailscale by default** — Zero-config if you have Tailscale
- 🌍 **Server mode** — Public relay for machines without Tailscale
- 🤖 **Claude Code integration** — Claude instances participate as workers
- 💰 **Token-efficient** — Files, notifications, and raw commands cost zero tokens

### Safety & observability (v2)

- 🛡️ **Damage control** — YAML rule engine intercepts destructive bash and path operations before they run
- 🔄 **Hop limits** — Bounded forwarding chain (`MAX_HOPS=5`) prevents A↔B delegation loops
- 🔐 **Privacy-respecting audit log** — Records `msg_id`, sender, hops — never task body or secrets
- 🧹 **Self-healing registry** — Atomic per-agent files, PID-based liveness pruning, stale counter
- 📊 **Live pool widget** — Coloured peer cards with context-usage bars, always visible below the editor
- 👥 **Persona files** — Drop a `.md` file in `.pi/agents/` to define an agent's name, color, role, capabilities
- 🎛️ **CLI flags** — `--name`, `--purpose`, `--color`, `--project`, `--explicit` to spawn variants without editing config
- 🧬 **Multi-project namespacing** — Separate mesh per project; `--project=*` to span all
- ⚡ **Split tools** — `task_send` + `task_get` + `task_await` for fire-and-forget, poll, or block patterns
- 🧪 **Optional response schema** — Request JSON-shaped replies from a peer
- 🆔 **ULID message IDs** — Time-sortable, debug-friendly
- 💬 **`/network` slash command** — Live status, `--prune`, `--all` for multi-project view

---

## What Problems It Solves

| Problem | Without Pi Network | With Pi Network |
|---|---|---|
| Two agents on the same code | Copy-paste between terminals | `remote_task` — answer lands in your chat |
| Long-running work blocks main agent | One context, one job | `task_send` + `task_await`, keep working |
| Concurrent edits collide | Lost work | Per-line-range locks, distributed via the relay |
| Delegation loop A→B→A→B | Runs until killed | Hop limit rejects past `MAX_HOPS=5` |
| Peer crashes silently | Phantom entries | PID pruning + stale counter mark them offline |
| Audit logs leak secrets | Full task text on disk | Audit log only stores metadata |
| Remote agent runs `rm -rf` on shared mount | One bad prompt, lost data | Damage Control blocks or asks before executing |
| Per-role peer setup | Hardcode + restart | Drop a `.pi/agents/coder.md` persona file |
| Cross-project peer collisions | Single shared namespace | `project` flag isolates them |

---

## Quick Start

### Prerequisites

- [Pi coding agent](https://github.com/badlogic/pi-mono) installed on every machine
- (Optional) [Tailscale](https://tailscale.com) installed and running — recommended
- (Optional) A VPS for the relay server — only needed for non-Tailscale setups
- Node.js 18+

### Install the Extension

On **every Pi machine**:

```bash
# Clone the repo
git clone https://github.com/jamezun/pi-network.git
cd pi-network
npm install

# Copy extension to Pi's extensions directory
mkdir -p ~/.pi/agent/extensions
cp src/extension.js ~/.pi/agent/extensions/pi-network.js

# Create config directory
mkdir -p ~/.pi/agent/bridge
```

### Create Config

```bash
cat > ~/.pi/agent/bridge/config.json << 'EOF'
{
  "localName": "desktop",
  "bridgePort": 9764,
  "role": "manager",
  "capabilities": ["coding", "architecture", "research"],
  "specialties": ["typescript", "python", "system-design"],
  "manages": ["laptop", "vps"],
  "peers": {
    "desktop": { "type": "pi" },
    "laptop":  { "type": "pi" },
    "vps":     { "type": "pi" }
  }
}
EOF
```

### Start Pi

```bash
pi
```

If Tailscale is running, you'll see:

```
🌐 Bridge: TAILSCALE mode (Tailscale: 2 peers)
```

Done. Your Pi now sees all other agents in its system prompt.

---

## Network Modes

Pi Network auto-detects the best mode on startup:

| Mode | When | Transport | Server Needed |
|---|---|---|---|
| **Tailscale** (default) | Tailscale is running | Direct HTTP over WireGuard | No |
| **Server** | No Tailscale, server config present | WebSocket + polling via relay | Yes |
| **Hybrid** | Tailscale + server config | Tailscale direct, server fallback | Yes |
| **Local** | Neither | Direct HTTP on LAN only | No |

---

## CLI Flags (v2)

Override the config without editing files. Useful for running multiple seats on the same machine or for one-off experiments.

```bash
pi --name=planner --purpose="Plans the work" --color="#36F9F6"
pi --name=coder   --purpose="Writes the code" --color="#FF7EDB" --project=app
pi --name=prod-pii-redactor --explicit                 # hidden from auto-discovery
```

| Flag | Type | Purpose |
|---|---|---|
| `--name=NAME` | string | Override `localName` |
| `--purpose=TEXT` | string | Short label shown in the pool widget |
| `--project=NAME` | string | Namespace this peer to a project; isolates it from other meshes |
| `--color=#RRGGBB` | string | Card color in the pool widget |
| `--explicit` | bool | Hide from auto-discovery — peers must address by exact name |

Flags override config.json values, which in turn override `.pi/agents/*.md` persona defaults.

---

## Personas (v2)

Define agents declaratively with `.md` files. Drop one into `.pi/agents/` (project) or `~/.pi/agents/` (global). The persona's `name` is matched against `localName`; if it matches, its frontmatter and body are applied automatically.

**Example: `.pi/agents/planner.md`**

```markdown
---
name: planner
description: Plans the work, breaks problems down, reviews specs
color: "#36F9F6"
role: manager
capabilities: planning, architecture, system-design
specialties: code-review, refactoring
explicit: false
---

You are the planner. Decompose work into concrete, testable units.
Delegate execution to coder, researcher, or verifier — don't write code yourself.
Always ask for explicit approval before kicking off > 3 parallel tasks.
```

| Frontmatter | What it sets |
|---|---|
| `name` | Match against `localName` to apply |
| `description` / `purpose` | Pool-widget label |
| `color` | Card color (`#RRGGBB`) |
| `role` | `manager` or `worker` |
| `capabilities` | CSV — augments config |
| `specialties` | CSV — augments config |
| `explicit` | `true` to hide from auto-discovery |

Body becomes the persona system prompt addendum.

Search order: `./.pi/agents/` → `~/.pi/agents/` → `~/.pi/agent/bridge/agents-personas/`. First match wins.

---

## Damage Control (v2)

A YAML rule engine intercepts every `tool_call` against your safety rules **before** execution. Catches `rm -rf /`, force-pushes, prod-secret reads, and other catastrophic moves — whether they came from your local agent or were delegated by a remote peer.

### Enable

```jsonc
// ~/.pi/agent/bridge/config.json
{ "damageControl": true }
```

### Rules file

Project-level: `.pi/damage-control-rules.yaml`
Global: `~/.pi/damage-control-rules.yaml`

```yaml
# Hard-block dangerous bash patterns (regex). ask: true to confirm first.
bashToolPatterns:
  - { pattern: "rm\\s+-rf\\s+/",            reason: "Recursive force delete from root", ask: true }
  - { pattern: "git\\s+push\\s+.*--force",  reason: "Force push to remote",             ask: true }
  - { pattern: "DROP\\s+DATABASE",          reason: "SQL drop database" }
  - { pattern: "mkfs\\.",                   reason: "Filesystem format" }
  - { pattern: "dd\\s+.*of=/dev/",          reason: "Raw device write" }

# Zero access — block ALL reads and writes to these paths.
zeroAccessPaths:
  - "~/.ssh/"
  - "~/.aws/"
  - "*.pem"
  - ".env.production"

# Read-only — allow read, block write/edit/bash.
readOnlyPaths:
  - "/etc/"
  - "package-lock.json"
  - "yarn.lock"

# No-delete — allow modification, block rm.
noDeletePaths:
  - ".git/"
  - "Dockerfile"
  - "README.md"
```

### Behaviour

| Verdict | Effect |
|---|---|
| `blocked: false` | Tool call proceeds normally |
| `blocked: true, ask: true` | UI prompts the user; 30s timeout = deny |
| `blocked: true, ask: false` | Hard block with anti-bypass message |

Every block/confirm/deny is recorded in the privacy-respecting audit log — no command bodies stored, only the rule that fired.

A copy of the default rules lives at `config/damage-control-rules.yaml` in this repo.

---

## Slash Commands (v2)

| Command | What it does |
|---|---|
| `/network` | One-shot network status — peers, slots, queues, hop limit |
| `/network --all` | Include every project namespace, not just yours |
| `/network --project=app` | Show only a specific project |
| `/network --prune` | Force a PID-liveness sweep before printing |

---

## Setup Guide

### Mode 1: Tailscale (Recommended)

Best for: Personal machines you own.

**No server needed.** Every machine talks directly to every other machine.

#### Step 1: Install Tailscale on Every Machine

```bash
# Linux
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# macOS
brew install tailscale

# Windows
# Download from https://tailscale.com/download/windows
```

#### Step 2: Install Pi Network on Every Machine

```bash
# On each machine:
git clone https://github.com/jamezun/pi-network.git
cd pi-network
npm install
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/bridge
cp src/extension.js ~/.pi/agent/extensions/pi-network.js
```

#### Step 3: Create Config on Each Machine

**Desktop (manager):**

```json
// ~/.pi/agent/bridge/config.json
{
  "localName": "desktop",
  "bridgePort": 9764,
  "role": "manager",
  "capabilities": ["coding", "architecture", "research"],
  "specialties": ["typescript", "python"],
  "manages": ["laptop", "vps"],
  "peers": {
    "desktop": { "type": "pi" },
    "laptop":  { "type": "pi" },
    "vps":     { "type": "pi" }
  }
}
```

**Laptop (worker):**

```json
{
  "localName": "laptop",
  "bridgePort": 9764,
  "role": "worker",
  "reportTo": "desktop",
  "capabilities": ["coding", "design", "testing"],
  "specialties": ["css", "react", "ui-testing"],
  "peers": {
    "desktop": { "type": "pi" },
    "laptop":  { "type": "pi" },
    "vps":     { "type": "pi" }
  }
}
```

**VPS (worker):**

```json
{
  "localName": "vps",
  "bridgePort": 9764,
  "role": "worker",
  "reportTo": "desktop",
  "capabilities": ["devops", "deployment"],
  "specialties": ["docker", "nginx", "linux", "ci-cd"],
  "peers": {
    "desktop": { "type": "pi" },
    "laptop":  { "type": "pi" },
    "vps":     { "type": "pi" }
  }
}
```

#### Step 4: Tag Machines in Tailscale (Optional Security)

In the [Tailscale admin console](https://login.tailscale.com/admin/acls):

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:pi-agent"],
      "dst": ["tag:pi-agent:*"]
    }
  ],
  "tagOwners": {
    "tag:pi-agent": ["your-email@example.com"]
  }
}
```

Tag each machine: `desktop` → `tag:pi-agent`, `laptop` → `tag:pi-agent`, etc.

#### Step 5: Start Pi on Every Machine

```bash
pi
```

You're connected. Try it:

```
You: "check what agents are available"

Pi calls: peer_status()
→ 🟢 laptop (worker) — coding, design, testing
→ 🟢 vps (worker) — devops, deployment

You: "ask vps to check disk space"

Pi calls: remote_task({ peer: "vps", task: "check disk space" })
→ ✅ Task sent to vps. Results will arrive when done.
...
📬 Result from vps: Disk usage: 47%. 120GB free.
```

---

### Mode 2: Public Server

Best for: Machines without Tailscale, team setups, external collaborators.

Uses a relay server running on a VPS to route all messages.

#### Step 1: Deploy the Relay Server

**On your VPS:**

##### Option A: Docker (recommended)

```bash
git clone https://github.com/jamezun/pi-network.git
cd pi-network

# Set your API key
echo "BRIDGE_API_KEY=your-strong-random-secret-key" > .env

# Start
docker compose up -d
```

##### Option B: systemd

```bash
git clone https://github.com/jamezun/pi-network.git
cd pi-network
npm install --production

# Set environment
export BRIDGE_PORT=9765
export BRIDGE_API_KEY="your-strong-random-secret-key"

# Install as service
sudo cp deploy/pi-bridge.service /etc/systemd/system/
sudo systemctl enable pi-bridge
sudo systemctl start pi-bridge
```

##### Option C: With TLS (recommended for production)

```bash
# Install Caddy
sudo apt install caddy

# Create Caddyfile
cat > /etc/caddy/Caddyfile << 'EOF'
bridge.example.com {
    reverse_proxy localhost:9765
}
EOF

sudo systemctl restart caddy
# TLS is automatic via Let's Encrypt
```

#### Step 2: Verify the Server

```bash
curl https://bridge.example.com/health
# → {"status":"ok","peers":0,"connected":0,"uptime":5}
```

#### Step 3: Configure Agents for Server Mode

On **every Pi machine**, add the server config:

```json
// ~/.pi/agent/bridge/config.json
{
  "localName": "desktop",
  "bridgePort": 9764,
  "role": "manager",
  "capabilities": ["coding", "architecture"],
  "specialties": ["typescript", "python"],
  "manages": ["laptop", "vps"],
  "server": {
    "url": "https://bridge.example.com",
    "apiKey": "your-strong-random-secret-key"
  },
  "peers": {
    "desktop": { "type": "pi" },
    "laptop":  { "type": "pi" },
    "vps":     { "type": "pi" }
  }
}
```

#### Step 4: Start Pi

```bash
pi
```

You'll see:

```
🌐 Bridge: SERVER mode (Server: https://bridge.example.com)
```

All messages route through the relay server.

---

### Mode 3: Hybrid (Tailscale + Server)

Best for: Most machines on Tailscale, some external machines that aren't.

Uses Tailscale direct for peers on the tailnet, relay server for everyone else.

```json
{
  "localName": "desktop",
  "bridgePort": 9764,
  "role": "manager",
  "server": {
    "url": "https://bridge.example.com",
    "apiKey": "your-strong-random-secret-key"
  },
  "peers": {
    "desktop":       { "type": "pi" },
    "laptop":        { "type": "pi" },
    "vps":           { "type": "pi" },
    "cloud-worker":  { "type": "pi", "forceServer": true },
    "friend-machine": { "type": "pi", "forceServer": true }
  }
}
```

- `desktop`, `laptop`, `vps` → direct Tailscale HTTP (fast)
- `cloud-worker`, `friend-machine` → via relay server (anyone, anywhere)

---

## Claude Code Setup

Claude Code participates as a worker in the network through a bridge server.

### How It Works

```
Pi sends task → (network) → Claude Bridge on laptop → runs `claude -p "task"` → captures output → sends result back to Pi
```

Claude Code runs natively on the machine. The bridge just automates typing `claude -p`. From Anthropic's perspective, it's normal Claude Code CLI usage — no third-party proxying.

### Step 1: Install the Claude Bridge

On the **Claude Code machine**:

```bash
git clone https://github.com/jamezun/pi-network.git
cd pi-network
npm install

# Copy Claude bridge
mkdir -p ~/claude-bridge
cp src/claude-bridge.js ~/claude-bridge/
cp config/config.claude-bridge.json ~/claude-bridge/config.json
```

### Step 2: Configure the Claude Bridge

```json
// ~/claude-bridge/config.json
{
  "localName": "claude-laptop",
  "bridgePort": 9766,
  "role": "worker",
  "reportTo": "desktop",
  "capabilities": ["research", "analysis", "writing"],
  "specialties": ["market-research", "code-review", "documentation"],
  "server": {
    "url": "https://bridge.example.com",
    "apiKey": "your-strong-random-secret-key"
  },
  "peers": {
    "desktop": { "type": "pi" }
  }
}
```

### Step 3: Start the Claude Bridge

```bash
# Tailscale mode:
node ~/claude-bridge/claude-bridge.js

# Server mode:
BRIDGE_API_KEY=your-key node ~/claude-bridge/claude-bridge.js

# Or as a background service:
nohup node ~/claude-bridge/claude-bridge.js &
```

The bridge listens on port 9766. It receives tasks, runs `claude -p`, and sends results back.

### Step 4: Add Claude to Your Pi Network Config

On your **Pi machines**:

```json
{
  "peers": {
    "desktop":       { "type": "pi" },
    "laptop":        { "type": "pi" },
    "vps":           { "type": "pi" },
    "claude-laptop": { "type": "claude", "bridgePort": 9766 }
  }
}
```

### Step 5: Use It

```
You: "ask claude to review the auth module"

Pi calls: remote_task({ peer: "claude-laptop", task: "review the auth module in ~/project/src/auth.ts for security vulnerabilities" })
→ ✅ Task sent to claude-laptop.

... later ...

📬 Result from claude-laptop:
   The auth module has a few security concerns:
   1. Passwords are hashed with MD5 (use bcrypt)
   2. Session tokens don't expire
   3. CSRF protection is missing on login endpoint
```

### Using Claude Code as Boss (MCP Mode)

Claude Code can also initiate tasks through MCP tools.

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "pi-network": {
      "command": "node",
      "args": ["/path/to/pi-network/src/mcp-server.js"],
      "env": {
        "BRIDGE_CONFIG": "/path/to/pi-network/config/config.claude-bridge.json"
      }
    }
  }
}
```

Claude Code now sees these tools:

| Tool | Description |
|---|---|
| `remote_task` | Send a task to a remote Pi agent |
| `send_file` | Send a file to a remote Pi agent |
| `check_inbox` | Check for files and messages from other agents |
| `list_peers` | List all available agents and their status |

---

## Extension Tools Reference

These tools are registered by the Pi extension. Your Pi's LLM calls them automatically.

### `remote_task`

Send a task to a remote agent.

```
remote_task({ peer: "laptop", task: "check if docker is running" })
remote_task({ peer: "vps", task: "restart nginx", mode: "raw" })
remote_task({ peer: "claude-laptop", task: "research React best practices" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `peer` | string | ✅ | Peer name from config |
| `task` | string | ✅ | The task to execute |
| `mode` | string | ❌ | `"agent"` (default), `"raw"`, `"inbox"` |
| `priority` | string | ❌ | `"urgent"`, `"high"`, `"normal"` (default), `"low"` |

**Modes:**
- `"agent"` — Full LLM processing on the receiver. Costs tokens on the receiver's side. Best for complex tasks.
- `"raw"` — Token-free. Runs the task as a shell command, returns stdout. Best for simple checks.
- `"inbox"` — Token-free. Delivers the message to the receiver's inbox for later review. Best for notifications.

**Returns immediately** (fire-and-forget). Results arrive asynchronously in your Pi chat.

---

### `task_send` (v2)

Send a task but **don't wait** — get back a `taskId` and `msg_id` you can poll later. Useful when you want to fire several requests in parallel and decide later which to block on.

```
task_send({ peer: "vps", task: "run the full integration suite" })
// → { taskId: "task-l...", msgId: "01HKM...", delivered: true, hops: 0 }
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `peer` | string | ✅ | Peer name |
| `task` | string | ✅ | The task |
| `mode` | string | ❌ | `"agent"` / `"raw"` / `"inbox"` |
| `priority` | string | ❌ | `"urgent"` / `"high"` / `"normal"` / `"low"` |
| `response_schema` | object | ❌ | JSON Schema describing the expected reply shape |

If you're already inside an inbound task, the returned `hops` increments automatically. Sends are blocked once `hops >= maxHops` (default 5) — kills runaway A→B→A→B loops at the source.

---

### `task_get` (v2)

**Non-blocking** poll on a `taskId` returned by `task_send`. Returns `pending`, `complete`, or `expired` immediately.

```
task_get({ taskId: "task-l..." })
// → "⏳ Pending... (47s elapsed, target: vps)"
// or
// → "✅ Complete from vps: All 124 tests passed."
```

---

### `task_await` (v2)

**Blocking** wait on a `taskId`. Resolves when the reply lands or `timeout_ms` elapses (default 30 min).

```
task_await({ taskId: "task-l...", timeout_ms: 60000 })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | ✅ | from `task_send` |
| `timeout_ms` | number | ❌ | Max wait in ms (default 1 800 000 = 30 min) |

Pattern: `task_send` × N peers, then `task_await` on the first you care about — you get true bidirectional fan-out with zero polling.

---

### `audit_log` (v2)

View the privacy-respecting audit trail. Records only metadata: `msg_id`, sender, target, hops, event type — **never the task body or any secrets**.

```
audit_log()                          // last 20 entries
audit_log({ event: "blocked" })      // damage-control blocks only
audit_log({ event: "hop_exceeded" }) // loops we prevented
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `event` | string | ❌ | Filter: `outbound_prompt`, `inbound_prompt`, `response`, `blocked`, `confirmed`, `hop_exceeded`, `self_heal` |
| `limit` | number | ❌ | Max entries (default 20) |

---

### `send_file`

Send a file to a remote agent. Token-free.

```
send_file({ peer: "vps", path: "./nginx.conf", remotePath: "/etc/nginx/nginx.conf" })
send_file({ peer: "laptop", path: "./report.pdf" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `peer` | string | ✅ | Peer name |
| `path` | string | ✅ | Local file path |
| `remotePath` | string | ❌ | Destination path (default: same as local) |

---

### `broadcast_task`

Send a task to all online agents.

```
broadcast_task({ task: "report your current disk usage" })
broadcast_task({ task: "pull latest code", filter: "devops" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | string | ✅ | The task |
| `filter` | string | ❌ | Filter by capability |
| `mode` | string | ❌ | `"agent"`, `"raw"`, `"inbox"` |

---

### `peer_status`

Check agent status.

```
peer_status()                    // all agents
peer_status({ peer: "vps" })     // specific agent
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `peer` | string | ❌ | Specific peer, or all if omitted |

Output shows: status (🟢 online / 🟡 busy / 🟠 unresponsive / 🔴 offline), role, session name, capabilities, queue depth, IP address, bridge status.

---

### `list_locks`

Show all active file locks across the network.

```
list_locks()
```

Output:
```
🔒 /app/src/auth.ts → laptop/session-abc (since 14:32)
🔒 /app/Dockerfile → vps/session-def (since 14:33)
```

---

### `request_file_lock`

Wait for a file lock to become available.

```
request_file_lock({ path: "./src/auth.ts", timeout: 120 })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | File to lock |
| `timeout` | number | ❌ | Max seconds to wait (default: 300) |

---

### `manage_agent`

Update the agent registry.

```
// Register a new agent
manage_agent({
  action: "register",
  name: "staging",
  role: "worker",
  capabilities: ["testing"],
  specialties: ["integration-testing", "load-testing"],
  reportTo: "desktop"
})

// Update an existing agent
manage_agent({
  action: "update",
  name: "vps",
  specialties: ["docker", "nginx", "kubernetes"]
})

// Remove an agent
manage_agent({ action: "remove", name: "old-server" })

// List all agents
manage_agent({ action: "list" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | enum | ✅ | `"register"`, `"update"`, `"remove"`, `"list"` |
| `name` | string | ❌ | Agent name |
| `role` | string | ❌ | `"manager"` or `"worker"` |
| `capabilities` | string[] | ❌ | What the agent can do |
| `specialties` | string[] | ❌ | What the agent is best at |
| `manages` | string[] | ❌ | Workers this manager oversees |
| `reportTo` | string | ❌ | Manager this worker reports to |

---

### `task_history`

View all tasks — sent, received, pending, running, completed, or failed.

```
task_history()
task_history({ status: "running" })
task_history({ peer: "vps" })
task_history({ taskId: "task-abc123" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | ❌ | Filter: `queued`, `running`, `completed`, `failed`, `killed` |
| `peer` | string | ❌ | Filter by peer name |
| `taskId` | string | ❌ | Look up a specific task |

### `ask_origin`

Ask a clarifying question to the sender of your current task. Routes through the chain (worker → manager → instructor). If no one knows, the human user is asked.

```
ask_origin({ question: "Which auth module? auth.ts or auth-v2.ts?" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `question` | string | ✅ | The question to ask |

### `kill_task`

Kill a queued or running task on any agent. Instructors and managers only.

```
kill_task({ taskId: "task-abc123" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | ✅ | The task to kill |
| `peer` | string | ❌ | Which agent to kill it on (default: all in chain) |

### `return_task`

Return a task to your manager because you can't complete it. Manager decides whether to reassign, handle it, or ask instructor.

```
return_task({ reason: "this needs devops expertise" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | ✅ | Why you're returning the task |

### `sync_project`

Sync a git project to a remote agent. Token-free git push/pull over Tailscale.

```
sync_project({ peer: "laptop", path: "~/projects/my-app", branch: "feature-oauth" })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `peer` | string | ✅ | Peer to sync with |
| `path` | string | ✅ | Local project path (must be a git repo) |
| `branch` | string | ❌ | Branch (default: current branch) |

### `send_vault`

Send encrypted secrets to a remote agent. Never touches git, relay, or LLM.

```
send_vault({ peer: "vps", secrets: ["prod_db_password", "deploy_token"] })
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `peer` | string | ✅ | Peer to send secrets to |
| `secrets` | string[] | ✅ | Names of secrets from your local vault |

---

## Configuration Reference

### Config File

Location: `~/.pi/agent/bridge/config.json`

```jsonc
{
  // ─── Identity (required) ─────────────────────────
  "localName": "desktop",          // Your peer name in the network
  "bridgePort": 9764,              // Port for local bridge listener

  // ─── Role & Capabilities (required) ──────────────
  "role": "manager",               // "manager" | "worker"
  "capabilities": [                // What you can do (broad)
    "coding",
    "architecture",
    "research"
  ],
  "specialties": [                 // What you're best at (specific)
    "typescript",
    "python",
    "system-design"
  ],
  "manages": ["laptop", "vps"],    // Workers you coordinate (managers only)
  "reportTo": null,                // Your manager (workers only)

  // ─── Network Mode (auto-detected if omitted) ─────
  // "mode": "tailscale",          // Force a specific mode

  // ─── Server Config (server/hybrid only) ──────────
  // "server": {
  //   "url": "https://bridge.example.com",
  //   "apiKey": "your-secret-key"
  // },

  // ─── Timing ──────────────────────────────────────
  "pollInterval": 3000,            // ms between inbox polls (server mode)
  "retryInterval": 300,            // seconds between offline peer retries
  "deadLetterHours": 48,           // hours before undelivered messages expire
  "taskTimeout": 600,              // seconds before a task times out
  "maxQueueSize": 50,              // max pending messages per peer
  "maxConcurrentTasks": 3,         // max tasks an agent processes simultaneously
  "heartbeatTimeout": 600,         // seconds with no activity before marked unresponsive
  "vaultKey": "set-a-strong-key",  // network-wide encryption key for secrets
  "userId": "james@company.com",   // your identity (for multi-user support)

  // ─── v2: Safety & Identity ───────────────────────
  "maxHops": 5,                    // Forwarding hop limit (loops blocked beyond this)
  "project": "default",            // Namespace for peer discovery; isolate per repo if needed
  "damageControl": true,           // Enable the YAML rules engine (intercepts every tool_call)
  "color": "#36F9F6",              // Card color in the pool widget
  "purpose": "Plans the work",     // Short label shown next to your name
  "explicit": false,               // true = hide from auto-discovery, addressable by exact name only

  // ─── Peers ───────────────────────────────────────
  "peers": {
    "desktop": {
      "type": "pi"
      // Tailscale: name resolves via MagicDNS automatically
      // Server: routes via relay, no host needed
    },
    "laptop": {
      "type": "pi"
    },
    "vps": {
      "type": "pi"
    },
    "cloud-worker": {
      "type": "pi",
      "forceServer": true          // Force relay even in hybrid mode
    },
    "claude-laptop": {
      "type": "claude",            // Claude Code bridge
      "bridgePort": 9766           // Claude bridge port (default: 9766)
    }
  }
}
```

### Local Data Directory

```
~/.pi/agent/bridge/
  config.json              # Agent configuration
  agents/                  # v2: atomic per-agent registry files (PID-pruned)
    desktop.json
    laptop.json
  outbox/                  # Pending outgoing messages (offline peers)
    laptop.jsonl
    vps.jsonl
  inbox/                   # Received messages (token-free inbox mode)
    desktop.jsonl
  files/                   # Received files grouped by task
    task-abc123/
      auth.ts
      Dockerfile
  vault.json               # Encrypted local secrets vault
  task-history.jsonl       # Persistent task audit log (append-only status updates)
  audit-log.jsonl          # v2: Privacy-respecting audit log (msg_id + sender + hops only)
  dead-letter/             # Expired undelivered messages

# v2 — optional, project-scoped:
.pi/
  agents/                  # Persona .md files for this project
    planner.md
    coder.md
  damage-control-rules.yaml
```

---

## How It Works

### Task Flow

```
1. You tell your Pi to do something that involves another agent
2. Your Pi's LLM calls remote_task({ peer: "vps", task: "..." })
3. Extension sends the task with a chain-of-custody envelope:
   - originInstructor: "desktop"
   - originSession: "James Agent"
   - chain: [desktop → ...]
   - deliverTo: "desktop" (results come back to you)

4. VPS Pi receives the task via HTTP listener
5. Extension injects task into VPS Pi session via pi.sendUserMessage()
6. VPS Pi's LLM processes the task (visible in VPS terminal in real-time)
7. VPS Pi finishes → extension captures result from agent_end
8. Result sent back to desktop via HTTP (direct or relay)
9. Desktop Pi receives result → pi.sendMessage() with triggerTurn
10. Your Pi's LLM sees the result and responds to you
```

### Chain of Custody

Every task tracks its full journey:

```
Task: "build landing page"
  Origin: desktop / "James Agent"

  desktop (manager) → delegates to laptop + vps
    laptop (worker) → builds UI → result + files → back to desktop
    vps (worker) → sets up Docker → result + files → back to desktop

  desktop consolidates both results → sends to origin (desktop / "James Agent")

  You see: consolidated result + all 6 files
```

**No work is lost.** Even if a manager delegates to workers who delegate to other workers, the result always flows back to the original instructor.

### File Locking

When any agent edits a file, it's automatically locked:

```
Agent A: edits /app/auth.ts → 🔒 locked by laptop
Agent B: tries to edit /app/auth.ts → ❌ Blocked: locked by laptop
Agent A: finishes task → lock released → Agent B can proceed
```

Locks auto-expire after 1 hour as a safety net.

### Hop Limit (v2)

Every task envelope carries a `hops` counter, inherited from the inbound prompt that triggered it. `task_send`/`remote_task` increments by 1; receivers reject inbound tasks where `hops >= maxHops` (default 5).

```
desktop (hops=0)
  → laptop (hops=1)
    → vps (hops=2)
      → desktop (hops=3)
        → laptop (hops=4)
          → vps (hops=5) ❌ rejected
```

The audit log records every `hop_exceeded` event so loops are visible after the fact.

### Self-Healing Registry (v2)

Each agent atomically writes its own file under `~/.pi/agent/bridge/agents/<name>.json` (write-to-`.tmp` then `rename`), including its PID. A 60-second loop on every agent runs `process.kill(pid, 0)` against each entry; dead PIDs are unlinked. Failed pings increment a per-peer stale counter that fades the card in the pool widget after 3 misses and marks it offline.

Crash-survivor: a SIGKILL'd Pi disappears from the network within ~60s without any cleanup hooks running.

### Damage Control (v2)

The extension subscribes to Pi's `tool_call` event. Every call — local or triggered by a remote task — is evaluated against the YAML rule set before the tool runs. The rule that fires is stored in the audit log; the rule body and command are not.

Three verdicts: allow, ask (UI prompt with 30s deny-on-timeout), or hard block (with anti-bypass language to dissuade the LLM from creative workarounds).

### System Prompt Injection

Every turn, the extension injects agent info into the system prompt:

```
## 🌐 Agent Network (TAILSCALE mode)

### 🟢 Online
- 👤 **laptop** (worker) — coding, design | css, react, ui-testing
- 👤 **vps** (worker) — devops | docker, nginx, linux

### 🔴 Offline (tasks will be queued)
- ~~**staging**~~ (worker) — testing

### Delegation
- Use `remote_task` to delegate by name
- Match task to agent specialties
```

The LLM uses this to make smart delegation decisions without extra tool calls.

---

## Token Cost

| Operation | Tokens |
|---|---|
| File transfer | **Zero** |
| Raw command (`mode: "raw"`) | **Zero** |
| Notification (`mode: "inbox"`) | **Zero** |
| Health check / ping | **Zero** |
| Registry sync | **Zero** |
| File lock check | **Zero** |
| Queue management | **Zero** |
| Vault transfer (`send_vault`) | **Zero** | Encrypted HTTP, no LLM |
| Git sync (`sync_project`) | **Zero** | Raw git commands |
| Damage-control rule check | **Zero** | Local regex eval, pre-tool |
| Hop-limit check | **Zero** | Counter on envelope |
| Audit log write | **Zero** | Append-only metadata |
| Agent task (`mode: "agent"`) | Receiver's tokens only |
| Delegation decision | ~50 tokens (in system prompt) |
| Reading results | Sender's tokens (result text) |

---

## Troubleshooting

### "No peers online"

**Tailscale mode:**
```bash
# Check if tailscale is running
tailscale status

# Check if you can reach the peer
curl http://laptop:9764/ping

# Check if the bridge is listening on the peer
ssh laptop "curl http://localhost:9764/ping"
```

**Server mode:**
```bash
# Check relay server health
curl https://bridge.example.com/health

# Check if agent is registered
curl -H "Authorization: Bearer your-key" https://bridge.example.com/status
```

### "Task sent but no result"

- Check if the receiver's Pi is in an active session (not idle at prompt)
- Check the receiver's terminal — the task should be visible there
- The task may be queued behind other work — wait for the queue to process

### "File locked by another agent"

```bash
# Check locks from Pi:
list_locks()

# Request the lock:
request_file_lock({ path: "./src/auth.ts", timeout: 120 })

# Or wait — locks auto-expire after 1 hour
```

### "Mode detected incorrectly"

Force a specific mode in config:

```json
{
  "mode": "tailscale"
}
```

### "❌ Hop limit reached" (v2)

You hit `MAX_HOPS=5`. Either the task is genuinely deep (raise `maxHops` in config) or you have an A↔B loop. Check `audit_log({ event: "hop_exceeded" })` for the chain.

### "🛡️ BLOCKED by Damage Control" (v2)

A rule fired against your tool call. Review which rule:

```
audit_log({ event: "blocked", limit: 5 })
```

If the block is wrong, edit `.pi/damage-control-rules.yaml` and restart. Or set `damageControl: false` in config to disable entirely.

### "Phantom peers in /network" (v2)

PID pruning runs every 60s, but you can force it: `/network --prune`. If a peer's `pid` field is missing in `~/.pi/agent/bridge/agents/<name>.json`, it can't be auto-pruned — delete the file manually.

### "task_send returned but task_await hangs" (v2)

Default timeout is 30 minutes. Pass `timeout_ms` to shorten it. If a `pendingTasks` entry is older than 1 hour, the cleanup loop resolves it with a `failed` status — check `task_history({ taskId })`.

---

## Examples

### Delegate a Task

```
You: "ask vps to check the nginx error logs"

Pi calls: remote_task({ peer: "vps", task: "check nginx error logs for errors in the last hour" })

Pi: ✅ Task sent to vps. Results will arrive shortly.

... (30 seconds later) ...

📬 Result from vps/VPS Agent:
   Found 12 errors in the last hour:
   - 8x upstream timeout (backend at :3000 not responding)
   - 4x 502 bad gateway
   
   The backend process appears to have crashed at 13:45 UTC.
   Recommend: restart the backend service.

Pi: Your VPS found that the backend has crashed. Want me to restart it?
```

### Broadcast to All Agents

```
You: "all agents report disk usage"

Pi calls: broadcast_task({ task: "report disk usage", mode: "raw" })

Pi: Here's the disk usage across your network:
- desktop: 45% used (250GB free)
- laptop: 72% used (80GB free)
- vps: 91% used ⚠️ (18GB free)
```

### Send a File

```
You: "send the nginx config to vps"

Pi calls: send_file({ peer: "vps", path: "./nginx.conf", remotePath: "/etc/nginx/nginx.conf" })

Pi: ✅ Sent ./nginx.conf → vps:/etc/nginx/nginx.conf
```

### Fire-and-Forget then Await (v2)

```
You: "kick off the integration suite on vps and the lint check on laptop, keep me posted"

Pi calls:
  task_send({ peer: "vps",    task: "run integration suite" })
  // → taskId=task-l..., msgId=01HKM...
  task_send({ peer: "laptop", task: "run lint + typecheck" })
  // → taskId=task-m..., msgId=01HKN...

Pi continues other work, then:
  task_await({ taskId: "task-l...", timeout_ms: 600000 })
  // ✅ Result from vps: 124/124 passed in 4m37s

  task_get({ taskId: "task-m..." })
  // ⏳ Pending... (90s elapsed, target: laptop)
```

Three primitives — `task_send`, `task_get`, `task_await` — cover fire-and-forget, poll, and block patterns with no extra machinery.

### Persona-Driven Pool (v2)

```bash
# Terminal 1
pi --name=planner --color="#36F9F6"

# Terminal 2
pi --name=coder --color="#FF7EDB" --project=app
```

Pool widget shows both colored cards. Planner can delegate to coder by name with `task_send` — the response lands back in planner's chat.

### Hierarchy Delegation

```
You: "build the API and deploy it"

Desktop Pi (manager):
  → laptop: "build the REST API with Express. Auth module, user CRUD, database models."
  → vps: "prepare Docker deployment for a Node.js API. Create Dockerfile and compose."

... both work simultaneously on different files ...

📬 laptop finished: API built with 12 endpoints. Files: auth.ts, users.ts, models.ts
📬 vps finished: Docker setup ready. Files: Dockerfile, docker-compose.yml, deploy.sh

Desktop Pi consolidates:
  "✅ API built and containerized. 15 files total. Ready to deploy."
```

---

## Architecture Diagram

```
TAILNET (Tailscale mode — default)        PUBLIC SERVER (server mode)
                                            
  desktop ◄──────► laptop                  laptop ──►┐
     │                │                     desktop ──►├──► RELAY :9765
     │                │                     vps ──────►┘    (routes messages)
     └──────► vps ◄───┘                         ◄── dispatches
                  │                              
                  │        Claude Code machine:  
                  │        ┌─────────────────┐   
                  └───────►│ claude-bridge   │   
                           │ :9766           │   
                           │ runs claude -p  │   
                           └─────────────────┘   

Components on each machine:
  Pi extension     → registers tools, intercepts writes, injects prompt
  Bridge listener  → :9764 HTTP (receives tasks, files, pings)
  Claude bridge    → :9766 HTTP (runs claude -p, optional)

Relay server (server mode only):
  Message queue    → store-and-forward for offline peers
  Agent registry   → capabilities, roles, hierarchy
  File locks       → distributed lock coordination  
  File store       → temporary file storage
  WebSocket hub    → instant delivery for connected agents
```

---

## Phase 1 & 2 — Auto-Discovery, WhatsApp, TUI

### Auto-Discovery Broker (Phase 1.1)

Zero-config local session discovery via Unix socket broker.

```
~/.pi/agent/network/broker.sock  ← auto-spawned, auto-cleaned
```

- Sessions auto-register on startup, auto-leave on shutdown
- Messages route directly between local sessions (no HTTP overhead)
- Broker auto-shuts down after 5s with no connected sessions
- Falls back to HTTP-only mode if broker is unavailable

### Idle-Aware Delivery (Phase 1.2)

Inbound messages queue when the agent is busy, deliver when idle:
- Priority ordering: `urgent` > `high` > `normal` > `low`
- First queued message triggers a new agent turn
- Follow-up messages delivered without re-triggering

### Confirm-Before-Send (Phase 1.6)

Optional safety prompt before sending tasks to remote agents:
```json
{
  "confirmSend": {
    "confirmSend": false,
    "confirmBroadcast": true,
    "confirmTimeoutMs": 30000
  }
}
```

### Presence Tracking (Phase 1.8)

Real-time status broadcast: `idle` → `thinking` → `tool:write` → `idle`
- Pool widget shows live tool-level status
- `/network` shows presence for all peers
- Heartbeat broadcasts presence every 30s via broker

### Reply Threading (Phase 1.5)

Conversation threading via `replyTo` message IDs:
- `ReplyTracker` manages pending asks with auto-expiry (10 min)
- Supports resolution by session ID or peer name
- Thread indicators shown in inline message rendering

### WhatsApp Integration (Phase 2)

Control your mesh from WhatsApp via Evolution API:

```
/vps check disk space                      → send task to "vps"
/broadcast report status                   → send to all online peers
/status                                     → show network status
/peers                                      → list all peers
/history                                    → recent tasks
/kill task-abc123                           → cancel a task
/help                                       → command reference
@vps can you check nginx logs              → natural language
```

**Flags:** `--priority=urgent`, `--mode=raw`, `--deliver-to=peer`

**Config:**
```json
{
  "whatsapp": {
    "enabled": true,
    "evolutionApiUrl": "http://localhost:8080",
    "evolutionApiKey": "your-key",
    "instanceName": "pi-network",
    "allowedNumbers": ["+1234567890"],
    "commandPrefix": "/",
    "defaultReplyTarget": "whatsapp",
    "maxMessageLength": 1000
  }
}
```

**Security:** phone allowlist, 10 cmds/min rate limit, 5-min replay protection, duplicate detection, forwarded message rejection.

**Proactive notifications** (configurable, 30s throttle):
- Task completion → WhatsApp notification
- Peer status change → WhatsApp notification
- Damage control block → WhatsApp confirmation request

---

## Git Sync — Cross-Machine Branch Coordination

Automatically sync code across machines via git. Workers create branches, manager merges to main.

### How it works

```
Laptop (manager)
  │
  ├── task_send("venus", "research topic A")     ← via pi-network
  ├── task_send("hendry", "build feature X")     ← via pi-network
  │
Venus (desktop worker)
  ├── Uses pi-subagents to parallelize research   ← via pi-subagents
  └── Sends results to hendry                     ← via pi-network
  │
Hendry (VPS worker)
  ├── Creates branch: agent/hendry/feature-x      ← auto
  ├── Implements feature (may use pi-subagents)   ← via pi-subagents
  ├── Auto-commits + pushes on task complete       ← auto
  └── Sends result back to laptop                 ← via pi-network
  │
Laptop (manager)
  ├── Receives result from hendry
  ├── Periodic fetch detects new branch
  ├── Reviews: /git-sync diff agent/hendry/feature-x
  ├── Merges clean branches automatically
  └── Consolidates conflicts in one pass
```

### Config

```json
// Manager (laptop)
{
  "role": "manager",
  "git_sync": {
    "mode": "github",
    "base_branch": "main",
    "fetch_interval_seconds": 30,
    "auto_merge_clean": true,
    "squash_merge": true
  }
}

// Worker (venus, hendry, etc.)
{
  "role": "worker",
  "git_sync": {
    "mode": "github",
    "branch_prefix": "agent/venus/",
    "auto_commit_on_task_complete": true,
    "auto_push_on_commit": true
  }
}
```

### Modes

| Mode | Transport | Use when |
|------|-----------|----------|
| `github` | GitHub remote (default) | Both machines have GitHub access |
| `direct` | SSH to remote machine | Same Tailscale/LAN, air-gapped |
| `off` | None | Disable git sync |

### Permissions

| Action | Manager | Worker |
|--------|---------|--------|
| Merge to main | ✅ | ❌ (git hook blocks) |
| Resolve conflicts | ✅ (consolidates) | ❌ |
| Create branch | ✅ | ✅ (auto on task) |
| Commit + push | ✅ | ✅ (auto on complete) |
| Review branches | ✅ | ✅ (own only) |

### Slash commands

```
/git-sync status              — Show git sync state
/git-sync fetch               — Fetch all remotes
/git-sync branches            — List agent branches
/git-sync diff <branch>       — Show branch diff stat
/git-sync full-diff <branch>  — Full diff for review
/git-sync merge <branch>      — Merge branch into main
/git-sync consolidate <branch> — Start conflict resolution
/git-sync finalize <branch>   — Finalize after resolving conflicts
/git-sync abort               — Abort in-progress merge
```

### Tool: `git_sync`

The `git_sync` tool lets agents manage git programmatically:

- **Workers**: `git_sync(action="branch")` creates a task branch, `git_sync(action="commit")` commits changes
- **Manager**: `git_sync(action="fetch")`, `git_sync(action="branches")`, `git_sync(action="merge", branch="agent/hendry/feat-x")`, `git_sync(action="consolidate", branch="...")`

### Conflict resolution

When a branch conflicts with main:
1. Manager calls `git_sync(action="merge", branch="...")` — detects conflicts
2. Manager reads conflicting files, resolves in one pass
3. Manager calls `git_sync(action="consolidate", branch="...")` — finalizes

No back-and-forth with workers. Manager sees the full picture and consolidates.

### Companion: `pi-subagents`

Install [pi-subagents](https://github.com/nicobailon/pi-subagents) on each machine for local parallel workers:

```bash
pi install npm:pi-subagents
```

Workers use `pi-subagents` to parallelize within a machine (research subtopics, multi-file edits). `pi-network` coordinates across machines.

---

## License

MIT
