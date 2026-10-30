/**
 * Scenario: User A and User B edit the SAME field while both are offline,
 * then reconnect at the same moment.
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/core/crdt";
import { createPeer, findCardId } from "../helpers/factories";
import { SimulatedNetwork } from "../helpers/simulatedNetwork";

async function setup(): Promise<{
  net: SimulatedNetwork;
  a: Awaited<ReturnType<typeof createPeer>>;
  b: Awaited<ReturnType<typeof createPeer>>;
  cardId: string;
}> {
  const net = new SimulatedNetwork();
  const a = await createPeer(net, "user-a", { start: 1_000 });
  const b = await createPeer(net, "user-b", { start: 1_000 });
  a.engine.start();
  b.engine.start();
  await net.settle();
  await a.engine.mutate((doc) => doc.createCard({ columnId: "col-todo", title: "Write spec" }));
  await net.settle();
  return { net, a, b, cardId: findCardId(b.engine.replica, "Write spec") };
}

describe("offline concurrent edit → simultaneous reconnect", () => {
  it("converges all replicas, keeps the HLC winner, and logs the conflict on both sides", async () => {
    const { net, a, b, cardId } = await setup();

    a.engine.setOnline(false);
    b.engine.setOnline(false);
    expect(a.engine.getState().status).toBe("offline");

    a.clock.time = 5_000;
    b.clock.time = 5_040; // B edits 40 ms later in wall-clock time
    await a.engine.mutate((doc) => doc.updateCard(cardId, { title: "Spec (A)" }));
    await b.engine.mutate((doc) => doc.updateCard(cardId, { title: "Spec (B)" }));
    // Non-conflicting concurrent edits to *other* fields must both survive.
    await a.engine.mutate((doc) => doc.updateCard(cardId, { description: "added offline by A" }));
    await b.engine.mutate((doc) => doc.updateCard(cardId, { color: "violet" }));

    expect(a.engine.getState().outbox).toHaveLength(2);
    expect(b.engine.getState().outbox).toHaveLength(2);

    // Reconnect simultaneously: both handshakes are in flight together.
    a.engine.setOnline(true);
    b.engine.setOnline(true);
    await net.settle();

    for (const peer of [a, b]) {
      const state = peer.engine.getState();
      expect(state.status).toBe("synced");
      expect(state.outbox).toEqual([]);
      const card = state.board.columns[0]?.cards[0];
      expect(card).toMatchObject({ title: "Spec (B)", description: "added offline by A", color: "violet" });
    }
    expect(a.engine.fingerprint()).toBe(b.engine.fingerprint());
    expect(canonicalize(net.room.summary().board)).toBe(canonicalize(a.engine.getState().board));
    expect(a.engine.replica.context).toEqual(b.engine.replica.context);

    const conflictA = a.engine.getState().conflicts.find((c) => c.field === "title");
    const conflictB = b.engine.getState().conflicts.find((c) => c.field === "title");
    expect(conflictA).toMatchObject({ winner: "remote", local: { value: '"Spec (A)"' }, remote: { value: '"Spec (B)"' } });
    expect(conflictB).toMatchObject({ winner: "local", local: { value: '"Spec (B)"' }, remote: { value: '"Spec (A)"' } });
    expect(conflictA?.id).toBe(conflictB?.id);
    expect(conflictA?.explanation).toMatch(/wall time \(\+40 ms\)/);
    // No false positives: the description/color edits were not conflicts.
    expect(a.engine.getState().conflicts.filter((c) => c.field !== "title")).toEqual([]);
  });

  it("resolves an exact wall-clock tie with the node-id tiebreak, identically everywhere", async () => {
    const { net, a, b, cardId } = await setup();
    a.engine.setOnline(false);
    b.engine.setOnline(false);
    a.clock.time = 9_000;
    b.clock.time = 9_000;
    await a.engine.mutate((doc) => doc.updateCard(cardId, { title: "tie-A" }));
    await b.engine.mutate((doc) => doc.updateCard(cardId, { title: "tie-B" }));
    a.engine.setOnline(true);
    b.engine.setOnline(true);
    await net.settle();
    // Equal (wall, counter), so "user-b" > "user-a" decides.
    expect(a.engine.getState().board.columns[0]?.cards[0]?.title).toBe("tie-B");
    expect(a.engine.fingerprint()).toBe(b.engine.fingerprint());
    expect(a.engine.getState().conflicts[0]?.explanation).toMatch(/node-id tiebreak/);
  });

  it("lets a writer with a skewed-behind clock still win if it wrote causally later", async () => {
    const { net, a, b, cardId } = await setup();
    // B's clock is ten seconds behind but it sees A's edit first, so its HLC is lifted above A's.
    a.clock.time = 20_000;
    b.clock.time = 10_000;
    await a.engine.mutate((doc) => doc.updateCard(cardId, { title: "first" }));
    await net.settle();
    await b.engine.mutate((doc) => doc.updateCard(cardId, { title: "second (causal)" }));
    await net.settle();
    expect(a.engine.getState().board.columns[0]?.cards[0]?.title).toBe("second (causal)");
    expect(a.engine.getState().conflicts).toEqual([]);
  });

  it("handles a concurrent delete vs edit made offline", async () => {
    const { net, a, b, cardId } = await setup();
    a.engine.setOnline(false);
    b.engine.setOnline(false);
    a.clock.time = 7_000;
    b.clock.time = 7_100;
    await a.engine.mutate((doc) => doc.deleteCard(cardId));
    await b.engine.mutate((doc) => doc.updateCard(cardId, { title: "edited while deleted" }));
    a.engine.setOnline(true);
    b.engine.setOnline(true);
    await net.settle();
    expect(a.engine.getState().board.columns[0]?.cards).toEqual([]);
    expect(a.engine.fingerprint()).toBe(b.engine.fingerprint());
    expect(b.engine.getState().conflicts[0]).toMatchObject({ kind: "delete-vs-edit", winner: "remote" });
  });
});
