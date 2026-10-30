/**
 * Genesis state shared by every replica.
 *
 * If each replica seeded its own default columns, the merge would produce
 * duplicates. The seed is therefore a *deterministic* constant, with fixed
 * ids, timestamps at wall = 0 and dots with seq = 0. Seq-0 dots count as
 * known by every causal context (see `contextContains`), so genesis writes
 * never show up as conflicts or as "missing" during sync.
 */
import { addElement } from "./lwwElementSet";
import { createRegister } from "./lwwRegister";
import { EMPTY_STATE, mergeStates } from "./merge";
import type { DocState, Tag } from "./types";

export const GENESIS_NODE = "genesis";

const SEED_COLUMNS: readonly { readonly id: string; readonly title: string; readonly order: string }[] = [
  { id: "col-todo", title: "To Do", order: "F" },
  { id: "col-doing", title: "In Progress", order: "V" },
  { id: "col-done", title: "Done", order: "k" },
];

function genesisTag(counter: number): Tag {
  return { ts: { wall: 0, counter, node: GENESIS_NODE }, dot: { node: GENESIS_NODE, seq: 0 } };
}

/** Builds the initial document state. Pure and identical on every replica. */
export function createGenesisState(): DocState {
  return SEED_COLUMNS.reduce<DocState>((state, column, index) => {
    const tag = genesisTag(index);
    return mergeStates(state, {
      ...EMPTY_STATE,
      columnSet: addElement(column.id, tag),
      columns: { [column.id]: { title: createRegister(column.title, tag), order: createRegister(column.order, tag) } },
    });
  }, EMPTY_STATE);
}
