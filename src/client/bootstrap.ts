/**
 * Browser composition root: wires the core engine to real browser APIs
 * (IndexedDB, WebSocket, Web Locks, sessionStorage). Nothing in src/core
 * touches these globals directly.
 */
import type { NodeId } from "../core/crdt/types";
import { SyncEngine } from "../core/network/syncEngine";
import { WebSocketTransport } from "../core/network/transport";
import { IndexedDbWorkspaceStore } from "../core/storage/workspaceStore";

const NODE_ID_KEY = "crdt-workspace:node-id";
const NAMES = ["otter", "lynx", "heron", "panda", "falcon", "koala", "orca", "ibis", "marten", "gecko", "puffin", "bison"];

function randomNodeId(): NodeId {
  const name = NAMES[Math.floor(Math.random() * NAMES.length)] ?? "node";
  return `${name}-${globalThis.crypto.randomUUID().slice(0, 4)}`;
}

function sessionGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode). The id just won't survive a reload.
  }
}

/**
 * Tries to take an exclusive Web Lock and holds it until the tab closes.
 * Resolves false if another tab already holds it.
 */
function holdLock(name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise<never>(() => {}); // never settles, so the lock is held for the tab's lifetime
      })
      .catch(() => resolve(true));
  });
}

let claimed: Promise<NodeId> | null = null;

/**
 * Claims a node id that is unique among open tabs and stable across reloads.
 *
 * Correctness depends on it: two live replicas sharing a node id would mint
 * colliding dots. The id lives in sessionStorage (per tab, survives reload).
 * "Duplicate tab" copies sessionStorage, so a Web Lock on the id detects the
 * clash and the duplicate picks a fresh id.
 */
export function claimNodeId(): Promise<NodeId> {
  claimed ??= (async (): Promise<NodeId> => {
    let candidate = sessionGet(NODE_ID_KEY) ?? randomNodeId();
    if (typeof navigator !== "undefined" && "locks" in navigator) {
      for (let attempt = 0; attempt < 8 && !(await holdLock(`crdt-node:${candidate}`)); attempt += 1) {
        candidate = randomNodeId();
      }
    }
    sessionSet(NODE_ID_KEY, candidate);
    return candidate;
  })();
  return claimed;
}

export function defaultSyncUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SYNC_URL;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:4000`;
}

export interface BrowserEngine {
  readonly engine: SyncEngine;
  readonly store: IndexedDbWorkspaceStore;
}

/**
 * Builds a fully wired engine. It hydrates from IndexedDB first and only
 * connects when the caller invokes `engine.start()`.
 */
export async function createBrowserEngine(room: string): Promise<BrowserEngine> {
  const nodeId = await claimNodeId();
  // One database per replica: tabs are independent replicas and must not share a dot sequence.
  const store = new IndexedDbWorkspaceStore({ name: `crdt-workspace:${room}:${nodeId}` });
  const url = `${defaultSyncUrl()}/?room=${encodeURIComponent(room)}`;
  const engine = await SyncEngine.open({ nodeId, room, store, transport: new WebSocketTransport(url) });
  return { engine, store };
}
