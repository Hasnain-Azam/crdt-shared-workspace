import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addElement,
  createRegister,
  EMPTY_SET,
  mergeFieldRecords,
  mergeRegisters,
  mergeSets,
  removeElement,
  setHas,
  setValues,
  type LWWElementSetState,
  type Tag,
} from "../../src/core/crdt";

const tag = (wall: number, node = "n", counter = 0, seq = wall): Tag => ({ ts: { wall, counter, node }, dot: { node, seq } });

describe("LWW-Register", () => {
  it("keeps the write with the greater timestamp regardless of argument order", () => {
    const older = createRegister("old", tag(1, "a"));
    const newer = createRegister("new", tag(2, "b"));
    expect(mergeRegisters(older, newer).value).toBe("new");
    expect(mergeRegisters(newer, older).value).toBe("new");
  });

  it("breaks wall-clock ties with the node id", () => {
    const a = createRegister("from-a", tag(5, "a"));
    const b = createRegister("from-b", tag(5, "b"));
    expect(mergeRegisters(a, b).value).toBe("from-b");
    expect(mergeRegisters(b, a).value).toBe("from-b");
  });

  it("merges field records per key so different fields never clobber each other", () => {
    const left = { title: createRegister("T1", tag(1, "a")), description: createRegister("D-new", tag(9, "a")) };
    const right = { title: createRegister("T2", tag(5, "b")), color: createRegister("rose", tag(2, "b")) };
    const merged = mergeFieldRecords<{ title: string; description: string; color: string }>(left, right);
    expect(merged.title?.value).toBe("T2");
    expect(merged.description?.value).toBe("D-new");
    expect(merged.color?.value).toBe("rose");
  });
});

describe("LWW-Element-Set", () => {
  it("adds, removes and re-adds elements", () => {
    let set: LWWElementSetState = EMPTY_SET;
    set = mergeSets(set, addElement("x", tag(1)));
    expect(setHas(set, "x")).toBe(true);
    set = mergeSets(set, removeElement("x", tag(2)));
    expect(setHas(set, "x")).toBe(false);
    set = mergeSets(set, addElement("x", tag(3)));
    expect(setHas(set, "x")).toBe(true);
    expect(setValues(set)).toEqual(["x"]);
  });

  it("resolves a concurrent add/remove by timestamp, not by arrival order", () => {
    const add = addElement("x", tag(10, "a"));
    const remove = removeElement("x", tag(11, "b"));
    expect(setHas(mergeSets(add, remove), "x")).toBe(false);
    expect(setHas(mergeSets(remove, add), "x")).toBe(false);
  });

  it("ignores a remove of an element that was never added", () => {
    expect(setHas(removeElement("ghost", tag(1)), "ghost")).toBe(false);
  });

  const opArb = fc.tuple(fc.boolean(), fc.constantFrom("x", "y", "z"), fc.integer({ min: 1, max: 50 }), fc.constantFrom("a", "b"));
  const setArb = fc
    .array(opArb, { maxLength: 12 })
    .map((ops) =>
      ops.reduce<LWWElementSetState>(
        (s, [isAdd, el, wall, node]) => mergeSets(s, isAdd ? addElement(el, tag(wall, node)) : removeElement(el, tag(wall, node))),
        EMPTY_SET,
      ),
    );

  it("merge is associative, commutative and idempotent (property-based)", () => {
    fc.assert(
      fc.property(setArb, setArb, setArb, (a, b, c) => {
        expect(mergeSets(mergeSets(a, b), c)).toEqual(mergeSets(a, mergeSets(b, c)));
        expect(mergeSets(a, b)).toEqual(mergeSets(b, a));
        expect(mergeSets(a, a)).toEqual(a);
      }),
    );
  });
});
