/**
 * IndexedDB implementation of the persistence port.
 *
 * Schema (version 1):
 *   replica : "current"                    → ReplicaSnapshot (state + context + HLC + seq)
 *   deltas  : dotKey ("node:seq")          → Delta (the local delta log, which also serves as the outbox)
 *   meta    : "serverContext" | "conflicts" → CausalContext | ConflictRecord[]
 *
 * The outbox is derived instead of stored: it is the set of logged deltas
 * whose dots aren't in `serverContext`. An ack only has to update one
 * context instead of deleting rows, and a client whose acks were lost will
 * simply re-push the same deltas, which idempotent merge makes harmless.
 */
import { dotKey, EMPTY_CONTEXT } from "../crdt/vectorClock";
import type { CausalContext, ConflictRecord, Delta, ReplicaSnapshot } from "../crdt/types";
import { deleteDatabase, openDatabase, requestToPromise, transactionDone } from "./idb";
import type { PersistBatch, PersistedWorkspace, PersistencePort } from "./types";

const DB_VERSION = 1;
const STORE_REPLICA = "replica";
const STORE_DELTAS = "deltas";
const STORE_META = "meta";
const KEY_CURRENT = "current";
const KEY_SERVER_CONTEXT = "serverContext";
const KEY_CONFLICTS = "conflicts";

export interface IndexedDbStoreOptions {
  /** Database name. Use one per replica (see client/bootstrap.ts). */
  readonly name: string;
  readonly factory?: IDBFactory;
}

export class IndexedDbWorkspaceStore implements PersistencePort {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly options: IndexedDbStoreOptions) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDatabase({
      name: this.options.name,
      version: DB_VERSION,
      factory: this.options.factory,
      upgrade: (db) => {
        for (const store of [STORE_REPLICA, STORE_DELTAS, STORE_META]) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      },
    });
    return this.dbPromise;
  }

  async load(): Promise<PersistedWorkspace | null> {
    const db = await this.db();
    const tx = db.transaction([STORE_REPLICA, STORE_DELTAS, STORE_META], "readonly");
    const [snapshot, deltas, serverContext, conflicts] = await Promise.all([
      requestToPromise(tx.objectStore(STORE_REPLICA).get(KEY_CURRENT)) as Promise<ReplicaSnapshot | undefined>,
      requestToPromise(tx.objectStore(STORE_DELTAS).getAll()) as Promise<Delta[]>,
      requestToPromise(tx.objectStore(STORE_META).get(KEY_SERVER_CONTEXT)) as Promise<CausalContext | undefined>,
      requestToPromise(tx.objectStore(STORE_META).get(KEY_CONFLICTS)) as Promise<ConflictRecord[] | undefined>,
    ]);
    await transactionDone(tx);
    if (snapshot === undefined) return null;
    return { snapshot, deltas, serverContext: serverContext ?? EMPTY_CONTEXT, conflicts: conflicts ?? [] };
  }

  async write(batch: PersistBatch): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([STORE_REPLICA, STORE_DELTAS, STORE_META], "readwrite");
    if (batch.snapshot !== undefined) tx.objectStore(STORE_REPLICA).put(batch.snapshot, KEY_CURRENT);
    for (const delta of batch.deltas ?? []) tx.objectStore(STORE_DELTAS).put(delta, dotKey(delta.dot));
    if (batch.serverContext !== undefined) tx.objectStore(STORE_META).put(batch.serverContext, KEY_SERVER_CONTEXT);
    if (batch.conflicts !== undefined) tx.objectStore(STORE_META).put(batch.conflicts, KEY_CONFLICTS);
    await transactionDone(tx);
  }

  async clear(): Promise<void> {
    if (this.dbPromise !== null) {
      (await this.dbPromise).close();
      this.dbPromise = null;
    }
    await deleteDatabase(this.options.name, this.options.factory);
  }

  /** Closes the connection (it reopens lazily on next use). */
  async close(): Promise<void> {
    if (this.dbPromise === null) return;
    (await this.dbPromise).close();
    this.dbPromise = null;
  }
}
