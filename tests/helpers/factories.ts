/** Shared builders for tests. */
import { WorkspaceDoc } from "../../src/core/crdt/workspaceDoc";
import { SyncEngine } from "../../src/core/network/syncEngine";
import { MemoryWorkspaceStore } from "../../src/core/storage/memoryStore";
import type { PersistencePort } from "../../src/core/storage/types";
import { ManualClock, type SimulatedNetwork } from "./simulatedNetwork";

/** A wall clock that returns a mutable value (lets tests model skew precisely). */
export interface TestClock {
  time: number;
  readonly now: () => number;
}

export function testClock(start: number): TestClock {
  const clock = {
    time: start,
    now: (): number => clock.time,
  };
  return clock;
}

export function replica(nodeId: string, start = 1_000): { doc: WorkspaceDoc; clock: TestClock } {
  const clock = testClock(start);
  return { doc: new WorkspaceDoc({ nodeId, now: clock.now }), clock };
}

export interface TestPeer {
  readonly engine: SyncEngine;
  readonly store: PersistencePort;
  readonly clock: ManualClock;
}

export async function createPeer(
  network: SimulatedNetwork,
  nodeId: string,
  options: { readonly start?: number; readonly store?: PersistencePort; readonly startOffline?: boolean } = {},
): Promise<TestPeer & { readonly transport: ReturnType<SimulatedNetwork["createTransport"]> }> {
  const clock = new ManualClock(options.start ?? 1_000);
  const store = options.store ?? new MemoryWorkspaceStore();
  const transport = network.createTransport();
  const engine = await SyncEngine.open({
    nodeId,
    room: network.room.id,
    store,
    transport,
    now: clock.now,
    scheduler: clock,
    startOffline: options.startOffline,
  });
  return { engine, store, clock, transport };
}

/** Id of the first card with the given title in a replica's view. */
export function findCardId(doc: WorkspaceDoc, title: string): string {
  for (const column of doc.view().columns) {
    const card = column.cards.find((c) => c.title === title);
    if (card) return card.id;
  }
  throw new Error(`card "${title}" not found`);
}
