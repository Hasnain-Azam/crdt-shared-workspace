/**
 * Scenario: network partitions, split brain, store-and-forward and relay restarts.
 */
import { describe, expect, it } from "vitest";
import { createPeer, findCardId } from "../helpers/factories";
import { SimulatedNetwork } from "../helpers/simulatedNetwork";

describe("network partitions", () => {
  it("heals a split brain between an isolated peer and a connected majority", async () => {
    const net = new SimulatedNetwork();
    const [a, b, c] = await Promise.all(["a", "b", "c"].map((id) => createPeer(net, id)));
    for (const p of [a, b, c]) p?.engine.start();
    await net.settle();
    if (!a || !b || !c) throw new Error("setup failed");

    await a.engine.mutate((d) => d.createCard({ columnId: "col-todo", title: "shared" }));
    await net.settle();
    const cardId = findCardId(c.engine.replica, "shared");

    a.engine.setOnline(false); // partition: {a} | {b, c, relay}
    a.clock.time = 3_000;
    b.clock.time = 3_000;
    c.clock.time = 3_000;
    await a.engine.mutate((d) => d.moveCard(cardId, "col-done", 0));
    await a.engine.mutate((d) => d.createColumn("A-only column"));
    await b.engine.mutate((d) => d.updateCard(cardId, { description: "majority note" }));
    await c.engine.mutate((d) => d.renameColumn("col-todo", "Backlog"));
    await net.settle();

    expect(b.engine.fingerprint()).toBe(c.engine.fingerprint());
    expect(a.engine.fingerprint()).not.toBe(b.engine.fingerprint());

    a.engine.setOnline(true);
    await net.settle();
    for (const p of [a, b, c]) {
      const board = p.engine.getState().board;
      expect(board.columns.map((col) => col.title)).toEqual(["Backlog", "In Progress", "Done", "A-only column"]);
      expect(board.columns[2]?.cards[0]).toMatchObject({ title: "shared", description: "majority note" });
    }
    expect(new Set([a, b, c].map((p) => p.engine.fingerprint())).size).toBe(1);
  });

  it("delivers updates between peers that are never online at the same time (store-and-forward)", async () => {
    const net = new SimulatedNetwork();
    const a = await createPeer(net, "early-bird");
    a.engine.start();
    await net.settle();
    await a.engine.mutate((d) => d.createCard({ columnId: "col-todo", title: "left a note" }));
    await net.settle();
    a.engine.dispose();

    const b = await createPeer(net, "night-owl");
    b.engine.start();
    await net.settle();
    expect(b.engine.getState().board.columns[0]?.cards.map((c) => c.title)).toEqual(["left a note"]);
  });

  it("re-pushes full history after a relay restart wipes the server log", async () => {
    const net = new SimulatedNetwork();
    const a = await createPeer(net, "a");
    a.engine.start();
    await net.settle();
    await a.engine.mutate((d) => d.createCard({ columnId: "col-todo", title: "survives restarts" }));
    await net.settle();
    expect(a.engine.getState().outbox).toEqual([]);

    net.restartServer();
    expect(a.engine.getState().status).toBe("connecting");
    a.clock.advance(1_000);
    await net.settle();
    expect(a.engine.getState().status).toBe("synced");
    expect(net.room.summary().board.columns[0]?.cards.map((c) => c.title)).toEqual(["survives restarts"]);

    const late = await createPeer(net, "late");
    late.engine.start();
    await net.settle();
    expect(late.engine.fingerprint()).toBe(a.engine.fingerprint());
  });

  it("survives rapid offline/online toggling without duplicate effects", async () => {
    const net = new SimulatedNetwork();
    const a = await createPeer(net, "flapper");
    const b = await createPeer(net, "observer");
    a.engine.start();
    b.engine.start();
    await net.settle();
    for (let i = 0; i < 5; i += 1) {
      a.engine.setOnline(false);
      await a.engine.mutate((d) => d.createCard({ columnId: "col-todo", title: `flap ${i}` }));
      a.engine.setOnline(true); // toggled back before the old connection's traffic settles
    }
    await net.settle();
    expect(b.engine.getState().board.columns[0]?.cards).toHaveLength(5);
    expect(a.engine.fingerprint()).toBe(b.engine.fingerprint());
    expect(net.room.summary().logSize).toBe(5);
  });
});
