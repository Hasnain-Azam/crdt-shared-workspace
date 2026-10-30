/**
 * In-memory persistence port, for tests and for hosts without IndexedDB.
 * Values are deep-cloned so callers can't mutate stored data by reference,
 * which is the same isolation IndexedDB's structured clone gives.
 */
import { dotKey, EMPTY_CONTEXT } from "../crdt/vectorClock";
import type { CausalContext, ConflictRecord, Delta, ReplicaSnapshot } from "../crdt/types";
import type { PersistBatch, PersistedWorkspace, PersistencePort } from "./types";

export class MemoryWorkspaceStore implements PersistencePort {
  private snapshot: ReplicaSnapshot | null = null;
  private readonly deltas = new Map<string, Delta>();
  private serverContext: CausalContext = EMPTY_CONTEXT;
  private conflicts: readonly ConflictRecord[] = [];
  /** Number of committed write batches (useful for asserting write-through behaviour). */
  writes = 0;

  async load(): Promise<PersistedWorkspace | null> {
    if (this.snapshot === null) return null;
    return structuredClone({
      snapshot: this.snapshot,
      deltas: [...this.deltas.values()],
      serverContext: this.serverContext,
      conflicts: this.conflicts,
    });
  }

  async write(batch: PersistBatch): Promise<void> {
    const copy = structuredClone(batch);
    if (copy.snapshot !== undefined) this.snapshot = copy.snapshot;
    for (const delta of copy.deltas ?? []) this.deltas.set(dotKey(delta.dot), delta);
    if (copy.serverContext !== undefined) this.serverContext = copy.serverContext;
    if (copy.conflicts !== undefined) this.conflicts = copy.conflicts;
    this.writes += 1;
  }

  async clear(): Promise<void> {
    this.snapshot = null;
    this.deltas.clear();
    this.serverContext = EMPTY_CONTEXT;
    this.conflicts = [];
  }
}
