// Pi Network — Hop-limit enforcement
// Prevents runaway A→B→A→B forwarding loops.
// Stolen from coms.ts: MAX_HOPS with inheritance from current inbound context.

import type { TaskEnvelope } from "./tasks";

const DEFAULT_MAX_HOPS = Number(process.env.PI_NETWORK_MAX_HOPS) || 5;

/**
 * Check if a new outbound envelope would exceed the hop limit.
 * Returns true if the envelope is allowed, false if it should be rejected.
 */
export function withinHopLimit(
  envelope: TaskEnvelope,
  currentInboundHops?: number,
  maxHops: number = DEFAULT_MAX_HOPS
): { allowed: boolean; hops: number; maxHops: number } {
  // Outbound hop count = inbound hops + 1 (or 0 if originating)
  const hops = currentInboundHops != null ? currentInboundHops + 1 : envelope.chain.length;
  return {
    allowed: hops < maxHops,
    hops,
    maxHops,
  };
}

/**
 * Stamp a hop count onto an envelope's chain.
 * Call this before sending to record the new hop.
 */
export function stampHop(
  envelope: TaskEnvelope,
  currentInboundHops?: number
): number {
  const hops = currentInboundHops != null ? currentInboundHops + 1 : envelope.chain.length;
  // Chain already records delegation — but we also add a hops field for quick checks
  (envelope as any).hops = hops;
  return hops;
}
