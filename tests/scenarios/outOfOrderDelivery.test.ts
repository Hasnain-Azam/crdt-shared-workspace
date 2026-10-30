/**
 * Scenario: WebSocket messages arrive out of order, duplicated, or not at all.
 */
import { describe, expect, it } from "vitest";
import { WorkspaceDoc, type Delta } from "../../src/core/crdt";
import { createPeer, replica } from "../helpers/factories";
import { seededRandom, SimulatedNetwork } from "../helpers/simulatedNetwork";

/** Every permutation of a small array. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe("out-of-order message delivery", () => {
  it("converges for EVERY permutation of a causally dependent delta chain", () => {
    const author = replica("author").doc;
    const create = author.createCard({ columnId: "col-todo", title: "v1" });
    const id = create.op.entityId;
    const chain: Delta[] = [
      create,
      author.updateCard(id, { title: "v2" }),
      author.moveCard(id, "col-doing", 0),
      author.updateCard(id, { color: "amber", description: "final" }),
      author.createColumn("QA"),
    ];
    const expected = author.view();

    const orders = permutations(chain);
    expect(orders).toHaveLength(120);
    for (const order of orders) {
      const receiver = new WorkspaceDoc({ nodeId: "receiver" });
      for (const delta of order) receiver.apply(delta);
      expect(receiver.view()).toEqual(expected);
      expect(receiver.context).toEqual({ clock: { author: 5 }, cloud: {} });
    }
  });

  it("tracks gaps from out-of-order dots and folds them once the missing delta arrives", () => {
    const author = replica("author").doc;
    const deltas = [1, 2, 3, 4].map((i) => author.createColumn(`c${i}`));
    const receiver = new WorkspaceDoc({ nodeId: "receiver" });
    receiver.apply(deltas[3] as Delta);
    receiver.apply(deltas[1] as Delta);
    expect(receiver.context).toEqual({ clock: {}, cloud: { author: [2, 4] } });
    receiver.apply(deltas[0] as Delta);
    expect(receiver.context).toEqual({ clock: { author: 2 }, cloud: { author: [4] } });
    receiver.apply(deltas[2] as Delta);
    expect(receiver.context).toEqual({ clock: { author: 4 }, cloud: {} });
  });

  it("drops duplicate deliveries without changing state", () => {
    const author = replica("author").doc;
    const delta = author.createCard({ columnId: "col-todo", title: "x" });
    const receiver = new WorkspaceDoc({ nodeId: "receiver" });
    const results = [delta, delta, delta].map((d) => receiver.apply(d).status);
    expect(results).toEqual(["applied", "duplicate", "duplicate"]);
  });

  it.each([1, 7, 1234, 98765])("converges end-to-end over a shuffling, duplicating network (seed %i)", async (seed) => {
    const net = new SimulatedNetwork("chaos", seededRandom(seed));
    net.policy = { shuffle: true, duplicateRate: 0.3 };
    const peers = await Promise.all(["p1", "p2", "p3"].map((id, i) => createPeer(net, id, { start: 1_000 + i * 3 })));
    for (const p of peers) p.engine.start();
    await net.settle();

    const rand = seededRandom(seed + 1);
    for (let round = 0; round < 8; round += 1) {
      for (const p of peers) {
        p.clock.time += Math.floor(rand() * 10);
        const doc = p.engine.replica;
        const cards = doc.view().columns.flatMap((c) => c.cards);
        const target = cards[Math.floor(rand() * cards.length)];
        if (target === undefined || rand() < 0.4) {
          await p.engine.mutate((d) => d.createCard({ columnId: "col-todo", title: `${doc.nodeId}-r${round}` }));
        } else if (rand() < 0.5) {
          await p.engine.mutate((d) => d.updateCard(target.id, { title: `${doc.nodeId} edit r${round}` }));
        } else {
          await p.engine.mutate((d) => d.moveCard(target.id, rand() < 0.5 ? "col-doing" : "col-done", 0));
        }
      }
      // Deliver only some messages per round so updates interleave with in-flight traffic.
      if (round % 2 === 1) await net.settle();
    }
    await net.settle();

    const [first, ...rest] = peers.map((p) => p.engine.fingerprint());
    for (const fp of rest) expect(fp).toBe(first);
    expect(peers[0]?.engine.getState().metrics.duplicatesDropped).toBeGreaterThanOrEqual(0);
    for (const p of peers) expect(p.engine.getState().outbox).toEqual([]);
  });

  it("recovers from dropped fan-out messages on the next handshake (anti-entropy)", async () => {
    const net = new SimulatedNetwork("lossy", seededRandom(3));
    const a = await createPeer(net, "a");
    const b = await createPeer(net, "b");
    a.engine.start();
    b.engine.start();
    await net.settle();

    net.policy = { dropRate: 1 }; // every server→client delta fan-out is lost
    await a.engine.mutate((d) => d.createCard({ columnId: "col-todo", title: "lost in transit" }));
    await net.settle();
    expect(b.engine.getState().board.columns[0]?.cards).toEqual([]);

    net.policy = {};
    b.transport.drop("flaky wifi");
    b.clock.advance(10_000); // reconnect backoff fires
    await net.settle();
    expect(b.engine.getState().board.columns[0]?.cards.map((c) => c.title)).toEqual(["lost in transit"]);
    expect(a.engine.fingerprint()).toBe(b.engine.fingerprint());
  });
});
