/**
 * Property-based verification of the algebraic laws that make the document
 * a CRDT. Random states are produced by *real* replicas running random
 * operation schedules with random partial syncs, so the tests exercise
 * reachable states and not arbitrary JSON.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  CARD_COLORS,
  mergeContexts,
  mergeStates,
  WorkspaceDoc,
  type Delta,
  type DocState,
} from "../../src/core/crdt";

type Op =
  | { readonly kind: "createCard"; readonly replica: number; readonly column: number; readonly title: string }
  | { readonly kind: "updateTitle"; readonly replica: number; readonly card: number; readonly title: string }
  | { readonly kind: "updateColor"; readonly replica: number; readonly card: number; readonly color: number }
  | { readonly kind: "move"; readonly replica: number; readonly card: number; readonly column: number; readonly index: number }
  | { readonly kind: "deleteCard"; readonly replica: number; readonly card: number }
  | { readonly kind: "createColumn"; readonly replica: number; readonly title: string }
  | { readonly kind: "deleteColumn"; readonly replica: number; readonly column: number }
  | { readonly kind: "sync"; readonly from: number; readonly to: number }
  | { readonly kind: "tick"; readonly replica: number; readonly ms: number };

const replicaArb = fc.integer({ min: 0, max: 2 });
const smallText = fc.string({ minLength: 1, maxLength: 6 });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("createCard" as const), replica: replicaArb, column: fc.nat(), title: smallText }),
  fc.record({ kind: fc.constant("updateTitle" as const), replica: replicaArb, card: fc.nat(), title: smallText }),
  fc.record({ kind: fc.constant("updateColor" as const), replica: replicaArb, card: fc.nat(), color: fc.nat() }),
  fc.record({ kind: fc.constant("move" as const), replica: replicaArb, card: fc.nat(), column: fc.nat(), index: fc.nat({ max: 5 }) }),
  fc.record({ kind: fc.constant("deleteCard" as const), replica: replicaArb, card: fc.nat() }),
  fc.record({ kind: fc.constant("createColumn" as const), replica: replicaArb, title: smallText }),
  fc.record({ kind: fc.constant("deleteColumn" as const), replica: replicaArb, column: fc.nat() }),
  fc.record({ kind: fc.constant("sync" as const), from: replicaArb, to: replicaArb }),
  fc.record({ kind: fc.constant("tick" as const), replica: replicaArb, ms: fc.integer({ min: -5, max: 20 }) }),
);

interface World {
  readonly docs: WorkspaceDoc[];
  readonly deltas: Delta[];
}

/** Runs an operation schedule over three replicas with independent, possibly skewed clocks. */
function runSchedule(ops: readonly Op[]): World {
  const clocks = [1000, 1003, 997];
  const docs = ["alice", "bob", "carol"].map((id, i) => new WorkspaceDoc({ nodeId: id, now: () => clocks[i] as number }));
  const deltas: Delta[] = [];
  const pick = <T>(items: readonly T[], n: number): T | undefined => (items.length === 0 ? undefined : items[n % items.length]);

  for (const op of ops) {
    if (op.kind === "sync") {
      const from = docs[op.from] as WorkspaceDoc;
      (docs[op.to] as WorkspaceDoc).merge({ state: from.state, context: from.context, clock: from.clock });
      continue;
    }
    if (op.kind === "tick") {
      clocks[op.replica] = (clocks[op.replica] as number) + op.ms;
      continue;
    }
    const doc = docs[op.replica] as WorkspaceDoc;
    const columns = doc.view().columns.filter((c) => !c.virtual);
    const cards = doc.view().columns.flatMap((c) => c.cards);
    let delta: Delta | undefined;
    switch (op.kind) {
      case "createCard": {
        const column = pick(columns, op.column);
        if (column) delta = doc.createCard({ columnId: column.id, title: op.title });
        break;
      }
      case "updateTitle": {
        const card = pick(cards, op.card);
        if (card) delta = doc.updateCard(card.id, { title: op.title });
        break;
      }
      case "updateColor": {
        const card = pick(cards, op.card);
        if (card) delta = doc.updateCard(card.id, { color: CARD_COLORS[op.color % CARD_COLORS.length] });
        break;
      }
      case "move": {
        const card = pick(cards, op.card);
        const column = pick(columns, op.column);
        if (card && column) delta = doc.moveCard(card.id, column.id, op.index);
        break;
      }
      case "deleteCard": {
        const card = pick(cards, op.card);
        if (card) delta = doc.deleteCard(card.id);
        break;
      }
      case "createColumn":
        delta = doc.createColumn(op.title);
        break;
      case "deleteColumn": {
        const column = pick(columns, op.column);
        if (column) delta = doc.deleteColumn(column.id);
        break;
      }
    }
    if (delta) deltas.push(delta);
  }
  return { docs, deltas };
}

const scheduleArb = fc.array(opArb, { minLength: 1, maxLength: 40 });
const stateEq = (a: DocState, b: DocState): void => expect(canonicalize(a)).toBe(canonicalize(b));

describe("CRDT merge laws (property-based, 3 replicas, random schedules)", () => {
  it("merge is commutative: a ⊔ b = b ⊔ a", () => {
    fc.assert(
      fc.property(scheduleArb, (ops) => {
        const [a, b] = runSchedule(ops).docs.map((d) => d.state) as [DocState, DocState];
        stateEq(mergeStates(a, b), mergeStates(b, a));
      }),
      { numRuns: 150 },
    );
  });

  it("merge is associative: (a ⊔ b) ⊔ c = a ⊔ (b ⊔ c)", () => {
    fc.assert(
      fc.property(scheduleArb, (ops) => {
        const [a, b, c] = runSchedule(ops).docs.map((d) => d.state) as [DocState, DocState, DocState];
        stateEq(mergeStates(mergeStates(a, b), c), mergeStates(a, mergeStates(b, c)));
      }),
      { numRuns: 150 },
    );
  });

  it("merge is idempotent: a ⊔ a = a, and (a ⊔ b) ⊔ b = a ⊔ b", () => {
    fc.assert(
      fc.property(scheduleArb, (ops) => {
        const [a, b] = runSchedule(ops).docs.map((d) => d.state) as [DocState, DocState];
        stateEq(mergeStates(a, a), a);
        stateEq(mergeStates(mergeStates(a, b), b), mergeStates(a, b));
      }),
      { numRuns: 150 },
    );
  });

  it("strong eventual consistency: applying all deltas in ANY order, with duplicates, yields the same state", () => {
    fc.assert(
      fc.property(scheduleArb, fc.integer(), (ops, seed) => {
        const { deltas } = runSchedule(ops);
        const inOrder = new WorkspaceDoc({ nodeId: "observer-1" });
        for (const d of deltas) inOrder.apply(d);

        // Deterministic shuffle + duplication from the seed.
        const shuffled = [...deltas, ...deltas.filter((_, i) => (i + seed) % 3 === 0)];
        let s = seed >>> 0;
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          const j = s % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j] as Delta, shuffled[i] as Delta];
        }
        const outOfOrder = new WorkspaceDoc({ nodeId: "observer-2" });
        for (const d of shuffled) outOfOrder.apply(d);

        stateEq(inOrder.state, outOfOrder.state);
        expect(outOfOrder.context).toEqual(inOrder.context);
        expect(outOfOrder.view()).toEqual(inOrder.view());
      }),
      { numRuns: 150 },
    );
  });

  it("full-state anti-entropy between all replicas converges to the delta-replayed state", () => {
    fc.assert(
      fc.property(scheduleArb, (ops) => {
        const { docs, deltas } = runSchedule(ops);
        // Gossip in a ring twice. Afterwards everyone has merged everyone.
        for (let round = 0; round < 2; round += 1) {
          for (let i = 0; i < docs.length; i += 1) {
            const from = docs[i] as WorkspaceDoc;
            (docs[(i + 1) % docs.length] as WorkspaceDoc).merge({ state: from.state, context: from.context });
          }
        }
        const replayed = new WorkspaceDoc({ nodeId: "observer" });
        for (const d of deltas) replayed.apply(d);
        for (const doc of docs) {
          stateEq(doc.state, replayed.state);
          expect(doc.view()).toEqual(replayed.view());
        }
        expect(docs.map((d) => d.context).reduce(mergeContexts)).toEqual(replayed.context);
      }),
      { numRuns: 150 },
    );
  });
});
