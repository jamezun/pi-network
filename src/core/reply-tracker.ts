// Pi Network — Reply threading tracker
// Phase 1.5: Ported from pi-intercom's ReplyTracker for conversation threading.

import type { SessionInfo, BrokerMessage, IntercomContext } from "../broker/types";

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[] = [];
  private currentTurnContext: IntercomContext | null = null;

  constructor(private readonly askTimeoutMs = 10 * 60 * 1000) {}

  recordIncomingMessage(from: SessionInfo, message: BrokerMessage, receivedAt = Date.now()): IntercomContext {
    const context = { from, message, receivedAt };
    if (message.expectsReply) {
      this.pendingAsks.set(message.id, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.pendingTurnContexts.push(context);
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

  resolveReplyTarget(options: { to?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    if (this.currentTurnContext) return this.currentTurnContext;

    const pending = Array.from(this.pendingAsks.values());
    if (pending.length === 1) return pending[0]!;

    if (options.to) {
      const byId = this.pendingAsks.get(options.to);
      if (byId) return byId;

      const lower = options.to.toLowerCase();
      const matches = pending.filter(ctx =>
        ctx.from.id === options.to ||
        ctx.from.name?.toLowerCase() === lower
      );
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) throw new Error(`Multiple pending asks from "${options.to}" — use session ID`);
      if (pending.length > 1) throw new Error(`No pending ask from "${options.to}"`);
    }

    if (pending.length === 0) throw new Error("No active context to reply to");
    throw new Error("Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const [id, ctx] of this.pendingAsks) {
      if (now - ctx.receivedAt > this.askTimeoutMs) this.pendingAsks.delete(id);
    }
  }
}
