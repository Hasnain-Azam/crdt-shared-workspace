import { describe, expect, it } from "vitest";
import { EMPTY_CONTEXT, WorkspaceDoc } from "../../src/core/crdt";
import type { ServerMessage } from "../../src/core/network/protocol";
import { Room, type PeerConnection } from "../../server/room";

function peer(id: string): PeerConnection & { inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = [];
  return { id, inbox, send: (m) => inbox.push(m) };
}

const ofType = <T extends ServerMessage["type"]>(inbox: ServerMessage[], type: T): Extract<ServerMessage, { type: T }>[] =>
  inbox.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);

describe("Room (relay server)", () => {
  it("replies to hello with exactly the deltas the peer is missing", () => {
    const room = new Room("r");
    const author = new WorkspaceDoc({ nodeId: "a" });
    const d1 = author.createColumn("one");
    const d2 = author.createColumn("two");
    const a = peer("a");
    room.join(a, EMPTY_CONTEXT);
    room.receive(a, [d1, d2]);

    const fresh = peer("b");
    room.join(fresh, EMPTY_CONTEXT);
    expect(ofType(fresh.inbox, "sync")[0]?.deltas.map((d) => d.dot.seq)).toEqual([1, 2]);

    const partial = peer("c");
    room.join(partial, { clock: { a: 1 }, cloud: {} });
    expect(ofType(partial.inbox, "sync")[0]?.deltas.map((d) => d.dot.seq)).toEqual([2]);
    expect(ofType(partial.inbox, "sync")[0]?.context).toEqual({ clock: { a: 2 }, cloud: {} });
  });

  it("acks every received dot (including duplicates) but only fans out new deltas to OTHER peers", () => {
    const room = new Room("r");
    const delta = new WorkspaceDoc({ nodeId: "a" }).createColumn("x");
    const a = peer("a");
    const b = peer("b");
    room.join(a, EMPTY_CONTEXT);
    room.join(b, EMPTY_CONTEXT);

    room.receive(a, [delta]);
    room.receive(a, [delta]); // retransmit
    expect(ofType(a.inbox, "ack").map((m) => m.dots)).toEqual([[delta.dot], [delta.dot]]);
    expect(ofType(a.inbox, "deltas")).toEqual([]);
    expect(ofType(b.inbox, "deltas")).toHaveLength(1);
    expect(room.summary().logSize).toBe(1);
  });

  it("maintains a merged replica of the room", () => {
    const room = new Room("r");
    const a = peer("a");
    room.join(a, EMPTY_CONTEXT);
    const author = new WorkspaceDoc({ nodeId: "a" });
    room.receive(a, [author.createCard({ columnId: "col-todo", title: "on server" })]);
    expect(room.summary().board.columns[0]?.cards.map((c) => c.title)).toEqual(["on server"]);
  });

  it("broadcasts the peer list on join and leave", () => {
    const room = new Room("r");
    const a = peer("a");
    const b = peer("b");
    room.join(a, EMPTY_CONTEXT);
    room.join(b, EMPTY_CONTEXT);
    expect(ofType(a.inbox, "peers").at(-1)?.peers).toEqual(["a", "b"]);
    room.leave(b);
    expect(ofType(a.inbox, "peers").at(-1)?.peers).toEqual(["a"]);
    expect(room.peerCount).toBe(1);
  });
});
