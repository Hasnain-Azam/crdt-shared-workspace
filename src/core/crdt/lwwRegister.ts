/**
 * Last-Writer-Wins register.
 *
 * merge(a, b) = the register whose timestamp is greater.
 *
 * HLC timestamps form a strict total order (see hlc.ts), so `merge` is the
 * `max` operator over a totally ordered set, which is a join-semilattice:
 *   associative  max(max(a,b),c) = max(a,max(b,c))
 *   commutative  max(a,b)        = max(b,a)
 *   idempotent   max(a,a)        = a
 *
 * When two inputs carry the same timestamp they are the same write (a
 * timestamp is unique per write), so returning either one is correct.
 */
import { compareTimestamps } from "./hlc";
import type { FieldRecord, LWWRegister, Tag } from "./types";

/** Creates a register holding `value`, written at `tag`. */
export function createRegister<T>(value: T, tag: Tag): LWWRegister<T> {
  return { value, ts: tag.ts, dot: tag.dot };
}

/** Joins two registers: the later write wins. */
export function mergeRegisters<T>(a: LWWRegister<T>, b: LWWRegister<T>): LWWRegister<T> {
  return compareTimestamps(a.ts, b.ts) >= 0 ? a : b;
}

/**
 * Joins two field records key by key. Fields present on only one side are
 * kept as-is (absent = bottom element ⊥ of the register lattice).
 */
export function mergeFieldRecords<F>(a: FieldRecord<F>, b: FieldRecord<F>): FieldRecord<F> {
  const out: { [K in keyof F]?: LWWRegister<F[K]> } = { ...a };
  for (const key of Object.keys(b) as (keyof F)[]) {
    const incoming = b[key];
    if (incoming === undefined) continue;
    const current = out[key];
    out[key] = current === undefined ? incoming : mergeRegisters(current, incoming);
  }
  return out;
}
