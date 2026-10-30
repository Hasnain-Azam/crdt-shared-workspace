/**
 * Minimal promise wrapper over the native IndexedDB API.
 *
 * IndexedDB reports results through events. These helpers adapt requests
 * and transactions to promises so the store code can read sequentially.
 */

export type UpgradeHandler = (db: IDBDatabase, oldVersion: number) => void;

export interface OpenDatabaseOptions {
  readonly name: string;
  readonly version: number;
  readonly upgrade: UpgradeHandler;
  /** Injectable factory (defaults to the global `indexedDB`), for tests and non-browser hosts. */
  readonly factory?: IDBFactory;
}

/** Resolves with a request's result, or rejects with its error. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves when the transaction commits. Rejects if it aborts or errors. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = (): void => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Opens (and if needed creates or upgrades) a database. */
export function openDatabase(options: OpenDatabaseOptions): Promise<IDBDatabase> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (factory === undefined) return Promise.reject(new Error("IndexedDB is not available in this environment"));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(options.name, options.version);
    request.onupgradeneeded = (event: IDBVersionChangeEvent): void => options.upgrade(request.result, event.oldVersion);
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error(`Failed to open IndexedDB "${options.name}"`));
    request.onblocked = (): void => reject(new Error(`Opening IndexedDB "${options.name}" is blocked by another connection`));
  });
}

/** Deletes a database entirely. */
export function deleteDatabase(name: string, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (factory === undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = (): void => resolve();
    request.onerror = (): void => reject(request.error ?? new Error(`Failed to delete IndexedDB "${name}"`));
  });
}
