# Pi-Network Upgrade & WhatsApp Integration — To-Do List

> Priority: P0 = critical foundation, P1 = high value, P2 = nice to have
> Estimated effort shown per item

---

## Phase 1: Steal Pi-Intercom Goodness (Upgrade Existing Pi-Network)

### 1.1 Auto-Discovery for Local Sessions
- **Priority:** P0
- **Effort:** 2-3 days
- **Why:** Currently requires manual `config.json` peer definitions. Pi-intercom proves zero-config auto-discovery is possible via a local broker.
- **Tasks:**
  - [ ] Add a local broker mode to pi-network (Unix socket / Windows named pipe, same as pi-intercom's `broker.ts`)
  - [ ] Auto-spawn broker on startup (copy pattern from pi-intercom's `spawnBrokerIfNeeded()`)
  - [ ] Auto-register local pi sessions into the mesh on `session_start`
  - [ ] Auto-detect and list local sessions without config entries
  - [ ] Federation: local sessions found via broker + remote peers found via config/Tailscale = unified mesh
  - [ ] Update `/network` slash command to show both local and remote peers in one view
  - [ ] Fallback: if broker fails, fall back to current HTTP-only mode

### 1.2 Idle-Aware Message Delivery
- **Priority:** P1
- **Effort:** 1 day
- **Why:** Pi-network's `injectTask()` injects immediately via `sendUserMessage`. If the agent is busy with another task, messages can collide or get lost. Pi-intercom queues and delivers when idle.
- **Tasks:**
  - [ ] Add `pendingInboundMessages[]` queue (copy pattern from pi-intercom's `pendingIdleMessages`)
  - [ ] Check `ctx.isIdle()` before injecting. If busy, queue the message
  - [ ] Add flush timer: when agent becomes idle (`agent_end` / `turn_end`), deliver queued messages
  - [ ] First queued message triggers a turn (`triggerTurn: true`), rest delivered as follow-ups (`deliverAs: "followUp"`)
  - [ ] Handle multi-message flush: deliver all queued messages at once, not one per idle cycle

### 1.3 TUI Compose Overlay
- **Priority:** P1
- **Effort:** 2 days
- **Why:** Pi-intercom has `Alt+M` → pick session → type message → send. Pi-network has no interactive way to initiate communication — you have to talk to the LLM and ask it to call `remote_task`.
- **Tasks:**
  - [ ] Create `src/ui/session-list.ts` — overlay showing all peers (local + remote) with status indicators
  - [ ] Create `src/ui/compose.ts` — text input overlay for composing messages/tasks to a selected peer
  - [ ] Register `Alt+M` keyboard shortcut (or `Ctrl+M` to avoid conflict)
  - [ ] Add `/intercom` slash command as alternative entry point
  - [ ] Compose overlay shows: target peer, mode selector (agent/raw/inbox), text input, send button
  - [ ] After sending, show delivery status (sent / queued / failed)

### 1.4 Inline Message Rendering (Styled TUI)
- **Priority:** P1
- **Effort:** 1-2 days
- **Why:** Pi-intercom has `InlineMessageComponent` with styled sender name, timestamp, reply hint. Pi-network delivers results as plain `sendMessage` text.
- **Tasks:**
  - [ ] Create `src/ui/inline-message.ts` — custom TUI component for rendering inbound results
  - [ ] Register via `pi.registerMessageRenderer("bridge-result", ...)` 
  - [ ] Show: sender name (colored by peer color), timestamp, result preview, reply hint
  - [ ] Add expand/collapse for long results
  - [ ] Style differently for: task result, file received, clarification request

### 1.5 Reply Threading
- **Priority:** P1
- **Effort:** 1-2 days
- **Why:** Pi-intercom has `replyTo` message IDs and a `ReplyTracker` for conversation threading. Pi-network's results flow back but have no thread concept.
- **Tasks:**
  - [ ] Add `replyTo` field to `TaskEnvelope` and `TaskResult` types
  - [ ] Create `src/core/reply-tracker.ts` (port from pi-intercom's `ReplyTracker`)
  - [ ] Track inbound asks waiting for reply
  - [ ] Add `intercom({ action: "reply", message: "...", replyTo: "msg-id" })` to existing tools
  - [ ] Add `intercom({ action: "pending" })` to list unresolved asks
  - [ ] Show thread indicator in inline message rendering

### 1.6 Confirm-Before-Send (Safety Prompt)
- **Priority:** P2
- **Effort:** 0.5 day
- **Why:** Pi-intercom has `config.confirmSend` which prompts the user before sending. Pi-network trusts the LLM to send without confirmation.
- **Tasks:**
  - [ ] Add `confirmSend: boolean` to `BridgeConfig`
  - [ ] In `task_send` / `remote_task` execute: if `confirmSend && ctx.hasUI`, show confirm dialog with peer + task preview
  - [ ] Add `confirmBroadcast: boolean` (stricter default for broadcasts)
  - [ ] Timeout = cancel (same pattern as damage control's `ask`)

### 1.7 Subagent `contact_supervisor` Integration
- **Priority:** P2
- **Effort:** 2 days
- **Why:** Pi-intercom has a rich structured interview protocol (single/multi/text/image questions with validation). Pi-network's `ask_origin` is primitive.
- **Tasks:**
  - [ ] Port `SupervisorInterviewQuestion` / `SupervisorInterviewRequest` types from pi-intercom
  - [ ] Add `interview_request` mode to `ask_origin` tool
  - [ ] Add interview validation (`validateSupervisorInterviewRequest`, `validateSupervisorInterviewReply`)
  - [ ] Add structured reply parsing with fallback to free-text
  - [ ] Add `contact_supervisor` tool for subagent → supervisor communication (port from pi-intercom)
  - [ ] Add progress update mode (fire-and-forget, no reply wait)

### 1.8 Unified Presence & Status
- **Priority:** P2
- **Effort:** 1 day
- **Why:** Pi-intercom tracks per-turn status (idle/thinking/tool:xxx) and model changes in real-time. Pi-network only has heartbeat-based context%.
- **Tasks:**
  - [ ] Add `tool_execution_start` / `tool_execution_end` hooks to update peer status in registry
  - [ ] Add `agent_start` / `agent_end` hooks for thinking/idle transitions
  - [ ] Show tool-level status in pool widget (e.g., "🟡 laptop [tool:write]")
  - [ ] Show model name in pool widget
  - [ ] Real-time presence broadcast to other peers (not just 30s heartbeat)

---

## Phase 2: WhatsApp Integration via Evolution API

### 2.1 Evolution API Server Setup
- **Priority:** P0
- **Effort:** 0.5 day
- **Tasks:**
  - [ ] Deploy Evolution API server (Docker recommended)
    ```yaml
    # docker-compose.yml addition
    evolution-api:
      image: atendai/evolution-api:latest
      ports:
        - "8080:8080"
      environment:
        - SERVER_TYPE=http
        - AUTHENTICATION_API_KEY=your-key
        - DATABASE_ENABLED=false
        - QRCODE_LIMIT=30
    ```
  - [ ] Create WhatsApp instance via Evolution API REST
  - [ ] Link to your regular WhatsApp (scan QR — one time)
  - [ ] Verify webhook delivery works
  - [ ] Document setup steps in README

### 2.2 WhatsApp Transport Layer
- **Priority:** P0
- **Effort:** 1-2 days
- **Tasks:**
  - [ ] Create `src/transport/whatsapp.ts` implementing the `Transport` interface
  - [ ] Add `"whatsapp"` to `NetworkMode` type union
  - [ ] Add WhatsApp config section to `BridgeConfig`:
    ```typescript
    whatsapp: {
      enabled: boolean
      evolutionApiUrl: string     // "http://localhost:8080"
      evolutionApiKey: string
      instanceName: string        // "pi-network"
      allowedNumbers: string[]    // ["+1234567890"]
      commandPrefix: string       // "/" or "@pi" or "!"
      defaultReplyTarget: string  // "whatsapp" or peer name
      maxMessageLength: number    // 1000
      dedicatedGroupJid?: string  // optional: only listen in this group
    }
    ```
  - [ ] Register transport in `createTransport()` factory
  - [ ] Add hybrid support: `whatsapp` + `tailscale` or `whatsapp` + `server`

### 2.3 Command Parser
- **Priority:** P0
- **Effort:** 1 day
- **Tasks:**
  - [ ] Create `src/core/command-parser.ts`
  - [ ] Parse formats:
    ```
    /vps check disk space                              → peer=vps, task="check disk space"
    /laptop review auth.ts --deliver-to=desktop        → peer=laptop, task="review auth.ts", deliverTo=desktop
    /broadcast report status                           → broadcast, task="report status"
    /status                                            → show mesh status
    /help                                              → show available commands
    /peers                                             → list all peers
    /kill task-abc123                                  → kill a task
    /history                                           → recent task history
    ```
  - [ ] Support natural language after prefix: `@vps can you check the nginx logs for errors`
  - [ ] Support `--priority=urgent`, `--mode=raw`, `--deliver-to=peer` flags
  - [ ] Handle unknown commands gracefully with help text

### 2.4 WhatsApp Bridge Service
- **Priority:** P0
- **Effort:** 1-2 days
- **Why:** This is the core loop — receive WhatsApp messages, filter, parse, route into mesh, return results.
- **Tasks:**
  - [ ] Create `src/whatsapp-bridge.ts`
  - [ ] **Inbound flow:**
    1. Listen to Evolution API WebSocket for new messages
    2. Filter: only messages from `allowedNumbers`
    3. Filter: only messages starting with `commandPrefix`
    4. If `dedicatedGroupJid` set: only messages from that group
    5. Parse command → determine peer + task + options
    6. Create `TaskEnvelope` with `from: "whatsapp"`, `deliverTo: defaultReplyTarget`
    7. Send into mesh via transport
  - [ ] **Outbound flow:**
    1. Listen for `TaskResult` events where `deliverTo === "whatsapp"`
    2. Format result as WhatsApp-friendly message
    3. Send via Evolution API REST to the originating number/group
  - [ ] **Status commands:**
    1. `/status` → query `peer_status()`, format and reply
    2. `/peers` → list all peers with status indicators
    3. `/history` → show recent task history
    4. `/help` → show command reference
  - [ ] **Error handling:**
    1. Unknown peer → "❌ Unknown peer 'xxx'. Available: desktop, laptop, vps"
    2. Peer offline → "📭 laptop is offline. Task queued."
    3. Parse error → "❓ Couldn't parse that. Try: /<peer> <task>"
    4. Rate limit → ignore if >10 commands/min

### 2.5 WhatsApp Message Formatting
- **Priority:** P1
- **Effort:** 0.5 day
- **Why:** WhatsApp supports bold, italic, code blocks, lists. Use them for readable results.
- **Tasks:**
  - [ ] Create `src/core/whatsapp-formatter.ts`
  - [ ] Format task results:
    ```
    ✅ *Result from vps*
    
    Disk usage: 47% (120GB free)
    • /dev/sda1: 45% used
    • /dev/sdb1: 89% used ⚠️
    
    _Completed in 12s | hops: 1_
    ```
  - [ ] Format status:
    ```
    🌐 *Pi Network Status*
    
    🟢 desktop (manager) — 23% ctx
    🟢 laptop (worker) — coding, design
    🔴 vps (worker) — offline
    ```
  - [ ] Format task history as numbered list
  - [ ] Format errors with ❌ and suggested fix
  - [ ] Support sending files as WhatsApp documents (Evolution API supports this)

### 2.6 WhatsApp Security Hardening
- **Priority:** P0
- **Effort:** 1 day
- **Why:** WhatsApp is an external entry point into your agent mesh. Security is non-negotiable.
- **Tasks:**
  - [ ] Phone number allowlist (only YOUR number can issue commands)
  - [ ] Rate limiting: max N commands per minute (default: 10)
  - [ ] Command audit log: every WhatsApp command logged with timestamp, number, command
  - [ ] Integration with damage control: WhatsApp-originated tasks subject to same YAML rules
  - [ ] Optional: `confirmDangerous` mode — for `ask: true` damage control rules, send WhatsApp confirmation button before executing
  - [ ] Optional: command allowlist (`restrictCommands: true` → only whitelisted operations)
  - [ ] Reject forwarded messages (only original messages from allowed numbers)
  - [ ] Reject messages older than 5 minutes (replay protection)

### 2.7 WhatsApp ↔ Pi-Network Two-Way Sync
- **Priority:** P1
- **Effort:** 1 day
- **Why:** Sometimes you want the mesh to proactively notify you on WhatsApp (not just respond to commands).
- **Tasks:**
  - [ ] Add `notifyWhatsApp: boolean` to config
  - [ ] When a long-running task completes, send proactive notification to WhatsApp
  - [ ] When a peer goes offline/online, optionally notify
  - [ ] When damage control blocks something, optionally notify
  - [ ] When a task requires human confirmation (damage control `ask`), send to WhatsApp with approve/deny buttons
  - [ ] Throttle notifications: max 1 per 30 seconds to avoid spam

### 2.8 WhatsApp Group Support
- **Priority:** P2
- **Effort:** 1 day
- **Tasks:**
  - [ ] Support `dedicatedGroupJid` — only listen in a specific group
  - [ ] Support multiple groups with different peer mappings
  - [ ] Group-based access control: which peers this group can command
  - [ ] Thread replies: reply in the same group where command was sent
  - [ ] @mention support: `@PiNetwork check status` in groups

---

## Phase 3: Polish & DX

### 3.1 Unified Tool Surface
- **Priority:** P1
- **Effort:** 1 day
- **Tasks:**
  - [ ] Make `remote_task` auto-detect local vs remote peer
    - Local peer (found via broker) → route through intercom-style broker (fast, idle-aware)
    - Remote peer → route through Tailscale/server transport
  - [ ] LLM should not need to know the difference
  - [ ] Update system prompt injection to show unified peer list

### 3.2 Config Migration Helper
- **Priority:** P2
- **Effort:** 0.5 day
- **Tasks:**
  - [ ] Add `pi-network init` CLI command for guided config setup
  - [ ] Auto-detect Tailscale status and suggest mode
  - [ ] Auto-detect local pi sessions and suggest peers
  - [ ] Validate config on startup with helpful error messages

### 3.3 Documentation Update
- **Priority:** P1
- **Effort:** 1 day
- **Tasks:**
  - [ ] Update README with WhatsApp section
  - [ ] Add WhatsApp setup guide (Evolution API deploy, QR scan, first command)
  - [ ] Add command reference table
  - [ ] Add architecture diagram showing WhatsApp in the mesh
  - [ ] Add troubleshooting section for WhatsApp-specific issues

---

## Implementation Order (Recommended)

```
Week 1: Foundation
├── 1.1 Auto-discovery broker          (unblocks everything else)
├── 1.2 Idle-aware delivery            (reliability)
└── 2.1 Evolution API setup            (validate WhatsApp works)

Week 2: Core WhatsApp
├── 2.2 WhatsApp transport layer
├── 2.3 Command parser
├── 2.4 WhatsApp bridge service
└── 2.6 Security hardening

Week 3: UX & Polish
├── 1.3 TUI compose overlay
├── 1.4 Inline message rendering
├── 1.5 Reply threading
├── 2.5 Message formatting
└── 2.7 Two-way sync (proactive notifications)

Week 4: Nice-to-haves
├── 1.6 Confirm-before-send
├── 1.7 Supervisor interview protocol
├── 1.8 Unified presence
├── 3.1 Unified tool surface
├── 2.8 Group support
└── 3.2-3.3 Config helper + docs
```

---

## Quick Wins (Do These First — 1 Day Each)

| # | Item | Impact | Effort |
|---|---|---|---|
| 1 | Idle-aware message delivery | No more lost messages when agent is busy | 1 day |
| 2 | Confirm-before-send (`confirmSend` config) | Safety net for expensive remote tasks | 0.5 day |
| 3 | `/status` WhatsApp command via Evolution API | Proof of concept that WhatsApp → mesh works | 1 day |
| 4 | Inline message rendering | Results look 10x better in TUI | 1 day |
| 5 | Command parser (`/peer task`) | Foundation for WhatsApp + any future chat interface | 1 day |
