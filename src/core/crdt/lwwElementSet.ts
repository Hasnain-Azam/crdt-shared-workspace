/**
 * LWW-Element-Set (Shapiro et al., "A comprehensive study of CRDTs", 2011).
 *
 * State: two maps, A (adds) and R (removes), from element to the tag of its
 * latest add or remove.
 *
 *   merge(S1, S2) = (A1 ⊔ A2, R1 ⊔ R2), where ⊔ takes the per-key max timestamp
 *   lookup(e)     = e ∈ A ∧ (e ∉ R ∨ A[e].ts > R[e].ts)
 *
 * Each map is a product, over the element universe, of max-semilattices on
 * timestamps. A product of semilattices is a semilattice, so merge is
 * associative, commutative and idempotent.
 *
 * Bias: classic LWW sets need an add- or remove-bias for ties between A[e]
 * and R[e]. HLC timestamps are strictly totally ordered, so a tie would mean
 * the same write was both an add and a remove, which is impossible. We still
 * define ties as "present" (add-bias) so `lookup` is total.
 */
import { compareTimestamps } from "./hlc";
import type { LWWElementSetState, Tag } from "./types";

export const EMPTY_SET: LWWElementSetState = Object.freeze({ adds: {}, removes: {} });

function mergeTagMaps(
  a: Readonly<Record<string, Tag>>,
  b: Readonly<Record<string, Tag>>,
): Record<string, Tag> {
  const out: Record<string, Tag> = { ...a };
  for (const [element, tag] of Object.entries(b)) {
    const current = out[element];
    if (current === undefined || compareTimestamps(tag.ts, current.ts) > 0) out[element] = tag;
  }
  return out;
}

/** Joins two LWW-Element-Sets. */
export function mergeSets(a: LWWElementSetState, b: LWWElementSetState): LWWElementSetState {
  return { adds: mergeTagMaps(a.adds, b.adds), removes: mergeTagMaps(a.removes, b.removes) };
}

/** A patch that records an add of `element` at `tag`. */
export function addElement(element: string, tag: Tag): LWWElementSetState {
  return { adds: { [element]: tag }, removes: {} };
}

/** A patch that records a remove of `element` at `tag` (a tombstone). */
export function removeElement(element: string, tag: Tag): LWWElementSetState {
  return { adds: {}, removes: { [element]: tag } };
}

/** Membership: the latest add is newer than the latest remove. */
export function setHas(set: LWWElementSetState, element: string): boolean {
  const added = set.adds[element];
  if (added === undefined) return false;
  const removed = set.removes[element];
  return removed === undefined || compareTimestamps(added.ts, removed.ts) >= 0;
}

/** All elements currently in the set. */
export function setValues(set: LWWElementSetState): string[] {
  return Object.keys(set.adds).filter((element) => setHas(set, element));
}
