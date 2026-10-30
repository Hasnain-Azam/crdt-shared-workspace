import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareOrder, keyBetween } from "../../src/core/crdt";

describe("fractional index", () => {
  it("generates keys strictly between the bounds", () => {
    const first = keyBetween(null, null);
    const after = keyBetween(first, null);
    const before = keyBetween(null, first);
    const middle = keyBetween(first, after);
    expect(before < first && first < middle && middle < after).toBe(true);
  });

  it("supports repeated insertion at the front, the back and the same gap", () => {
    let low = keyBetween(null, null);
    let high = keyBetween(low, null);
    for (let i = 0; i < 200; i += 1) {
      const mid = keyBetween(low, high);
      expect(low < mid && mid < high).toBe(true);
      if (i % 2 === 0) low = mid;
      else high = mid;
    }
    let tail = keyBetween(null, null);
    let head = tail;
    for (let i = 0; i < 200; i += 1) {
      const nextTail = keyBetween(tail, null);
      const nextHead = keyBetween(null, head);
      expect(nextTail > tail && nextHead < head).toBe(true);
      tail = nextTail;
      head = nextHead;
    }
  });

  it("never produces a key ending in the zero digit", () => {
    let low: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      low = keyBetween(null, low);
      expect(low.endsWith("0")).toBe(false);
    }
  });

  it("rejects inverted bounds", () => {
    expect(() => keyBetween("b", "a")).toThrow();
    expect(() => keyBetween("a", "a")).toThrow();
  });

  it("random insertions always keep a strictly sorted list (property-based)", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 120 }), (positions) => {
        const keys: string[] = [];
        for (const p of positions) {
          const index = p % (keys.length + 1);
          keys.splice(index, 0, keyBetween(keys[index - 1] ?? null, keys[index] ?? null));
        }
        for (let i = 1; i < keys.length; i += 1) expect((keys[i - 1] as string) < (keys[i] as string)).toBe(true);
      }),
    );
  });

  it("breaks equal-key ties deterministically by id", () => {
    expect(compareOrder("V", "card-a", "V", "card-b")).toBe(-1);
    expect(compareOrder("V", "card-b", "V", "card-a")).toBe(1);
  });
});
