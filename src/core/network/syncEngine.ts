/**
 * SyncEngine: orchestrates replica, storage and transport.
 *
 * State machine:
 *
 *            setOnline(false) / disposed
 *   ┌──────────────────────────────────────────────────────┐
 *   ▼                                                      │
 * OFFLINE ─setOnline(true)─▶ CONNECTING ─open─▶ HANDSHAKING ─sync─▶ SYNCED
 *                              ▲      │                │               │
 *                              │      └─close─┐        │close          │close
 *                              └──backoff─────┴────────┴───────────────┘
 *
 * Invariants:
 *   - Write-through: every local mutation is joined into the replica and
 *     committed to storage (state plus delta, atomically) before anything
 *     is sent.
 *   - Outbox = { δ ∈ log | dot(δ) ∉ serverContext }. Deltas leave the
 *     outbox only when the server acks them. Lost messages are re-pushed on
 *     the next handshake. Duplicates are harmless because merge is idempotent.
 *   - Hydration happens in `SyncEngine.open()`, before any network I/O.
 */
import {
  addDot,
  canonicalize,
  DeltaLog,
  EMPTY_CONTEXT,
  WorkspaceDoc,
  type BoardView,
  type CausalContext,
  type ConflictRecord,
  type Delta,
  type Dot,
  type NodeId,
  type OperationSummary,
  type WallClock,
} from "../crdt";
import type { PersistencePort } from "../storage/types";
import type { ServerMessage } from "./protocol";
import type { Transport } from "./transport";

export type NetworkStatus = "offline" | "connecting" | "handshaking" | "synced";

/** Timer abstraction so tests can drive time deterministically. */
export interface Scheduler {
  /** Runs `fn` once after `ms`. Returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
  /** Runs `fn` every `ms`. Returns a cancel function. */
  every(fn: () => void, ms: number): () => void;
}

export const realScheduler: Scheduler = {
  schedule: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  every: (fn, ms) => {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
};

export interface SyncMetrics {
  readonly lastRttMs: number | null;
  readonly avgRttMs: number | null;
  /** Delta push → server ack round trip for the most recent ack. */
  readonly lastAckMs: number | null;
  /** Duration of the most recent hello → sync-reply handshake. */
  readonly lastHandshakeMs: number | null;
  readonly lastSyncAt: number | null;
  readonly deltasSent: number;
  readonly deltasReceived: number;
  readonly duplicatesDropped: number;
  readonly reconnectAttempts: number;
}

export interface SyncEvent {
  readonly id: number;
  readonly at: number;
  readonly level: "info" | "success" | "warn";
  readonly message: string;
}

/** Immutable snapshot of everything the UI renders. A new object is created on every change. */
export interface EngineState {
  readonly nodeId: NodeId;
  readonly room: string;
  readonly status: NetworkStatus;
  readonly simulatedOffline: boolean;
  readonly hydratedFrom: "indexeddb" | "genesis";
  readonly board: BoardView;
  readonly context: CausalContext;
  readonly serverContext: CausalContext;
  readonly outbox: readonly OperationSummary[];
  readonly conflicts: readonly ConflictRecord[];
  readonly events: readonly SyncEvent[];
  readonly peers: readonly NodeId[];
  readonly metrics: SyncMetrics;
  readonly logSize: number;
}

export interface SyncEngineOptions {
  readonly nodeId: NodeId;
  readonly room: string;
  readonly store: PersistencePort;
  readonly transport: Transport;
  readonly now?: WallClock;
  readonly scheduler?: Scheduler;
  readonly pingIntervalMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Starts with the simulated partition enabled. */
  readonly startOffline?: boolean;
}

export interface SimulationResult {
  readonly peerId: NodeId;
  readonly conflicts: readonly ConflictRecord[];
}

const MAX_EVENTS = 80;
const MAX_CONFLICTS = 100;
const RTT_WINDOW = 20;

type Listener = () => void;

export class SyncEngine {
  private readonly doc: WorkspaceDoc;
  private readonly log: DeltaLog;
  private readonly now: WallClock;
  private readonly scheduler: Scheduler;
  private readonly listeners = new Set<Listener>();
  private readonly sentAt = new Map<string, number>();
  private readonly rttSamples: number[] = [];
  private readonly hydratedFrom: "indexeddb" | "genesis";

  private status: NetworkStatus = "offline";
  private simulatedOffline: boolean;
  private serverContext: CausalContext;
  private conflicts: readonly ConflictRecord[];
  private events: readonly SyncEvent[] = [];
  private peers: readonly NodeId[] = [];
  private metrics: SyncMetrics = {
    lastRttMs: null,
    avgRttMs: null,
    lastAckMs: null,
    lastHandshakeMs: null,
    lastSyncAt: null,
    deltasSent: 0,
    deltasReceived: 0,
    duplicatesDropped: 0,
    reconnectAttempts: 0,
  };
  private eventSeq = 0;
  private handshakeStartedAt = 0;
  private cancelPing: (() => void) | null = null;
  private cancelReconnect: (() => void) | null = null;
  private disposed = false;
  private stateCache: EngineState | null = null;

  /**
   * Hydrates a replica from storage (or genesis on first run) and returns an
   * engine that hasn't touched the network yet. Call `start()` to connect.
   */
  static async open(options: SyncEngineOptions): Promise<SyncEngine> {
    const persisted = await options.store.load();
    return new SyncEngine(options, persisted);
  }

  private constructor(
    private readonly options: SyncEngineOptions,
    persisted: Awaited<ReturnType<PersistencePort["load"]>>,
  ) {
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? realScheduler;
    this.simulatedOffline = options.startOffline ?? false;
    const snapshot = persisted?.snapshot.nodeId === options.nodeId ? persisted.snapshot : undefined;
    this.doc = new WorkspaceDoc({ nodeId: options.nodeId, now: this.now, snapshot });
    this.log = new DeltaLog(snapshot !== undefined ? persisted?.deltas : []);
    this.serverContext = snapshot !== undefined ? (persisted?.serverContext ?? EMPTY_CONTEXT) : EMPTY_CONTEXT;
    this.conflicts = snapshot !== undefined ? (persisted?.conflicts ?? []) : [];
    this.hydratedFrom = snapshot !== undefined ? "indexeddb" : "genesis";
    this.pushEvent(
      "info",
      snapshot !== undefined
        ? `Hydrated from IndexedDB: ${this.log.size} deltas, ${this.outbox().length} pending in outbox`
        : "No local data. Starting from the genesis state",
    );
  }

  // ───────────────────────────── Public API ─────────────────────────────

  /** Begins networking, unless the simulated partition is on. */
  start(): void {
    if (!this.simulatedOffline) this.connect();
    else this.emit();
  }

  /** The "Go Offline" toggle: simulates a network partition. */
  setOnline(online: boolean): void {
    if (this.disposed) return;
    this.simulatedOffline = !online;
    if (online) {
      this.pushEvent("info", "Partition healed. Reconnecting and starting the background handshake");
      this.metrics = { ...this.metrics, reconnectAttempts: 0 };
      this.connect();
    } else {
      this.pushEvent("warn", "Simulated partition: socket closed. Mutations will queue in the outbox");
      this.teardownConnection();
      this.setStatus("offline");
    }
  }

  /**
   * Applies a local mutation with write-through persistence:
   *   1. join into the replica (synchronous, so the UI is never blocked on I/O),
   *   2. commit snapshot + delta to storage atomically,
   *   3. push to the server if synced (otherwise it waits in the outbox).
   */
  async mutate(mutation: (doc: WorkspaceDoc) => Delta): Promise<Delta> {
    const delta = mutation(this.doc);
    this.log.add(delta);
    const persisted = this.options.store.write({ snapshot: this.doc.snapshot(), deltas: [delta] });
    this.emit();
    await persisted;
    if (this.status === "synced") this.push([delta]);
    else this.pushEvent("info", `Queued offline: ${delta.op.label}`);
    return delta;
  }

  /**
   * Injects a real conflict. It forks a phantom peer from the current state,
   * then makes both the phantom and this replica write the same card title
   * concurrently. The phantom's delta then arrives as if over the network.
   * The phantom delta is ordinary replicated data, so it also syncs to every
   * other client.
   */
  async simulateConflict(cardId: string): Promise<SimulationResult> {
    const skew = Math.round(Math.random() * 80) - 40;
    const peerId = `sim-peer-${globalThis.crypto.randomUUID().slice(0, 4)}`;
    const phantom = this.doc.fork(peerId, () => this.now() + skew);
    const base = (this.doc.state.cards[cardId]?.title?.value ?? "Card").replace(/ \[[^\]]+\]$/, "");
    this.pushEvent("info", `Simulation: forked phantom peer ${peerId} (clock skew ${skew >= 0 ? "+" : ""}${skew} ms)`);
    await this.mutate((doc) => doc.updateCard(cardId, { title: `${base} [${this.doc.nodeId}]` }));
    const remote = phantom.updateCard(cardId, { title: `${base} [${peerId}]` });
    const conflicts = await this.ingest([remote], "simulation");
    if (this.status === "synced") this.push([remote]);
    return { peerId, conflicts };
  }

  /** Subscribes to state changes (useSyncExternalStore-compatible). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Returns the current immutable state snapshot (referentially stable between changes). */
  getState(): EngineState {
    this.stateCache ??= {
      nodeId: this.doc.nodeId,
      room: this.options.room,
      status: this.status,
      simulatedOffline: this.simulatedOffline,
      hydratedFrom: this.hydratedFrom,
      board: this.doc.view(),
      context: this.doc.context,
      serverContext: this.serverContext,
      outbox: this.outbox().map((d) => d.op),
      conflicts: this.conflicts,
      events: this.events,
      peers: this.peers,
      metrics: this.metrics,
      logSize: this.log.size,
    };
    return this.stateCache;
  }

  /** Read-only access to the replica (tests, simulations). */
  get replica(): WorkspaceDoc {
    return this.doc;
  }

  /** Canonical encoding of the replica state, used to compare convergence. */
  fingerprint(): string {
    return canonicalize(this.doc.state);
  }

  clearConflicts(): void {
    this.conflicts = [];
    void this.options.store.write({ conflicts: [] });
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.teardownConnection();
    this.listeners.clear();
  }

  // ───────────────────────────── Connection lifecycle ─────────────────────────────

  private connect(): void {
    if (this.disposed || this.simulatedOffline) return;
    this.teardownConnection();
    this.setStatus("connecting");
    this.options.transport.connect({
      onOpen: () => this.handleOpen(),
      onMessage: (message) => this.handleMessage(message),
      onClose: (reason) => this.handleClose(reason),
    });
  }

  private teardownConnection(): void {
    this.cancelPing?.();
    this.cancelPing = null;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.options.transport.disconnect();
  }

  private handleOpen(): void {
    this.setStatus("handshaking");
    this.handshakeStartedAt = this.now();
    this.options.transport.send({ type: "hello", clientId: this.doc.nodeId, room: this.options.room, context: this.doc.context });
  }

  private handleClose(reason: string): void {
    this.cancelPing?.();
    this.cancelPing = null;
    if (this.disposed || this.simulatedOffline) {
      this.setStatus("offline");
      return;
    }
    const attempt = this.metrics.reconnectAttempts + 1;
    const base = this.options.baseBackoffMs ?? 500;
    const delay = Math.min(base * 2 ** (attempt - 1), this.options.maxBackoffMs ?? 10_000);
    this.metrics = { ...this.metrics, reconnectAttempts: attempt };
    this.pushEvent("warn", `Connection lost (${reason}). Retry #${attempt} in ${delay} ms`);
    this.setStatus("connecting");
    this.cancelReconnect = this.scheduler.schedule(() => {
      this.cancelReconnect = null;
      this.connect();
    }, delay);
  }

  // ───────────────────────────── Protocol handling ─────────────────────────────

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "sync":
        void this.handleSync(message.deltas, message.context);
        return;
      case "deltas":
        void this.ingest(message.deltas, "server");
        return;
      case "ack":
        this.handleAck(message.dots);
        return;
      case "pong":
        this.recordRtt(this.now() - message.t);
        return;
      case "peers":
        this.peers = message.peers;
        this.emit();
        return;
      case "error":
        this.pushEvent("warn", `Server error: ${message.message}`);
        return;
    }
  }

  /**
   * Handshake step 2. The server has sent the deltas we're missing and its
   * own causal context. We pull its deltas (join them in), then push every
   * logged delta whose dot the server lacks. After this exchange, both
   * sides have the union of both histories.
   */
  private async handleSync(deltas: readonly Delta[], context: CausalContext): Promise<void> {
    const pulled = deltas.length;
    // The server's handshake context is authoritative, so *replace* (don't union) our view of it.
    // If the relay restarted and lost its log, this makes us re-push our whole history.
    this.serverContext = context;
    const conflicts = await this.ingest(deltas, "server");
    const missingOnServer = this.log.missingFrom(this.serverContext);
    const handshakeMs = this.now() - this.handshakeStartedAt;
    this.metrics = { ...this.metrics, lastHandshakeMs: handshakeMs, lastSyncAt: this.now(), reconnectAttempts: 0 };
    this.setStatus("synced");
    if (missingOnServer.length > 0) this.push(missingOnServer);
    this.pushEvent(
      "success",
      `Handshake complete in ${handshakeMs} ms: pulled ${pulled}, pushed ${missingOnServer.length}` +
        (conflicts.length > 0 ? `, resolved ${conflicts.length} conflict(s)` : ""),
    );
    this.startPing();
  }

  private handleAck(dots: readonly Dot[]): void {
    const at = this.now();
    let lastAckMs: number | null = this.metrics.lastAckMs;
    for (const dot of dots) {
      this.serverContext = addDot(this.serverContext, dot);
      const key = `${dot.node}:${dot.seq}`;
      const sent = this.sentAt.get(key);
      if (sent !== undefined) {
        lastAckMs = at - sent;
        this.sentAt.delete(key);
      }
    }
    this.metrics = { ...this.metrics, lastAckMs };
    void this.options.store.write({ serverContext: this.serverContext });
    this.emit();
  }

  /**
   * Joins remote deltas into the replica and persists the result. Duplicates
   * are dropped (idempotence), and reordering is safe (commutativity). Returns
   * the conflicts that LWW resolved.
   */
  private async ingest(deltas: readonly Delta[], source: "server" | "simulation"): Promise<ConflictRecord[]> {
    const fresh: Delta[] = [];
    const conflicts: ConflictRecord[] = [];
    let duplicates = 0;
    for (const delta of deltas) {
      if (source === "server") this.serverContext = addDot(this.serverContext, delta.dot);
      const result = this.doc.apply(delta);
      if (result.status === "duplicate") {
        duplicates += 1;
        continue;
      }
      this.log.add(delta);
      fresh.push(delta);
      conflicts.push(...result.conflicts);
    }
    this.metrics = {
      ...this.metrics,
      deltasReceived: this.metrics.deltasReceived + fresh.length,
      duplicatesDropped: this.metrics.duplicatesDropped + duplicates,
    };
    if (conflicts.length > 0) this.recordConflicts(conflicts);
    for (const delta of fresh) this.pushEvent("info", `Applied remote ${delta.dot.node}#${delta.dot.seq}: ${delta.op.label}`);
    const persisted = this.options.store.write({
      snapshot: this.doc.snapshot(),
      deltas: fresh,
      serverContext: this.serverContext,
      conflicts: conflicts.length > 0 ? this.conflicts : undefined,
    });
    this.emit();
    await persisted;
    return conflicts;
  }

  private push(deltas: readonly Delta[]): void {
    if (deltas.length === 0) return;
    if (!this.options.transport.send({ type: "deltas", deltas })) return;
    const at = this.now();
    for (const delta of deltas) this.sentAt.set(`${delta.dot.node}:${delta.dot.seq}`, at);
    this.metrics = { ...this.metrics, deltasSent: this.metrics.deltasSent + deltas.length };
    this.emit();
  }

  private startPing(): void {
    this.cancelPing?.();
    const ping = (): void => {
      this.options.transport.send({ type: "ping", t: this.now() });
    };
    ping();
    this.cancelPing = this.scheduler.every(ping, this.options.pingIntervalMs ?? 2000);
  }

  // ───────────────────────────── State helpers ─────────────────────────────

  private outbox(): Delta[] {
    return this.log.missingFrom(this.serverContext);
  }

  private recordRtt(rtt: number): void {
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > RTT_WINDOW) this.rttSamples.shift();
    const avg = this.rttSamples.reduce((sum, s) => sum + s, 0) / this.rttSamples.length;
    this.metrics = { ...this.metrics, lastRttMs: rtt, avgRttMs: Math.round(avg * 10) / 10 };
    this.emit();
  }

  private recordConflicts(incoming: readonly ConflictRecord[]): void {
    const known = new Set(this.conflicts.map((c) => c.id));
    const fresh = incoming.filter((c) => !known.has(c.id));
    this.conflicts = [...fresh.reverse(), ...this.conflicts].slice(0, MAX_CONFLICTS);
    for (const conflict of fresh) {
      this.pushEvent("warn", `Conflict on ${conflict.entity} "${conflict.entityLabel}".${conflict.field}: ${conflict.winner} write won`);
    }
  }

  private setStatus(status: NetworkStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private pushEvent(level: SyncEvent["level"], message: string): void {
    this.eventSeq += 1;
    this.events = [{ id: this.eventSeq, at: this.now(), level, message }, ...this.events].slice(0, MAX_EVENTS);
    this.emit();
  }

  private emit(): void {
    this.stateCache = null;
    for (const listener of this.listeners) listener();
  }
}
