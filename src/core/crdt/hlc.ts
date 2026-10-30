/**
 * Hybrid Logical Clock (Kulkarni, Demirbas et al., 2014).
 *
 * An HLC timestamp is (wall, counter, node):
 *   - wall    tracks physical time but never goes backwards,
 *   - counter orders events that share the same `wall`,
 *   - node    breaks the remaining ties deterministically.
 *
 * Properties relied on by the CRDT:
 *   1. Monotonic per replica: each `tick()` is strictly greater than every
 *      timestamp this replica has issued or received.
 *   2. Causality: if event e happened-before f, then ts(e) < ts(f), because
 *      `receive()` lifts the local clock above everything it has seen.
 *   3. Strict total order: (wall, counter) is unique per node, so no two
 *      distinct writes compare equal. LWW therefore never needs a tiebreak
 *      that depends on the value itself.
 */
import type { NodeId, Timestamp } from "./types";

/** Supplies physical time in milliseconds. Injectable so tests can control skew. */
export type WallClock = () => number;

/** Compares two timestamps lexicographically on (wall, counter, node). */
export function compareTimestamps(a: Timestamp, b: Timestamp): -1 | 0 | 1 {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

/** Returns the greater of two timestamps (the join in the timestamp total order). */
export function maxTimestamp(a: Timestamp, b: Timestamp): Timestamp {
  return compareTimestamps(a, b) >= 0 ? a : b;
}

/** Formats a timestamp as `wall.counter@node` for logs. */
export function formatTimestamp(ts: Timestamp): string {
  return `${ts.wall}.${ts.counter}@${ts.node}`;
}

export class HybridLogicalClock {
  private last: Timestamp;

  constructor(
    private readonly node: NodeId,
    private readonly now: WallClock = Date.now,
    initial?: Timestamp,
  ) {
    this.last = initial ? { ...initial, node } : { wall: 0, counter: 0, node };
  }

  /** The most recent timestamp issued or observed. */
  get current(): Timestamp {
    return this.last;
  }

  /**
   * Issues a timestamp for a local event.
   *   wall'    = max(last.wall, now)
   *   counter' = wall' == last.wall ? last.counter + 1 : 0
   */
  tick(): Timestamp {
    const physical = this.now();
    const wall = Math.max(this.last.wall, physical);
    const counter = wall === this.last.wall ? this.last.counter + 1 : 0;
    this.last = { wall, counter, node: this.node };
    return this.last;
  }

  /**
   * Folds a remote timestamp into the local clock so future local events are
   * ordered after it.
   *   wall' = max(last.wall, remote.wall, now)
   *   counter' depends on which of the inputs supplied wall' (see below).
   */
  receive(remote: Timestamp): Timestamp {
    const physical = this.now();
    const wall = Math.max(this.last.wall, remote.wall, physical);
    let counter: number;
    if (wall === this.last.wall && wall === remote.wall) {
      counter = Math.max(this.last.counter, remote.counter) + 1;
    } else if (wall === this.last.wall) {
      counter = this.last.counter + 1;
    } else if (wall === remote.wall) {
      counter = remote.counter + 1;
    } else {
      counter = 0;
    }
    this.last = { wall, counter, node: this.node };
    return this.last;
  }
}
