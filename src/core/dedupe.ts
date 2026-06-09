// Pi Network — Improvement #7: Generalized Inbound Dedupe
//
// Generalizes the WhatsApp path's 5-min replay protection to ALL inbound
// channels. Mobile clients retry on flaky networks → the relay must be
// idempotent. Per-user namespace avoids cross-user messageId collisions.
//
// Backend is a bounded LRU with TTL (no Redis dependency for single-process
// brokers). For multi-process federation, swap the implementation to Redis
// SETNX with EXPIRE.

export interface DedupeOptions {
  /** How long to remember a messageId (ms). Default 5 min (matches WhatsApp). */
  ttlMs?: number;
  /** Max entries before LRU eviction. Default 10,000. */
  maxEntries?: number;
}

interface Entry {
  value: true;
  expiresAt: number;
}

export class DedupeCache {
  private store = new Map<string, Entry>();
  private ttlMs: number;
  private maxEntries: number;

  constructor(opts: DedupeOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  /** Namespaced key so the same messageId from two users can't collide. */
  private key(userId: string | undefined, messageId: string): string {
    return `${userId ?? "__system__"}\x00${messageId}`;
  }

  /**
   * Returns true if this is a NEW message (not a replay), and records it.
   * Returns false if we've already seen it within the TTL window.
   */
  seen(userId: string | undefined, messageId: string): boolean {
    const now = Date.now();
    const k = this.key(userId, messageId);
    const existing = this.store.get(k);
    if (existing && existing.expiresAt > now) {
      return false; // replay — drop it
    }
    // LRU bound: evict oldest when full (Map preserves insertion order)
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(k, { value: true, expiresAt: now + this.ttlMs });
    return true;
  }

  /** Opportunistic sweep of expired entries. Call periodically. */
  gc(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(k);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.store.size;
  }
}
