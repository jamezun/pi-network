// Pi Network — Hop-limit enforcement
// Prevents runaway A→B→A→B forwarding loops.
// Stolen from coms.ts: MAX_HOPS with inheritance from current inbound context.

import type { TaskEnvelope } from "./tasks";

const DEFAULT_MAX_HOPS = Number(process.env.PI_NETWORK_MAX_HOPS) || 5;

/**
 * Check if a new outbound envelope would exceed the hop limit.
 * Returns { allowed: false } if it should be rejected.
 *
 * Rules:
 *   - If this send is a forward (we have currentInboundHops), new hops = inbound + 1
 *   - If this is an originating send, hops = 0
 */
export function withinHopLimit(
  _envelope: TaskEnvelope,
  currentInboundHops?: number,
  maxHops: number = DEFAULT_MAX_HOPS
): { allowed: boolean; hops: number; maxHops: number } {
  const hops = currentInboundHops != null ? currentInboundHops + 1 : 0;
  return {
    allowed: hops < maxHops,
    hops,
    maxHops,
  };
}

/**
 * Stamp a hop count onto an envelope.
 * Call this before sending to record the new hop.
 */
export function stampHop(
  envelope: TaskEnvelope,
  currentInboundHops?: number
): number {
  const hops = currentInboundHops != null ? currentInboundHops + 1 : 0;
  envelope.hops = hops;
  return hops;
}
