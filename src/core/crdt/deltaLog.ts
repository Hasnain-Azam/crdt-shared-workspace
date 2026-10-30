/**
 * Delta log, keyed by dot.
 *
 * The relay server and every client keep the deltas they know about. The
 * anti-entropy handshake is then simple set difference: given a peer's
 * causal context C, the deltas that peer is missing are
 *
 *   { δ ∈ log | dot(δ) ∉ C }
 *
 * Because merge is idempotent, sending a delta the peer already has is
 * harmless. Set difference only keeps traffic small.
 */
import { compareTimestamps } from "./hlc";
import { contextContains, dotKey } from "./vectorClock";
import type { CausalContext, Delta } from "./types";

export class DeltaLog {
  private readonly entries = new Map<string, Delta>();

  constructor(initial: readonly Delta[] = []) {
    for (const delta of initial) this.entries.set(dotKey(delta.dot), delta);
  }

  /** Adds a delta. Returns false if a delta with the same dot was already present. */
  add(delta: Delta): boolean {
    const key = dotKey(delta.dot);
    if (this.entries.has(key)) return false;
    this.entries.set(key, delta);
    return true;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Deltas whose dot isn't in `ctx`, in HLC order (causal order for a single author). */
  missingFrom(ctx: CausalContext): Delta[] {
    return [...this.entries.values()]
      .filter((delta) => !contextContains(ctx, delta.dot))
      .sort((a, b) => compareTimestamps(a.ts, b.ts));
  }

  all(): Delta[] {
    return [...this.entries.values()].sort((a, b) => compareTimestamps(a.ts, b.ts));
  }
}
