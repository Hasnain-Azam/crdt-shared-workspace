import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, WorkspaceDoc } from "../../src/core/crdt";
import { SyncEngine } from "../../src/core/network/syncEngine";
import { IndexedDbWorkspaceStore } from "../../src/core/storage/workspaceStore";
import { ManualClock, SimulatedNetwork } from "../helpers/simulatedNetwork";

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory(); // a fresh, isolated "browser profile" per test
});

const openStore = (name = "ws-test"): IndexedDbWorkspaceStore => new IndexedDbWorkspaceStore({ name, factory });

describe("IndexedDbWorkspaceStore", () => {
  it("returns null on first run", async () => {
    expect(await openStore().load()).toBeNull();
  });

  it("round-trips snapshot, deltas, server context and conflicts", async () => {
    const store = openStore();
    const doc = new WorkspaceDoc({ nodeId: "a" });
    const d1 = doc.createCard({ columnId: "col-todo", title: "persist me" });
    const d2 = doc.createColumn("Later");
    await store.write({ snapshot: doc.snapshot(), deltas: [d1, d2], serverContext: { clock: { a: 1 }, cloud: {} } });
    await store.close();

    const loaded = await openStore().load();
    expect(loaded).not.toBeNull();
    expect(canonicalize(loaded?.snapshot)).toBe(canonicalize(doc.snapshot()));
    expect(loaded?.deltas.map((d) => d.dot.seq).sort()).toEqual([1, 2]);
    expect(loaded?.serverContext).toEqual({ clock: { a: 1 }, cloud: {} });
    expect(loaded?.conflicts).toEqual([]);
  });

  it("isolates databases by name (one per replica)", async () => {
    const doc = new WorkspaceDoc({ nodeId: "a" });
    await openStore("replica-a").write({ snapshot: doc.snapshot() });
    expect(await openStore("replica-b").load()).toBeNull();
  });

  it("clears all data", async () => {
    const store = openStore();
    await store.write({ snapshot: new WorkspaceDoc({ nodeId: "a" }).snapshot() });
    await store.clear();
    expect(await openStore().load()).toBeNull();
  });
});

describe("offline-first hydration via IndexedDB", () => {
  it("restores the full UI state and the outbox before any network handshake", async () => {
    const net = new SimulatedNetwork();
    const clock = new ManualClock();

    // Session 1: offline the whole time, makes edits, then the tab is closed.
    const t1 = net.createTransport();
    const s1 = await SyncEngine.open({ nodeId: "tab-1", room: "r", store: openStore(), transport: t1, now: clock.now, scheduler: clock, startOffline: true });
    s1.start();
    await s1.mutate((d) => d.createCard({ columnId: "col-todo", title: "drafted offline" }));
    await s1.mutate((d) => d.createColumn("Ideas"));
    expect(t1.connectCalls).toBe(0);
    s1.dispose();

    // Session 2 (reload): the state must be there before start() touches the network.
    const t2 = net.createTransport();
    const s2 = await SyncEngine.open({ nodeId: "tab-1", room: "r", store: openStore(), transport: t2, now: clock.now, scheduler: clock });
    expect(t2.connectCalls).toBe(0);
    const hydrated = s2.getState();
    expect(hydrated.hydratedFrom).toBe("indexeddb");
    expect(hydrated.board.columns[0]?.cards.map((c) => c.title)).toEqual(["drafted offline"]);
    expect(hydrated.board.columns.map((c) => c.title)).toContain("Ideas");
    expect(hydrated.outbox.map((o) => o.kind)).toEqual(["card.create", "column.create"]);

    // Only now does it connect and flush the outbox.
    s2.start();
    await net.settle();
    expect(s2.getState().outbox).toEqual([]);
    expect(net.room.summary().logSize).toBe(2);

    // Session 3: the cleared outbox (the acked server context) was persisted too.
    const s3 = await SyncEngine.open({ nodeId: "tab-1", room: "r", store: openStore(), transport: net.createTransport(), now: clock.now, scheduler: clock });
    expect(s3.getState().outbox).toEqual([]);
    // The dot sequence continues, so no dot is ever reused across reloads.
    const next = await s3.mutate((d) => d.createColumn("after reload"));
    expect(next.dot).toEqual({ node: "tab-1", seq: 3 });
  });

  it("persists every local change immediately (write-through)", async () => {
    const store = openStore();
    const clock = new ManualClock();
    const engine = await SyncEngine.open({ nodeId: "n", room: "r", store, transport: new SimulatedNetwork().createTransport(), now: clock.now, scheduler: clock, startOffline: true });
    await engine.mutate((d) => d.createCard({ columnId: "col-todo", title: "a" }));
    expect((await openStore().load())?.deltas).toHaveLength(1);
    await engine.mutate((d) => d.createCard({ columnId: "col-todo", title: "b" }));
    const loaded = await openStore().load();
    expect(loaded?.deltas).toHaveLength(2);
    expect(new WorkspaceDoc({ nodeId: "n", snapshot: loaded?.snapshot }).view().columns[0]?.cards).toHaveLength(2);
  });
});
