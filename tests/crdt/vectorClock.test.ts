import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDot,
  compareContexts,
  contextContains,
  contextSize,
  EMPTY_CONTEXT,
  mergeContexts,
  normalizeContext,
  type CausalContext,
} from "../../src/core/crdt";

const fromDots = (dots: readonly [string, number][]): CausalContext =>
  dots.reduce<CausalContext>((ctx, [node, seq]) => addDot(ctx, { node, seq }), EMPTY_CONTEXT);

describe("causal context (vector clock + dot cloud)", () => {
  it("treats genesis dots (seq ≤ 0) as known by everyone", () => {
    expect(contextContains(EMPTY_CONTEXT, { node: "genesis", seq: 0 })).toBe(true);
  });

  it("stores contiguous dots in the clock", () => {
    const ctx = fromDots([["a", 1], ["a", 2], ["a", 3]]);
    expect(ctx).toEqual({ clock: { a: 3 }, cloud: {} });
  });

  it("parks out-of-order dots in the cloud and folds them once the gap is filled", () => {
    let ctx = fromDots([["a", 1], ["a", 3], ["a", 5]]);
    expect(ctx).toEqual({ clock: { a: 1 }, cloud: { a: [3, 5] } });
    expect(contextContains(ctx, { node: "a", seq: 2 })).toBe(false);
    expect(contextContains(ctx, { node: "a", seq: 3 })).toBe(true);
    ctx = addDot(ctx, { node: "a", seq: 2 });
    expect(ctx).toEqual({ clock: { a: 3 }, cloud: { a: [5] } });
    ctx = addDot(ctx, { node: "a", seq: 4 });
    expect(ctx).toEqual({ clock: { a: 5 }, cloud: {} });
  });

  it("compares contexts as dot sets", () => {
    const a = fromDots([["x", 1], ["x", 2]]);
    const b = fromDots([["x", 1], ["x", 2], ["y", 1]]);
    const c = fromDots([["x", 1], ["z", 1]]);
    expect(compareContexts(a, a)).toBe("equal");
    expect(compareContexts(a, b)).toBe("before");
    expect(compareContexts(b, a)).toBe("after");
    expect(compareContexts(b, c)).toBe("concurrent");
    // Cloud dots count too: {x1,x3} is not ≤ {x1,x2}.
    expect(compareContexts(fromDots([["x", 1], ["x", 3]]), a)).toBe("concurrent");
  });

  it("counts represented dots", () => {
    expect(contextSize(fromDots([["a", 1], ["a", 2], ["b", 4]]))).toBe(3);
  });

  it("normalises redundant cloud entries", () => {
    expect(normalizeContext({ clock: { a: 3 }, cloud: { a: [1, 2, 4, 6] } })).toEqual({ clock: { a: 4 }, cloud: { a: [6] } });
  });

  const dotsArb = fc.array(fc.tuple(fc.constantFrom("a", "b", "c"), fc.integer({ min: 1, max: 8 })), { maxLength: 20 });

  it("merge is set union: associative, commutative, idempotent, and canonical", () => {
    fc.assert(
      fc.property(dotsArb, dotsArb, dotsArb, (x, y, z) => {
        const [a, b, c] = [fromDots(x), fromDots(y), fromDots(z)];
        expect(mergeContexts(mergeContexts(a, b), c)).toEqual(mergeContexts(a, mergeContexts(b, c)));
        expect(mergeContexts(a, b)).toEqual(mergeContexts(b, a));
        expect(mergeContexts(a, a)).toEqual(a);
        // Canonical: the union equals the context built from all dots in one go.
        expect(mergeContexts(a, b)).toEqual(fromDots([...x, ...y]));
      }),
    );
  });

  it("insertion order of dots never changes the representation", () => {
    fc.assert(
      fc.property(dotsArb, (dots) => {
        expect(fromDots(dots)).toEqual(fromDots([...dots].reverse()));
      }),
    );
  });
});
