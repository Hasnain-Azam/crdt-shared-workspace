/**
 * Causal contexts (vector clocks plus a "dot cloud").
 *
 * Mathematically a causal context is just a *set of dots*, and the join of
 * two contexts is set union. Union is associative, commutative and
 * idempotent, so contexts form a join-semilattice. The representation below
 * is a compression of that set:
 *
 *   C = { (n, s) | s ≤ clock[n] } ∪ { (n, s) | s ∈ cloud[n] }
 *
 * `normalizeContext` keeps the representation canonical. It moves cloud
 * entries into the contiguous prefix whenever the gap before them is filled,
 * so equal sets always have equal representations. That makes
 * representations safe to compare and to persist.
 */
import type { CausalContext, Dot, NodeId } from "./types";

export type ClockOrdering = "equal" | "before" | "after" | "concurrent";

export const EMPTY_CONTEXT: CausalContext = Object.freeze({ clock: {}, cloud: {} });

/** Serialises a dot as `node:seq` (used as a map/IndexedDB key). */
export function dotKey(dot: Dot): string {
  return `${dot.node}:${dot.seq}`;
}

/** True when `dot` is in the set of dots represented by `ctx`. Genesis dots (seq ≤ 0) are always known. */
export function contextContains(ctx: CausalContext, dot: Dot): boolean {
  if (dot.seq <= 0) return true;
  if ((ctx.clock[dot.node] ?? 0) >= dot.seq) return true;
  return ctx.cloud[dot.node]?.includes(dot.seq) ?? false;
}

/**
 * Returns the canonical form of a context. For each node it folds cloud dots
 * into the contiguous prefix while `clock + 1` is present, and drops cloud
 * entries already covered by the prefix.
 */
export function normalizeContext(ctx: CausalContext): CausalContext {
  const clock: Record<NodeId, number> = { ...ctx.clock };
  const cloud: Record<NodeId, number[]> = {};
  for (const [node, seqs] of Object.entries(ctx.cloud)) {
    let prefix = clock[node] ?? 0;
    const pending = new Set(seqs.filter((s) => s > prefix));
    while (pending.has(prefix + 1)) {
      prefix += 1;
      pending.delete(prefix);
    }
    if (prefix > 0) clock[node] = prefix;
    if (pending.size > 0) cloud[node] = [...pending].sort((a, b) => a - b);
  }
  return { clock, cloud };
}

/** Adds a single dot: C ∪ {dot}. */
export function addDot(ctx: CausalContext, dot: Dot): CausalContext {
  if (contextContains(ctx, dot)) return ctx;
  const existing = ctx.cloud[dot.node] ?? [];
  return normalizeContext({ clock: ctx.clock, cloud: { ...ctx.cloud, [dot.node]: [...existing, dot.seq] } });
}

/** Join of two contexts: set union of their dots. Associative, commutative, idempotent. */
export function mergeContexts(a: CausalContext, b: CausalContext): CausalContext {
  const clock: Record<NodeId, number> = { ...a.clock };
  for (const [node, seq] of Object.entries(b.clock)) {
    clock[node] = Math.max(clock[node] ?? 0, seq);
  }
  const cloud: Record<NodeId, number[]> = {};
  for (const source of [a.cloud, b.cloud]) {
    for (const [node, seqs] of Object.entries(source)) {
      cloud[node] = [...(cloud[node] ?? []), ...seqs];
    }
  }
  return normalizeContext({ clock, cloud });
}

/** True when every dot in `a` is also in `b` (a ⊆ b). */
export function contextLeq(a: CausalContext, b: CausalContext): boolean {
  for (const [node, seq] of Object.entries(a.clock)) {
    // b is normalised, so if b.clock[node] < seq then dot (node, b.clock[node]+1) is missing from b.
    if ((b.clock[node] ?? 0) < seq) return false;
  }
  for (const [node, seqs] of Object.entries(a.cloud)) {
    for (const seq of seqs) {
      if (!contextContains(b, { node, seq })) return false;
    }
  }
  return true;
}

/**
 * Classic vector-clock comparison, generalised to dot sets:
 *   a ≤ b ∧ b ≤ a  → equal
 *   a ≤ b          → before (b has seen everything a has)
 *   b ≤ a          → after
 *   otherwise      → concurrent (each has seen something the other hasn't)
 */
export function compareContexts(a: CausalContext, b: CausalContext): ClockOrdering {
  const aLeqB = contextLeq(a, b);
  const bLeqA = contextLeq(b, a);
  if (aLeqB && bLeqA) return "equal";
  if (aLeqB) return "before";
  if (bLeqA) return "after";
  return "concurrent";
}

/** Total number of dots represented by a context. */
export function contextSize(ctx: CausalContext): number {
  let size = 0;
  for (const seq of Object.values(ctx.clock)) size += seq;
  for (const seqs of Object.values(ctx.cloud)) size += seqs.length;
  return size;
}

/** All node ids that appear in either part of a context. */
export function contextNodes(ctx: CausalContext): NodeId[] {
  return [...new Set([...Object.keys(ctx.clock), ...Object.keys(ctx.cloud)])].sort();
}
