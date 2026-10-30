/**
 * Persistence port: the storage contract the sync engine depends on.
 *
 * The engine only sees this interface, so it runs unchanged on IndexedDB
 * (browser), in memory (tests, simulations) or any future backend.
 */
import type { CausalContext, ConflictRecord, Delta, ReplicaSnapshot } from "../crdt/types";

/** Everything needed to rebuild a replica after a reload, before any network I/O. */
export interface PersistedWorkspace {
  readonly snapshot: ReplicaSnapshot;
  readonly deltas: readonly Delta[];
  /** Dots the relay server is known to hold. Deltas outside this set make up the outbox. */
  readonly serverContext: CausalContext;
  readonly conflicts: readonly ConflictRecord[];
}

/**
 * One atomic write. Every present field is committed in a single
 * transaction, so a crash can never persist a delta without the state that
 * includes it, or the reverse.
 */
export interface PersistBatch {
  readonly snapshot?: ReplicaSnapshot;
  readonly deltas?: readonly Delta[];
  readonly serverContext?: CausalContext;
  readonly conflicts?: readonly ConflictRecord[];
}

export interface PersistencePort {
  /** Loads the persisted workspace, or null on first run. */
  load(): Promise<PersistedWorkspace | null>;
  /** Atomically writes the batch. */
  write(batch: PersistBatch): Promise<void>;
  /** Deletes all persisted data for this workspace. */
  clear(): Promise<void>;
}
