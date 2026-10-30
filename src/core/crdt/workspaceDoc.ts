/**
 * WorkspaceDoc: one replica of the Kanban document.
 *
 * A replica is the triple (state, context, clock):
 *   state   - the DocState lattice element (merge.ts)
 *   context - the set of dots whose effects are included in `state`
 *   clock   - the HLC used to timestamp local writes
 *
 * Local mutators follow the delta-state CRDT pattern (Almeida et al., 2018).
 * Each one builds a small `patch`, joins it into the local state, and
 * returns it as a Delta to replicate. Remote deltas and full remote states
 * go through the same join, so local and remote updates can't diverge.
 *
 * This module is pure logic. It knows nothing about storage or networking.
 */
import { detectConflicts } from "./conflict";
import { keyBetween } from "./fractionalIndex";
import { createGenesisState } from "./genesis";
import { HybridLogicalClock, type WallClock } from "./hlc";
import { addElement, removeElement, setHas } from "./lwwElementSet";
import { createRegister } from "./lwwRegister";
import { EMPTY_STATE, mergeStates } from "./merge";
import { addDot, contextContains, EMPTY_CONTEXT, mergeContexts } from "./vectorClock";
import { materializeBoard, RECOVERED_COLUMN_ID } from "./view";
import type {
  BoardView,
  CardColor,
  CardFields,
  CardId,
  CardRecord,
  CausalContext,
  ColumnId,
  ConflictRecord,
  Delta,
  DocState,
  NodeId,
  OperationKind,
  ReplicaSnapshot,
  Tag,
} from "./types";

export interface WorkspaceDocOptions {
  readonly nodeId: NodeId;
  /** Physical clock source. Tests inject skewed clocks here. */
  readonly now?: WallClock;
  /** Restores a previously persisted replica. Its nodeId must match. */
  readonly snapshot?: ReplicaSnapshot;
}

export interface ApplyResult {
  /** `duplicate` means the dot was already known, so the call was a no-op (idempotence). */
  readonly status: "applied" | "duplicate";
  readonly conflicts: readonly ConflictRecord[];
}

export interface MergeResult {
  readonly conflicts: readonly ConflictRecord[];
}

export interface CreateCardInput {
  readonly columnId: ColumnId;
  readonly title: string;
  readonly description?: string;
  readonly color?: CardColor;
}

export type CardUpdate = Partial<Pick<CardFields, "title" | "description" | "color">>;

/** A remote replica's full state, as exchanged by `merge()`. */
export interface RemoteState {
  readonly state: DocState;
  readonly context: CausalContext;
  readonly clock?: ReplicaSnapshot["clock"];
}

export class WorkspaceDoc {
  readonly nodeId: NodeId;
  private readonly hlc: HybridLogicalClock;
  private readonly now: WallClock;
  private stateValue: DocState;
  private contextValue: CausalContext;
  private seq: number;
  private cachedView: BoardView | null = null;

  constructor(options: WorkspaceDocOptions) {
    const { nodeId, snapshot } = options;
    if (snapshot !== undefined && snapshot.nodeId !== nodeId) {
      throw new Error(`Snapshot belongs to node "${snapshot.nodeId}", not "${nodeId}"`);
    }
    this.nodeId = nodeId;
    this.now = options.now ?? Date.now;
    this.hlc = new HybridLogicalClock(nodeId, this.now, snapshot?.clock);
    this.stateValue = snapshot?.state ?? createGenesisState();
    this.contextValue = snapshot?.context ?? EMPTY_CONTEXT;
    this.seq = snapshot?.seq ?? 0;
  }

  get state(): DocState {
    return this.stateValue;
  }

  get context(): CausalContext {
    return this.contextValue;
  }

  get clock(): ReplicaSnapshot["clock"] {
    return this.hlc.current;
  }

  /** The materialised board. Cached until the state changes. */
  view(): BoardView {
    this.cachedView ??= materializeBoard(this.stateValue);
    return this.cachedView;
  }

  snapshot(): ReplicaSnapshot {
    return { nodeId: this.nodeId, state: this.stateValue, context: this.contextValue, clock: this.hlc.current, seq: this.seq };
  }

  /**
   * Creates an independent replica that starts from this replica's current
   * state under a new identity. Used by the conflict simulator to model a
   * peer that diverged from us at this moment.
   */
  fork(nodeId: NodeId, now?: WallClock): WorkspaceDoc {
    return new WorkspaceDoc({
      nodeId,
      now: now ?? this.now,
      snapshot: { nodeId, state: this.stateValue, context: this.contextValue, clock: this.hlc.current, seq: 0 },
    });
  }

  // ───────────────────────────── Local mutations ─────────────────────────────

  createColumn(title: string): Delta {
    const id = createId("col");
    const last = this.view().columns.filter((c) => !c.virtual).at(-1);
    const order = keyBetween(last?.order ?? null, null);
    return this.commit("column.create", id, `create column "${title}"`, (tag) => ({
      ...EMPTY_STATE,
      columnSet: addElement(id, tag),
      columns: { [id]: { title: createRegister(title, tag), order: createRegister(order, tag) } },
    }));
  }

  renameColumn(id: ColumnId, title: string): Delta {
    this.assertColumn(id);
    return this.commit("column.rename", id, `rename column → "${title}"`, (tag) => ({
      ...EMPTY_STATE,
      columns: { [id]: { title: createRegister(title, tag) } },
    }));
  }

  /** Deletes a column and, in the same atomic delta, every card currently in it. */
  deleteColumn(id: ColumnId): Delta {
    this.assertColumn(id);
    const cards = this.view().columns.find((c) => c.id === id)?.cards ?? [];
    const title = this.stateValue.columns[id]?.title?.value ?? id;
    return this.commit("column.delete", id, `delete column "${title}" (${cards.length} cards)`, (tag) => ({
      ...EMPTY_STATE,
      columnSet: removeElement(id, tag),
      cardSet: { adds: {}, removes: Object.fromEntries(cards.map((card) => [card.id, tag])) },
    }));
  }

  createCard(input: CreateCardInput): Delta {
    this.assertColumn(input.columnId);
    const id = createId("card");
    const last = this.view().columns.find((c) => c.id === input.columnId)?.cards.at(-1);
    const position = { columnId: input.columnId, order: keyBetween(last?.order ?? null, null) };
    return this.commit("card.create", id, `create card "${input.title}"`, (tag) => ({
      ...EMPTY_STATE,
      cardSet: addElement(id, tag),
      cards: {
        [id]: {
          title: createRegister(input.title, tag),
          description: createRegister(input.description ?? "", tag),
          color: createRegister(input.color ?? "slate", tag),
          position: createRegister(position, tag),
        },
      },
    }));
  }

  /** Updates one or more card fields. Each field is its own register, so concurrent edits to *different* fields both survive. */
  updateCard(id: CardId, update: CardUpdate): Delta {
    this.assertCard(id);
    const fields = Object.keys(update).join(", ");
    return this.commit("card.update", id, `update ${fields} of "${this.cardTitle(id)}"`, (tag) => {
      const record: { -readonly [K in keyof CardRecord]: CardRecord[K] } = {};
      if (update.title !== undefined) record.title = createRegister(update.title, tag);
      if (update.description !== undefined) record.description = createRegister(update.description, tag);
      if (update.color !== undefined) record.color = createRegister(update.color, tag);
      return { ...EMPTY_STATE, cards: { [id]: record } };
    });
  }

  /**
   * Moves a card to `index` within `columnId`. Only the moved card's
   * position register is written, so a concurrent move of a sibling never
   * conflicts with this one.
   */
  moveCard(id: CardId, columnId: ColumnId, index: number): Delta {
    this.assertCard(id);
    this.assertColumn(columnId);
    const siblings = (this.view().columns.find((c) => c.id === columnId)?.cards ?? []).filter((c) => c.id !== id);
    const clamped = Math.max(0, Math.min(index, siblings.length));
    const before = siblings[clamped - 1]?.order ?? null;
    const after = siblings[clamped]?.order ?? null;
    // Concurrent moves can leave two siblings with equal keys. Nothing fits strictly between them, so place after both.
    const order = before !== null && after !== null && before >= after ? keyBetween(before, null) : keyBetween(before, after);
    const columnTitle = this.stateValue.columns[columnId]?.title?.value ?? columnId;
    return this.commit("card.move", id, `move "${this.cardTitle(id)}" → ${columnTitle}`, (tag) => ({
      ...EMPTY_STATE,
      // Re-adding to the set makes a move "rescue" a card from a concurrently deleted column.
      cardSet: addElement(id, tag),
      cards: { [id]: { position: createRegister({ columnId, order }, tag) } },
    }));
  }

  deleteCard(id: CardId): Delta {
    this.assertCard(id);
    return this.commit("card.delete", id, `delete card "${this.cardTitle(id)}"`, (tag) => ({
      ...EMPTY_STATE,
      cardSet: removeElement(id, tag),
    }));
  }

  // ───────────────────────────── Replication ─────────────────────────────

  /**
   * Applies a remote delta: state ← state ⊔ δ.patch, context ← context ∪ {δ.dot}.
   *
   * Idempotent: a delta whose dot is already in our context is a no-op.
   * Order-independent: the join is commutative and associative, so deltas
   * may arrive in any order. Out-of-order dots sit in the context's cloud
   * until the gap fills.
   */
  apply(delta: Delta): ApplyResult {
    if (contextContains(this.contextValue, delta.dot)) return { status: "duplicate", conflicts: [] };
    const conflicts = detectConflicts({
      local: this.stateValue,
      localContext: this.contextValue,
      incoming: delta.patch,
      incomingContext: addDot(delta.context, delta.dot),
      detectedBy: this.nodeId,
      detectedAt: this.now(),
    });
    this.hlc.receive(delta.ts);
    this.setState(mergeStates(this.stateValue, delta.patch));
    this.contextValue = addDot(this.contextValue, delta.dot);
    return { status: "applied", conflicts };
  }

  /**
   * Full state-based merge with another replica:
   *
   *   state   ← state ⊔ remote.state
   *   context ← context ∪ remote.context
   *
   * Because ⊔ is associative, commutative and idempotent, any pattern of
   * pairwise merges between replicas converges once every replica has
   * (transitively) merged every other. Returns the conflicts it resolved.
   */
  merge(remote: RemoteState): MergeResult {
    const conflicts = detectConflicts({
      local: this.stateValue,
      localContext: this.contextValue,
      incoming: remote.state,
      incomingContext: remote.context,
      detectedBy: this.nodeId,
      detectedAt: this.now(),
    });
    if (remote.clock !== undefined) this.hlc.receive(remote.clock);
    this.setState(mergeStates(this.stateValue, remote.state));
    this.contextValue = mergeContexts(this.contextValue, remote.context);
    return { conflicts };
  }

  // ───────────────────────────── Internals ─────────────────────────────

  /**
   * Creates one mutation: tick the HLC, allocate the next dot, build the
   * patch, join it into local state, and record the dot in the context. The
   * returned delta carries the context from *before* the mutation, which is
   * what lets receivers detect concurrency.
   */
  private commit(kind: OperationKind, entityId: string, label: string, build: (tag: Tag) => DocState): Delta {
    const ts = this.hlc.tick();
    this.seq += 1;
    const dot = { node: this.nodeId, seq: this.seq };
    const patch = build({ ts, dot });
    const delta: Delta = { dot, ts, context: this.contextValue, patch, op: { kind, entityId, label } };
    this.setState(mergeStates(this.stateValue, patch));
    this.contextValue = addDot(this.contextValue, dot);
    return delta;
  }

  private setState(next: DocState): void {
    this.stateValue = next;
    this.cachedView = null;
  }

  private cardTitle(id: CardId): string {
    return this.stateValue.cards[id]?.title?.value ?? id;
  }

  private assertColumn(id: ColumnId): void {
    if (id === RECOVERED_COLUMN_ID || !setHas(this.stateValue.columnSet, id)) {
      throw new Error(`Unknown column "${id}"`);
    }
  }

  private assertCard(id: CardId): void {
    if (this.stateValue.cards[id] === undefined) throw new Error(`Unknown card "${id}"`);
  }
}

function createId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}
