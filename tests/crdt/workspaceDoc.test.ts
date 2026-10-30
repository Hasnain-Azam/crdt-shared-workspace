import { describe, expect, it } from "vitest";
import { canonicalize, RECOVERED_COLUMN_ID, WorkspaceDoc } from "../../src/core/crdt";
import { findCardId, replica } from "../helpers/factories";

describe("WorkspaceDoc", () => {
  it("starts from the shared deterministic genesis board", () => {
    const a = new WorkspaceDoc({ nodeId: "a" });
    const b = new WorkspaceDoc({ nodeId: "b" });
    expect(a.view().columns.map((c) => c.title)).toEqual(["To Do", "In Progress", "Done"]);
    expect(canonicalize(a.state)).toBe(canonicalize(b.state));
  });

  it("performs CRUD on cards and columns and materialises the board", () => {
    const { doc } = replica("a");
    const col = doc.view().columns[0]?.id as string;
    doc.createCard({ columnId: col, title: "one" });
    doc.createCard({ columnId: col, title: "two", color: "rose" });
    const two = findCardId(doc, "two");
    doc.updateCard(two, { description: "details" });
    doc.moveCard(two, col, 0);
    expect(doc.view().columns[0]?.cards.map((c) => c.title)).toEqual(["two", "one"]);
    expect(doc.view().columns[0]?.cards[0]).toMatchObject({ color: "rose", description: "details", lastEditedBy: "a" });

    doc.deleteCard(findCardId(doc, "one"));
    expect(doc.view().columns[0]?.cards.map((c) => c.title)).toEqual(["two"]);

    doc.createColumn("Review");
    expect(doc.view().columns.at(-1)?.title).toBe("Review");
    doc.renameColumn(col, "Backlog");
    expect(doc.view().columns[0]?.title).toBe("Backlog");
    doc.deleteColumn(col);
    expect(doc.view().columns.map((c) => c.title)).toEqual(["In Progress", "Done", "Review"]);
    // Deleting a column also tombstones its cards in the same delta.
    expect(doc.view().columns.some((c) => c.id === RECOVERED_COLUMN_ID)).toBe(false);
  });

  it("assigns sequential dots and carries the pre-mutation context in each delta", () => {
    const { doc } = replica("a");
    const col = doc.view().columns[0]?.id as string;
    const d1 = doc.createCard({ columnId: col, title: "x" });
    const d2 = doc.updateCard(d1.op.entityId, { title: "y" });
    expect(d1.dot).toEqual({ node: "a", seq: 1 });
    expect(d2.dot).toEqual({ node: "a", seq: 2 });
    expect(d1.context).toEqual({ clock: {}, cloud: {} });
    expect(d2.context).toEqual({ clock: { a: 1 }, cloud: {} });
    expect(doc.context).toEqual({ clock: { a: 2 }, cloud: {} });
  });

  it("treats re-applying a known delta as a no-op (idempotence)", () => {
    const a = replica("a").doc;
    const b = replica("b").doc;
    const delta = a.createCard({ columnId: "col-todo", title: "x" });
    expect(b.apply(delta).status).toBe("applied");
    const before = canonicalize(b.state);
    expect(b.apply(delta).status).toBe("duplicate");
    expect(canonicalize(b.state)).toBe(before);
  });

  it("does not report a conflict for a causal overwrite", () => {
    const a = replica("a").doc;
    const b = replica("b", 2_000).doc;
    const create = a.createCard({ columnId: "col-todo", title: "v1" });
    b.apply(create);
    const edit = b.updateCard(create.op.entityId, { title: "v2" }); // b has seen v1
    expect(a.apply(edit).conflicts).toEqual([]);
  });

  it("detects a concurrent same-field write and names the HLC winner", () => {
    const a = replica("a", 1_000);
    const b = replica("b", 1_000);
    const create = a.doc.createCard({ columnId: "col-todo", title: "base" });
    b.doc.apply(create);
    a.clock.time = 1_100;
    b.clock.time = 1_250;
    const fromA = a.doc.updateCard(create.op.entityId, { title: "A" });
    const fromB = b.doc.updateCard(create.op.entityId, { title: "B" });

    const onA = a.doc.apply(fromB).conflicts;
    const onB = b.doc.apply(fromA).conflicts;
    expect(onA).toHaveLength(1);
    expect(onA[0]).toMatchObject({ kind: "concurrent-write", field: "title", winner: "remote", local: { value: '"A"' }, remote: { value: '"B"' } });
    expect(onB[0]).toMatchObject({ field: "title", winner: "local" });
    expect(onA[0]?.id).toBe(onB[0]?.id); // both replicas name the same conflict
    expect(onA[0]?.explanation).toMatch(/wall time/);
    expect(a.doc.view()).toEqual(b.doc.view());
  });

  it("preserves concurrent edits to different fields of the same card", () => {
    const a = replica("a").doc;
    const b = replica("b").doc;
    const create = a.createCard({ columnId: "col-todo", title: "base" });
    b.apply(create);
    const t = a.updateCard(create.op.entityId, { title: "renamed by A" });
    const c = b.updateCard(create.op.entityId, { color: "emerald" });
    expect(a.apply(c).conflicts).toEqual([]);
    b.apply(t);
    expect(a.view().columns[0]?.cards[0]).toMatchObject({ title: "renamed by A", color: "emerald" });
    expect(a.view()).toEqual(b.view());
  });

  it("logs delete-vs-edit and keeps the card deleted", () => {
    const a = replica("a", 1_000);
    const b = replica("b", 1_000);
    const create = a.doc.createCard({ columnId: "col-todo", title: "doomed" });
    b.doc.apply(create);
    a.clock.time = 1_500;
    b.clock.time = 1_200;
    const del = a.doc.deleteCard(create.op.entityId);
    const edit = b.doc.updateCard(create.op.entityId, { title: "edited" });
    const onB = b.doc.apply(del).conflicts;
    expect(onB).toEqual([expect.objectContaining({ kind: "delete-vs-edit", winner: "remote" })]);
    expect(a.doc.apply(edit).conflicts).toEqual([expect.objectContaining({ kind: "delete-vs-edit", winner: "local" })]);
    expect(b.doc.view().columns[0]?.cards).toEqual([]);
    expect(a.doc.view()).toEqual(b.doc.view());
  });

  it("moves a card concurrently moved into a deleted column to the Recovered lane", () => {
    const a = replica("a").doc;
    const b = replica("b").doc;
    const card = a.createCard({ columnId: "col-todo", title: "wanderer" });
    b.apply(card);
    const deleteDone = a.deleteColumn("col-done");
    const move = b.moveCard(card.op.entityId, "col-done", 0);
    a.apply(move);
    b.apply(deleteDone);
    const lane = a.view().columns.at(-1);
    expect(lane?.id).toBe(RECOVERED_COLUMN_ID);
    expect(lane?.cards.map((c) => c.title)).toEqual(["wanderer"]);
    expect(a.view()).toEqual(b.view());
  });

  it("hides a card until its create arrives when an edit is delivered first", () => {
    const a = replica("a").doc;
    const b = replica("b").doc;
    const create = a.createCard({ columnId: "col-todo", title: "v1" });
    const edit = a.updateCard(create.op.entityId, { title: "v2" });
    b.apply(edit);
    expect(b.view().columns[0]?.cards).toEqual([]);
    expect(b.context.cloud).toEqual({ a: [2] });
    b.apply(create);
    expect(b.view().columns[0]?.cards.map((c) => c.title)).toEqual(["v2"]);
    expect(b.context).toEqual({ clock: { a: 2 }, cloud: {} });
  });

  it("round-trips through a snapshot and continues the dot sequence", () => {
    const a = replica("a").doc;
    a.createCard({ columnId: "col-todo", title: "x" });
    const restored = new WorkspaceDoc({ nodeId: "a", snapshot: structuredClone(a.snapshot()) });
    expect(restored.view()).toEqual(a.view());
    expect(restored.createColumn("next").dot).toEqual({ node: "a", seq: 2 });
    expect(() => new WorkspaceDoc({ nodeId: "b", snapshot: a.snapshot() })).toThrow(/belongs to node/);
  });

  it("merge() resolves state from a forked replica and reports conflicts", () => {
    const a = replica("a", 1_000);
    const create = a.doc.createCard({ columnId: "col-todo", title: "base" });
    const fork = a.doc.fork("fork", () => 2_000);
    fork.updateCard(create.op.entityId, { title: "fork wins" });
    a.doc.updateCard(create.op.entityId, { title: "local loses" });
    const { conflicts } = a.doc.merge({ state: fork.state, context: fork.context, clock: fork.clock });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.winner).toBe("remote");
    expect(a.doc.view().columns[0]?.cards[0]?.title).toBe("fork wins");
  });

  it("never reports genesis writes as conflicts (seq-0 dots are known by everyone)", () => {
    const a = replica("a").doc;
    const b = replica("b").doc;
    expect(a.apply(b.renameColumn("col-todo", "Backlog")).conflicts).toEqual([]);
    expect(a.view().columns[0]?.title).toBe("Backlog");
  });

  it("rejects mutations on unknown entities", () => {
    const { doc } = replica("a");
    expect(() => doc.createCard({ columnId: "nope", title: "x" })).toThrow(/Unknown column/);
    expect(() => doc.updateCard("nope", { title: "x" })).toThrow(/Unknown card/);
    expect(() => doc.moveCard("nope", "col-todo", 0)).toThrow(/Unknown card/);
  });
});
