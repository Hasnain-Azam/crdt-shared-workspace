import { describe, expect, it } from "vitest";
import { WorkspaceDoc } from "../../src/core/crdt";
import { encodeMessage, isDelta, parseClientMessage, parseServerMessage } from "../../src/core/network/protocol";

const delta = new WorkspaceDoc({ nodeId: "a" }).createCard({ columnId: "col-todo", title: "x" });

describe("wire protocol", () => {
  it("round-trips valid client messages", () => {
    const hello = { type: "hello", clientId: "a", room: "r", context: { clock: { a: 1 }, cloud: { b: [3] } } } as const;
    expect(parseClientMessage(encodeMessage(hello))).toEqual(hello);
    expect(parseClientMessage(encodeMessage({ type: "deltas", deltas: [delta] }))).toEqual({ type: "deltas", deltas: [delta] });
    expect(parseClientMessage(encodeMessage({ type: "ping", t: 5 }))).toEqual({ type: "ping", t: 5 });
  });

  it("round-trips valid server messages", () => {
    const messages = [
      { type: "sync", deltas: [delta], context: { clock: {}, cloud: {} } },
      { type: "deltas", deltas: [delta], from: "b" },
      { type: "ack", dots: [{ node: "a", seq: 1 }] },
      { type: "pong", t: 1 },
      { type: "peers", peers: ["a", "b"] },
      { type: "error", message: "nope" },
    ] as const;
    for (const m of messages) expect(parseServerMessage(encodeMessage(m))).toEqual(m);
  });

  it.each([
    ["not json", "{"],
    ["non-object", "42"],
    ["unknown type", JSON.stringify({ type: "explode" })],
    ["hello without context", JSON.stringify({ type: "hello", clientId: "a", room: "r" })],
    ["ping with string t", JSON.stringify({ type: "ping", t: "now" })],
    ["deltas not array", JSON.stringify({ type: "deltas", deltas: {} })],
  ])("rejects malformed client input: %s", (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it("deep-validates deltas (invalid register values, colors, op kinds and contexts are rejected)", () => {
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(delta)) as Record<string, unknown>;
    expect(isDelta(clone())).toBe(true);

    const badColor = clone() as { patch: { cards: Record<string, { color: { value: string } }> } };
    Object.values(badColor.patch.cards)[0]!.color.value = "neon";
    expect(isDelta(badColor)).toBe(false);

    const badOp = clone() as { op: { kind: string } };
    badOp.op.kind = "card.explode";
    expect(isDelta(badOp)).toBe(false);

    const badCtx = clone() as { context: unknown };
    badCtx.context = { clock: { a: -1 }, cloud: {} };
    expect(isDelta(badCtx)).toBe(false);

    const badTs = clone() as { ts: { wall: unknown } };
    badTs.ts.wall = "yesterday";
    expect(isDelta(badTs)).toBe(false);
  });
});
