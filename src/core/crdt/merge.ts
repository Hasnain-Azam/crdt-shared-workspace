/**
 * State merge: the join (⊔) of the document semilattice.
 *
 *   DocState = ColumnSet × Columns × CardSet × Cards
 *   Columns  = ColumnId → (title: LWW, order: LWW)
 *   Cards    = CardId   → (title: LWW, description: LWW, color: LWW, position: LWW)
 *
 * Every component is a join-semilattice:
 *   - LWW registers under timestamp max (lwwRegister.ts)
 *   - LWW-Element-Sets under per-key max of tags (lwwElementSet.ts)
 *   - maps under pointwise join, with a missing key as ⊥
 *
 * A product of semilattices with the pointwise join is a semilattice, so
 * `mergeStates` is
 *
 *   associative  (a ⊔ b) ⊔ c = a ⊔ (b ⊔ c)
 *   commutative   a ⊔ b      = b ⊔ a
 *   idempotent    a ⊔ a      = a
 *
 * Together these guarantee Strong Eventual Consistency: replicas that have
 * received the same set of updates are in the same state, whatever the
 * order, grouping or duplication of deliveries. tests/crdt/mergeLaws.test.ts
 * checks all three laws with property-based testing.
 */
import { EMPTY_SET, mergeSets } from "./lwwElementSet";
import { mergeFieldRecords } from "./lwwRegister";
import type { DocState, FieldRecord } from "./types";

export const EMPTY_STATE: DocState = Object.freeze({
  columnSet: EMPTY_SET,
  columns: {},
  cardSet: EMPTY_SET,
  cards: {},
});

function mergeRecordMaps<F>(
  a: Readonly<Record<string, FieldRecord<F>>>,
  b: Readonly<Record<string, FieldRecord<F>>>,
): Record<string, FieldRecord<F>> {
  const out: Record<string, FieldRecord<F>> = { ...a };
  for (const [id, incoming] of Object.entries(b)) {
    const current = out[id];
    out[id] = current === undefined ? incoming : mergeFieldRecords(current, incoming);
  }
  return out;
}

/** The join of two document states (also used to apply a delta: state ⊔ patch). */
export function mergeStates(a: DocState, b: DocState): DocState {
  return {
    columnSet: mergeSets(a.columnSet, b.columnSet),
    columns: mergeRecordMaps(a.columns, b.columns),
    cardSet: mergeSets(a.cardSet, b.cardSet),
    cards: mergeRecordMaps(a.cards, b.cards),
  };
}

/**
 * Canonical JSON encoding with sorted object keys. Two states are equal as
 * lattice elements exactly when their canonical encodings match, which is
 * how the tests check convergence.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
