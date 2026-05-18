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

**Modes:**
- `"agent"` — Full LLM processing on the receiver. Costs tokens on the receiver's side. Best for complex tasks.
- `"raw"` — Token-free. Runs the task as a shell command, returns stdout. Best for simple checks.
- `"inbox"` — Token-free. Delivers the message to the receiver's inbox for later review. Best for notifications.

**Returns immediately** (fire-and-forget). Results arrive asynchronously in your Pi chat.

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

Output shows: status (🟢 online / 🟡 busy / 🔴 offline), role, session name, capabilities, queue depth, IP address, bridge status.

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
  "vaultKey": "set-a-strong-key",  // network-wide encryption key for secrets

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
  agents-cache.json        # Cached registry from relay
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
  task-history.jsonl       # Persistent task audit log
  dead-letter/             # Expired undelivered messages
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

## License

MIT
