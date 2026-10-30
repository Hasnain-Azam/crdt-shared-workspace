/**
 * Core CRDT type definitions.
 *
 * Every structure here is a plain, JSON-serialisable object so the exact same
 * value can be persisted to IndexedDB, sent over a WebSocket and merged without
 * any conversion layer. All structures are treated as immutable: mutation
 * helpers always return new objects.
 */

/** Stable identifier of a replica (one per browser tab, plus the relay server). */
export type NodeId = string;
export type CardId = string;
export type ColumnId = string;

/**
 * Hybrid Logical Clock timestamp.
 *
 * Ordered lexicographically on (wall, counter, node). Because `node` is unique
 * per replica and a replica never issues the same (wall, counter) twice, the
 * order is a *strict total order* over all writes ever made in the system.
 */
export interface Timestamp {
  readonly wall: number;
  readonly counter: number;
  readonly node: NodeId;
}

/**
 * A "dot" uniquely names one mutation: the `seq`-th event produced by `node`.
 * Dots with `seq <= 0` are reserved for the genesis state that every replica
 * starts with, and are therefore considered known by everyone.
 */
export interface Dot {
  readonly node: NodeId;
  readonly seq: number;
}

/**
 * Causal context: the set of dots a replica has observed, stored compactly.
 *
 *   clock[n] = k  ⇒ dots (n,1) … (n,k) have all been seen (contiguous prefix)
 *   cloud[n]      ⇒ additional dots of n seen out of order (all > clock[n] + 1)
 *
 * Without the cloud a vector clock could not represent "saw 5 but not 4",
 * which happens with out-of-order delivery. Invariant (enforced by
 * `normalizeContext`): `clock[n] + 1 ∉ cloud[n]`.
 */
export interface CausalContext {
  readonly clock: Readonly<Record<NodeId, number>>;
  readonly cloud: Readonly<Record<NodeId, readonly number[]>>;
}

/** Metadata attached to every write: when (HLC) and which mutation (dot). */
export interface Tag {
  readonly ts: Timestamp;
  readonly dot: Dot;
}

/** Last-Writer-Wins register: a value plus the tag of the write that set it. */
export interface LWWRegister<T> extends Tag {
  readonly value: T;
}

/**
 * LWW-Element-Set state: an add-set and a remove-set, each mapping an element
 * to the tag of its most recent add / remove.
 */
export interface LWWElementSetState {
  readonly adds: Readonly<Record<string, Tag>>;
  readonly removes: Readonly<Record<string, Tag>>;
}

export const CARD_COLORS = ["slate", "sky", "emerald", "amber", "rose", "violet"] as const;
export type CardColor = (typeof CARD_COLORS)[number];

/** A card's column and fractional sort key, written atomically. */
export interface CardPosition {
  readonly columnId: ColumnId;
  readonly order: string;
}

/** Plain field values of a card. Each field is backed by its own LWW register. */
export interface CardFields {
  readonly title: string;
  readonly description: string;
  readonly color: CardColor;
  readonly position: CardPosition;
}

export interface ColumnFields {
  readonly title: string;
  readonly order: string;
}

/**
 * Maps a field-value interface to a record of optional LWW registers.
 * Fields are optional because a delta only carries the fields it touched, and
 * because with out-of-order delivery an edit may arrive before the create.
 */
export type FieldRecord<F> = { readonly [K in keyof F]?: LWWRegister<F[K]> };

export type CardRecord = FieldRecord<CardFields>;
export type ColumnRecord = FieldRecord<ColumnFields>;

/**
 * The full replicated document (and also the shape of a delta's patch).
 *
 * DocState = (ColumnSet × Columns) × (CardSet × Cards)
 *
 * It is a product of join-semilattices, so the pointwise join of its
 * components is itself a join-semilattice (see `merge.ts`).
 */
export interface DocState {
  readonly columnSet: LWWElementSetState;
  readonly columns: Readonly<Record<ColumnId, ColumnRecord>>;
  readonly cardSet: LWWElementSetState;
  readonly cards: Readonly<Record<CardId, CardRecord>>;
}

export type OperationKind =
  | "column.create"
  | "column.rename"
  | "column.delete"
  | "card.create"
  | "card.update"
  | "card.move"
  | "card.delete";

/**
 * A delta mutation, the unit of replication.
 *
 * `patch` is a DocState holding only what the mutation touched. Applying it
 * is `state ⊔ patch`, the same join used for full-state merges.
 * `context` is the author's causal context *before* the mutation, which lets
 * receivers tell overwrites (causally after) from conflicts (concurrent).
 */
export interface Delta {
  readonly dot: Dot;
  readonly ts: Timestamp;
  readonly context: CausalContext;
  readonly patch: DocState;
  readonly op: OperationSummary;
}

/** Human-readable description of a delta, for logs and the metrics panel. */
export interface OperationSummary {
  readonly kind: OperationKind;
  readonly entityId: string;
  readonly label: string;
}

/** Everything needed to restore a replica exactly (persisted to IndexedDB). */
export interface ReplicaSnapshot {
  readonly nodeId: NodeId;
  readonly state: DocState;
  readonly context: CausalContext;
  readonly clock: Timestamp;
  readonly seq: number;
}

/** A conflict detected while merging concurrent writes to the same field. */
export interface ConflictRecord {
  readonly id: string;
  readonly detectedAt: number;
  readonly detectedBy: NodeId;
  readonly kind: "concurrent-write" | "delete-vs-edit";
  readonly entity: "card" | "column";
  readonly entityId: string;
  readonly entityLabel: string;
  readonly field: string;
  readonly local: ConflictSide;
  readonly remote: ConflictSide;
  readonly winner: "local" | "remote";
  readonly explanation: string;
}

export interface ConflictSide {
  readonly value: string;
  readonly ts: Timestamp;
  readonly dot: Dot;
}

/** Materialised, render-ready view of the board. */
export interface CardView {
  readonly id: CardId;
  readonly title: string;
  readonly description: string;
  readonly color: CardColor;
  readonly columnId: ColumnId;
  readonly order: string;
  readonly lastEditedBy: NodeId;
}

export interface ColumnView {
  readonly id: ColumnId;
  readonly title: string;
  readonly order: string;
  /** True for the virtual lane that collects cards whose column was deleted concurrently. */
  readonly virtual: boolean;
  readonly cards: readonly CardView[];
}

export interface BoardView {
  readonly columns: readonly ColumnView[];
}
