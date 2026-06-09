// Pi Network — Improvement #4: User-Scoped Routing (multi-tenant)
//
// OpenClaw binds a channel account → one agent. We adapt that to user → agents:
// each userId owns a namespace of agents and conversations. User A's pool never
// leaks into User B's. This is the single biggest gap for a consumer product —
// pi-network was machine/peer-centric (`localName`); now it's user-centric.
//
// Backward compat: messages with no `userId` fall into the implicit "system"
// tenant (single-user mode) so legacy Tailscale deployments keep working.

import type { SessionInfo } from "../broker/types";

export const SYSTEM_TENANT = "__system__";

export interface UserBinding {
  userId: string;
  tier: "free" | "pro" | "power";
  agentIds: string[];           // sessions this user is allowed to route to
  conversationIds: Set<string>; // active conversation scopes
  createdAt: number;
}

/**
 * In-memory routing table keyed by userId.
 * For federation / multi-process brokers, swap this for Redis later.
 */
export class RoutingTable {
  private bindings = new Map<string, UserBinding>();
  /** Reverse map: sessionId → userId (for filtering sessions per user). */
  private sessionOwner = new Map<string, string>();

  /** Register or update a user binding. */
  upsertUser(userId: string, opts?: { tier?: UserBinding["tier"]; agentIds?: string[] }): UserBinding {
    const existing = this.bindings.get(userId);
    const binding: UserBinding = {
      userId,
      tier: opts?.tier ?? existing?.tier ?? "free",
      agentIds: opts?.agentIds ?? existing?.agentIds ?? [],
      conversationIds: existing?.conversationIds ?? new Set(),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.bindings.set(userId, binding);
    return binding;
  }

  /** Claim a session for a user. */
  bindSession(userId: string, sessionId: string): void {
    const prev = this.sessionOwner.get(sessionId);
    if (prev && prev !== userId) {
      // reassign: remove from previous owner's agentIds
      const prevBinding = this.bindings.get(prev);
      if (prevBinding) prevBinding.agentIds = prevBinding.agentIds.filter(id => id !== sessionId);
    }
    this.sessionOwner.set(sessionId, userId);
    const binding = this.upsertUser(userId);
    if (!binding.agentIds.includes(sessionId)) binding.agentIds.push(sessionId);
  }

  /** Which user owns a session? (undefined = unbound/system tenant). */
  ownerOf(sessionId: string): string | undefined {
    return this.sessionOwner.get(sessionId);
  }

  /** Resolve the effective tenant for a message: explicit userId, else owner, else system. */
  resolveTenant(userId: string | undefined, sessionId?: string): string {
    if (userId) return userId;
    if (sessionId) return this.sessionOwner.get(sessionId) ?? SYSTEM_TENANT;
    return SYSTEM_TENANT;
  }

  /** Filter a session list down to what `userId` is allowed to see. */
  visibleSessions(userId: string | undefined, all: SessionInfo[]): SessionInfo[] {
    const tenant = this.resolveTenant(userId);
    if (tenant === SYSTEM_TENANT) return all; // single-user mode: see everything
    return all.filter(s => this.sessionOwner.get(s.id) === tenant);
  }

  /** Can `userId` send to / route to `targetSessionId`? */
  canRoute(userId: string | undefined, targetSessionId: string): boolean {
    const tenant = this.resolveTenant(userId);
    if (tenant === SYSTEM_TENANT) return true; // unscoped → permissive (legacy)
    return this.sessionOwner.get(targetSessionId) === tenant;
  }

  /** Drop a session when it disconnects. */
  releaseSession(sessionId: string): void {
    const owner = this.sessionOwner.get(sessionId);
    if (owner) {
      const binding = this.bindings.get(owner);
      if (binding) binding.agentIds = binding.agentIds.filter(id => id !== sessionId);
    }
    this.sessionOwner.delete(sessionId);
  }

  /** Open / track a conversation scope for a user. */
  openConversation(userId: string, conversationId: string): void {
    const binding = this.upsertUser(userId);
    binding.conversationIds.add(conversationId);
  }

  stats(): { users: number; boundSessions: number } {
    return { users: this.bindings.size, boundSessions: this.sessionOwner.size };
  }
}
