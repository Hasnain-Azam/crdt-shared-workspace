/**
 * Deterministic, adversarial in-memory network for protocol tests.
 *
 * Every message is round-tripped through the real JSON encoder and the
 * runtime guards, exactly as on a socket. Messages wait in a queue until
 * `settle()` delivers them. Server→client delta traffic can be reordered,
 * duplicated or dropped to model a hostile network.
 */
import { encodeMessage, parseClientMessage, parseServerMessage, type ClientMessage, type ServerMessage } from "../../src/core/network/protocol";
import type { Scheduler } from "../../src/core/network/syncEngine";
import type { Transport, TransportHandlers } from "../../src/core/network/transport";
import { Room, type PeerConnection } from "../../server/room";

export interface DeliveryPolicy {
  /** Shuffles reorderable messages within each delivery round. */
  readonly shuffle?: boolean;
  /** Probability [0,1] of delivering a reorderable message twice. */
  readonly duplicateRate?: number;
  /** Probability [0,1] of dropping a reorderable message entirely. */
  readonly dropRate?: number;
}

interface QueuedMessage {
  readonly reorderable: boolean;
  readonly deliver: () => void;
}

/** Seeded PRNG (mulberry32), so adversarial runs are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatedNetwork {
  room: Room;
  private queue: QueuedMessage[] = [];
  private readonly transports = new Set<InMemoryTransport>();
  policy: DeliveryPolicy = {};

  constructor(
    roomId = "test-room",
    private readonly random: () => number = seededRandom(42),
  ) {
    this.room = new Room(roomId);
  }

  createTransport(): InMemoryTransport {
    const transport = new InMemoryTransport(this);
    this.transports.add(transport);
    return transport;
  }

  /** Simulates a relay restart: every connection drops and the server forgets all state. */
  restartServer(): void {
    for (const transport of this.transports) transport.serverDropped();
    this.queue = [];
    this.room = new Room(this.room.id);
  }

  enqueue(message: QueuedMessage): void {
    this.queue.push(message);
  }

  get pending(): number {
    return this.queue.length;
  }

  /**
   * Delivers messages until the network is quiet, yielding to the event loop
   * between rounds so async engine handlers (storage writes) can finish.
   */
  async settle(maxRounds = 200): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      await flushAsync();
      if (this.queue.length === 0) {
        await flushAsync();
        if (this.queue.length === 0) return;
      }
      const batch = this.queue;
      this.queue = [];
      for (const message of this.arrange(batch)) message.deliver();
    }
    throw new Error("Network did not settle (possible message loop)");
  }

  private arrange(batch: QueuedMessage[]): QueuedMessage[] {
    const { shuffle = false, duplicateRate = 0, dropRate = 0 } = this.policy;
    const out: QueuedMessage[] = [];
    for (const message of batch) {
      if (message.reorderable && this.random() < dropRate) continue;
      out.push(message);
      if (message.reorderable && this.random() < duplicateRate) out.push(message);
    }
    if (shuffle) {
      // Fisher–Yates over the reorderable messages only. Control frames keep their slots so each connection's lifecycle stays valid.
      const slots = out.map((m, i) => (m.reorderable ? i : -1)).filter((i) => i >= 0);
      const items = slots.map((i) => out[i] as QueuedMessage);
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(this.random() * (i + 1));
        [items[i], items[j]] = [items[j] as QueuedMessage, items[i] as QueuedMessage];
      }
      slots.forEach((slot, k) => (out[slot] = items[k] as QueuedMessage));
    }
    return out;
  }
}

/** The server learns a peer's id from its hello, so the in-memory peer's id is assigned late. */
type MutablePeer = { -readonly [K in keyof PeerConnection]: PeerConnection[K] };

export class InMemoryTransport implements Transport {
  private connection: { handlers: TransportHandlers; peer: MutablePeer; room: Room; open: boolean } | null = null;
  connectCalls = 0;

  constructor(private readonly network: SimulatedNetwork) {}

  connect(handlers: TransportHandlers): void {
    this.disconnect();
    this.connectCalls += 1;
    const room = this.network.room;
    const connection = {
      handlers,
      room,
      open: false,
      peer: {
        id: "pending",
        send: (message: ServerMessage): void => {
          const wire = encodeMessage(message);
          const reorderable = message.type === "deltas" || message.type === "sync";
          this.network.enqueue({
            reorderable,
            deliver: () => {
              if (this.connection !== connection) return;
              const parsed = parseServerMessage(wire);
              if (parsed === null) throw new Error(`invalid server message: ${wire}`);
              handlers.onMessage(parsed);
            },
          });
        },
      } as MutablePeer,
    };
    this.connection = connection;
    this.network.enqueue({
      reorderable: false,
      deliver: () => {
        if (this.connection !== connection) return;
        connection.open = true;
        handlers.onOpen();
      },
    });
  }

  send(message: ClientMessage): boolean {
    const connection = this.connection;
    if (connection === null || !connection.open) return false;
    const wire = encodeMessage(message);
    this.network.enqueue({
      reorderable: false,
      deliver: () => {
        if (this.connection !== connection) return;
        const parsed = parseClientMessage(wire);
        if (parsed === null) throw new Error(`invalid client message: ${wire}`);
        switch (parsed.type) {
          case "hello":
            connection.peer.id = parsed.clientId;
            connection.room.join(connection.peer, parsed.context);
            return;
          case "deltas":
            connection.room.receive(connection.peer, parsed.deltas);
            return;
          case "ping":
            connection.peer.send({ type: "pong", t: parsed.t });
            return;
        }
      },
    });
    return true;
  }

  disconnect(): void {
    const connection = this.connection;
    if (connection === null) return;
    this.connection = null;
    connection.room.leave(connection.peer);
  }

  /** Abrupt connection loss (not initiated by the client): fires onClose. */
  drop(reason = "network failure"): void {
    const connection = this.connection;
    if (connection === null) return;
    this.connection = null;
    connection.room.leave(connection.peer);
    connection.handlers.onClose(reason);
  }

  serverDropped(): void {
    this.drop("server restarted");
  }

  get isOpen(): boolean {
    return this.connection?.open ?? false;
  }
}

/** Lets pending promise continuations and macrotasks run. */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Manually advanced clock + scheduler, for deterministic timing tests. */
export class ManualClock implements Scheduler {
  private tasks: { at: number; fn: () => void; every: number | null; id: number }[] = [];
  private nextId = 0;

  constructor(public time = 1_000) {}

  readonly now = (): number => this.time;

  schedule(fn: () => void, ms: number): () => void {
    return this.add(fn, ms, null);
  }

  every(fn: () => void, ms: number): () => void {
    return this.add(fn, ms, ms);
  }

  /** Advances time, running due tasks in order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.tasks.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.time = due.at;
      if (due.every === null) this.tasks = this.tasks.filter((t) => t.id !== due.id);
      else due.at += due.every;
      due.fn();
    }
    this.time = target;
  }

  get pendingTasks(): number {
    return this.tasks.length;
  }

  private add(fn: () => void, ms: number, every: number | null): () => void {
    const id = this.nextId++;
    this.tasks.push({ at: this.time + ms, fn, every, id });
    return () => {
      this.tasks = this.tasks.filter((t) => t.id !== id);
    };
  }
}
