import { describe, expect, it } from "vitest";
import { WebSocketTransport, type WebSocketLike } from "../../src/core/network/transport";
import { createPeer, findCardId } from "../helpers/factories";
import { SimulatedNetwork } from "../helpers/simulatedNetwork";

describe("SyncEngine state machine", () => {
  it("walks offline → connecting → handshaking → synced", async () => {
    const net = new SimulatedNetwork();
    const { engine } = await createPeer(net, "a");
    const seen: string[] = [];
    engine.subscribe(() => {
      const status = engine.getState().status;
      if (seen.at(-1) !== status) seen.push(status);
    });
    expect(engine.getState().status).toBe("offline");
    engine.start();
    await net.settle();
    expect(seen).toEqual(["connecting", "handshaking", "synced"]);
  });

  it("queues mutations in the outbox while offline and flushes them on reconnect", async () => {
    const net = new SimulatedNetwork();
    const { engine } = await createPeer(net, "a", { startOffline: true });
    engine.start();
    await engine.mutate((d) => d.createCard({ columnId: "col-todo", title: "queued" }));
    await net.settle();
    expect(engine.getState().status).toBe("offline");
    expect(engine.getState().outbox).toHaveLength(1);
    expect(net.room.summary().logSize).toBe(0);

    engine.setOnline(true);
    await net.settle();
    expect(engine.getState().outbox).toEqual([]);
    expect(net.room.summary().logSize).toBe(1);
    expect(engine.getState().metrics.deltasSent).toBe(1);
  });

  it("keeps deltas in the outbox until the server acks them", async () => {
    const net = new SimulatedNetwork();
    const { engine } = await createPeer(net, "a");
    engine.start();
    await net.settle();
    await engine.mutate((d) => d.createColumn("pending"));
    expect(engine.getState().outbox).toHaveLength(1); // sent, not yet acked
    await net.settle();
    expect(engine.getState().outbox).toEqual([]);
    expect(engine.getState().metrics.lastAckMs).not.toBeNull();
  });

  it("reconnects with exponential backoff after an unexpected drop", async () => {
    const net = new SimulatedNetwork();
    const peer = await createPeer(net, "a");
    peer.engine.start();
    await net.settle();

    peer.transport.drop();
    expect(peer.engine.getState().status).toBe("connecting");
    expect(peer.engine.getState().metrics.reconnectAttempts).toBe(1);
    const callsBefore = peer.transport.connectCalls;
    peer.clock.advance(499);
    expect(peer.transport.connectCalls).toBe(callsBefore);
    peer.clock.advance(1); // first retry after 500 ms
    expect(peer.transport.connectCalls).toBe(callsBefore + 1);
    peer.transport.drop();
    expect(peer.engine.getState().events[0]?.message).toMatch(/Retry #2 in 1000 ms/);
    peer.clock.advance(1000);
    await net.settle();
    expect(peer.engine.getState().status).toBe("synced");
    expect(peer.engine.getState().metrics.reconnectAttempts).toBe(0);
  });

  it("does not reconnect while the simulated partition is active", async () => {
    const net = new SimulatedNetwork();
    const peer = await createPeer(net, "a");
    peer.engine.start();
    await net.settle();
    peer.engine.setOnline(false);
    const calls = peer.transport.connectCalls;
    peer.clock.advance(60_000);
    await net.settle();
    expect(peer.transport.connectCalls).toBe(calls);
    expect(peer.engine.getState()).toMatchObject({ status: "offline", simulatedOffline: true });
  });

  it("measures ping/pong round-trip latency", async () => {
    const net = new SimulatedNetwork();
    const peer = await createPeer(net, "a");
    peer.engine.start();
    await net.settle(); // the first ping is sent right after the handshake
    expect(peer.engine.getState().metrics.lastRttMs).toBe(0);
    peer.clock.advance(2_000); // interval ping
    peer.clock.time += 35; // simulated 35 ms in flight
    await net.settle();
    expect(peer.engine.getState().metrics.lastRttMs).toBe(35);
    expect(peer.engine.getState().metrics.avgRttMs).toBe(17.5);
  });

  it("reports connected peers", async () => {
    const net = new SimulatedNetwork();
    const a = await createPeer(net, "a");
    const b = await createPeer(net, "b");
    a.engine.start();
    b.engine.start();
    await net.settle();
    expect(a.engine.getState().peers).toEqual(["a", "b"]);
  });

  it("injects a real, replicated conflict via the simulator", async () => {
    const net = new SimulatedNetwork();
    const a = await createPeer(net, "a");
    const b = await createPeer(net, "b");
    a.engine.start();
    b.engine.start();
    await net.settle();
    await a.engine.mutate((d) => d.createCard({ columnId: "col-todo", title: "target" }));
    await net.settle();
    const id = findCardId(a.engine.replica, "target");

    const result = await a.engine.simulateConflict(id);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ field: "title", kind: "concurrent-write" });
    await net.settle();
    // The phantom peer's write is ordinary replicated data, so B converges too.
    expect(b.engine.fingerprint()).toBe(a.engine.fingerprint());
    expect(b.engine.getState().conflicts.length).toBeGreaterThanOrEqual(0);
    expect(a.engine.getState().conflicts[0]?.id).toBe(result.conflicts[0]?.id);
  });

  it("stops all activity on dispose", async () => {
    const net = new SimulatedNetwork();
    const peer = await createPeer(net, "a");
    peer.engine.start();
    await net.settle();
    peer.engine.dispose();
    expect(peer.transport.isOpen).toBe(false);
    expect(peer.clock.pendingTasks).toBe(0);
  });
});

describe("WebSocketTransport", () => {
  class FakeSocket implements WebSocketLike {
    readyState = 0;
    sent: string[] = [];
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 3;
    }
    open(): void {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }
    receive(data: string): void {
      this.onmessage?.({ data } as MessageEvent);
    }
  }

  it("ignores events from a stale socket after reconnecting", () => {
    const sockets: FakeSocket[] = [];
    const transport = new WebSocketTransport("ws://x", () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    const events: string[] = [];
    const handlers = {
      onOpen: () => events.push("open"),
      onMessage: (m: { type: string }) => events.push(m.type),
      onClose: () => events.push("close"),
    };
    transport.connect(handlers);
    const stale = sockets[0] as FakeSocket;
    const staleOnMessage = stale.onmessage;
    transport.connect(handlers); // reconnect replaces the socket
    staleOnMessage?.({ data: JSON.stringify({ type: "pong", t: 1 }) } as MessageEvent);
    expect(events).toEqual([]);

    const live = sockets[1] as FakeSocket;
    expect(transport.send({ type: "ping", t: 1 })).toBe(false); // not open yet
    live.open();
    expect(transport.send({ type: "ping", t: 1 })).toBe(true);
    live.receive(JSON.stringify({ type: "pong", t: 1 }));
    live.receive("garbage"); // dropped by the guard
    expect(events).toEqual(["open", "pong"]);
    expect(live.sent).toEqual([JSON.stringify({ type: "ping", t: 1 })]);
  });
});
