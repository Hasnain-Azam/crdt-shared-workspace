import { describe, expect, it } from "vitest";
import { compareTimestamps, explainTimestampWin, HybridLogicalClock, maxTimestamp } from "../../src/core/crdt";
import { testClock } from "../helpers/factories";

describe("HybridLogicalClock", () => {
  it("tracks physical time when it moves forward", () => {
    const wall = testClock(100);
    const hlc = new HybridLogicalClock("a", wall.now);
    expect(hlc.tick()).toEqual({ wall: 100, counter: 0, node: "a" });
    wall.time = 150;
    expect(hlc.tick()).toEqual({ wall: 150, counter: 0, node: "a" });
  });

  it("increments the logical counter when physical time stalls or goes backwards", () => {
    const wall = testClock(100);
    const hlc = new HybridLogicalClock("a", wall.now);
    const t1 = hlc.tick();
    const t2 = hlc.tick();
    wall.time = 50; // NTP adjustment moved the clock backwards
    const t3 = hlc.tick();
    expect([t1.counter, t2.counter, t3.counter]).toEqual([0, 1, 2]);
    expect(t3.wall).toBe(100);
    expect(compareTimestamps(t1, t2)).toBe(-1);
    expect(compareTimestamps(t2, t3)).toBe(-1);
  });

  it("orders local events after any received timestamp (causality), even from a peer whose clock runs fast", () => {
    const wall = testClock(100);
    const hlc = new HybridLogicalClock("a", wall.now);
    hlc.receive({ wall: 10_000, counter: 7, node: "b" });
    const next = hlc.tick();
    expect(compareTimestamps(next, { wall: 10_000, counter: 7, node: "b" })).toBe(1);
    expect(next).toEqual({ wall: 10_000, counter: 9, node: "a" });
  });

  it("applies the receive rules for each source of the max wall", () => {
    const wall = testClock(100);
    const hlc = new HybridLogicalClock("a", wall.now, { wall: 100, counter: 4, node: "a" });
    expect(hlc.receive({ wall: 100, counter: 9, node: "b" }).counter).toBe(10); // all three equal
    expect(hlc.receive({ wall: 50, counter: 99, node: "b" }).counter).toBe(11); // local wins
    wall.time = 500;
    expect(hlc.receive({ wall: 200, counter: 3, node: "b" })).toEqual({ wall: 500, counter: 0, node: "a" }); // physical wins
  });

  it("restores from a persisted timestamp without going backwards", () => {
    const wall = testClock(0);
    const hlc = new HybridLogicalClock("a", wall.now, { wall: 999, counter: 3, node: "a" });
    expect(hlc.tick()).toEqual({ wall: 999, counter: 4, node: "a" });
  });

  it("produces a strict total order: the node id breaks (wall, counter) ties", () => {
    const a = { wall: 5, counter: 1, node: "alice" };
    const b = { wall: 5, counter: 1, node: "bob" };
    expect(compareTimestamps(a, b)).toBe(-1);
    expect(compareTimestamps(b, a)).toBe(1);
    expect(compareTimestamps(a, a)).toBe(0);
    expect(maxTimestamp(a, b)).toBe(b);
  });

  it("explains which component decided a race", () => {
    expect(explainTimestampWin({ wall: 9, counter: 0, node: "a" }, { wall: 5, counter: 0, node: "b" })).toMatch(/wall time \(\+4 ms\)/);
    expect(explainTimestampWin({ wall: 5, counter: 2, node: "a" }, { wall: 5, counter: 1, node: "b" })).toMatch(/logical counter/);
    expect(explainTimestampWin({ wall: 5, counter: 1, node: "b" }, { wall: 5, counter: 1, node: "a" })).toMatch(/node-id tiebreak/);
  });
});
