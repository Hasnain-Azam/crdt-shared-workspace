/**
 * Materialisation: projects a DocState onto a render-ready BoardView.
 *
 * The projection is a pure function of the state, so converged states
 * always render identically. Cards whose column was deleted concurrently
 * (for example, moved into a column another replica was deleting) go into
 * a virtual "Recovered" lane instead of vanishing silently.
 */
import { compareTimestamps } from "./hlc";
import { compareOrder } from "./fractionalIndex";
import { setHas, setValues } from "./lwwElementSet";
import type { BoardView, CardRecord, CardView, ColumnView, DocState, LWWRegister, NodeId } from "./types";

export const RECOVERED_COLUMN_ID = "__recovered__";
const DEFAULT_COLOR = "slate" as const;

function lastEditor(record: CardRecord): NodeId {
  let latest: LWWRegister<unknown> | undefined;
  for (const reg of Object.values(record) as (LWWRegister<unknown> | undefined)[]) {
    if (reg !== undefined && (latest === undefined || compareTimestamps(reg.ts, latest.ts) > 0)) latest = reg;
  }
  return latest?.ts.node ?? "unknown";
}

function toCardView(id: string, record: CardRecord): CardView | null {
  // A card can be in the add-set before all of its fields arrive (out-of-order delivery). Render it only once it's complete.
  if (record.title === undefined || record.position === undefined) return null;
  return {
    id,
    title: record.title.value,
    description: record.description?.value ?? "",
    color: record.color?.value ?? DEFAULT_COLOR,
    columnId: record.position.value.columnId,
    order: record.position.value.order,
    lastEditedBy: lastEditor(record),
  };
}

const byOrder = <T extends { readonly id: string; readonly order: string }>(a: T, b: T): number =>
  compareOrder(a.order, a.id, b.order, b.id);

/** Projects the document state to the board the UI renders. */
export function materializeBoard(state: DocState): BoardView {
  const cardsByColumn = new Map<string, CardView[]>();
  for (const id of setValues(state.cardSet)) {
    const record = state.cards[id];
    const card = record === undefined ? null : toCardView(id, record);
    if (card === null) continue;
    const columnKey = setHas(state.columnSet, card.columnId) ? card.columnId : RECOVERED_COLUMN_ID;
    cardsByColumn.set(columnKey, [...(cardsByColumn.get(columnKey) ?? []), card]);
  }

  const columns: ColumnView[] = [];
  for (const id of setValues(state.columnSet)) {
    const record = state.columns[id];
    if (record?.title === undefined || record.order === undefined) continue;
    columns.push({
      id,
      title: record.title.value,
      order: record.order.value,
      virtual: false,
      cards: (cardsByColumn.get(id) ?? []).sort(byOrder),
    });
  }
  columns.sort(byOrder);

  const recovered = cardsByColumn.get(RECOVERED_COLUMN_ID);
  if (recovered !== undefined && recovered.length > 0) {
    columns.push({
      id: RECOVERED_COLUMN_ID,
      title: "Recovered (column deleted concurrently)",
      order: "~",
      virtual: true,
      cards: recovered.sort(byOrder),
    });
  }
  return { columns };
}
