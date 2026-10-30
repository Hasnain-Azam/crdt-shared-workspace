/**
 * Conflict detection, for observability only.
 *
 * Merging never *needs* conflict detection. The join resolves everything
 * deterministically. Developers still want to see *when* LWW threw a write
 * away and *why*, so this module classifies each merged field as an
 * overwrite or a conflict.
 *
 * Two writes w1 (local) and w2 (incoming) are concurrent iff neither author
 * had seen the other's write when making their own:
 *
 *   concurrent(w1, w2) ⇔ dot(w1) ∉ C_in  ∧  dot(w2) ∉ C_local
 *
 * where C_in is the incoming causal context (a delta's context plus its own
 * dot, or a remote replica's full context). If dot(w1) ∈ C_in, the incoming
 * author knowingly overwrote w1, which is an ordinary causal update.
 */
import { formatTimestamp, compareTimestamps } from "./hlc";
import { contextContains, dotKey } from "./vectorClock";
import type {
  CardFields,
  CausalContext,
  ColumnFields,
  ConflictRecord,
  ConflictSide,
  DocState,
  FieldRecord,
  LWWRegister,
  NodeId,
  Tag,
} from "./types";

export interface ConflictDetectionInput {
  readonly local: DocState;
  readonly localContext: CausalContext;
  readonly incoming: DocState;
  readonly incomingContext: CausalContext;
  readonly detectedBy: NodeId;
  readonly detectedAt: number;
}

function areConcurrent(localTag: Tag, incomingTag: Tag, input: ConflictDetectionInput): boolean {
  if (dotKey(localTag.dot) === dotKey(incomingTag.dot)) return false;
  return !contextContains(input.incomingContext, localTag.dot) && !contextContains(input.localContext, incomingTag.dot);
}

function columnTitle(id: string, input: ConflictDetectionInput): string {
  return input.local.columns[id]?.title?.value ?? input.incoming.columns[id]?.title?.value ?? id;
}

function formatValue(value: unknown, input: ConflictDetectionInput): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value !== null && typeof value === "object" && "columnId" in value && "order" in value) {
    const position = value as CardFields["position"];
    return `column "${columnTitle(position.columnId, input)}" (key ${position.order})`;
  }
  return JSON.stringify(value);
}

function side(value: string, tag: Tag): ConflictSide {
  return { value, ts: tag.ts, dot: tag.dot };
}

function conflictId(entityId: string, field: string, a: Tag, b: Tag): string {
  const [x, y] = [dotKey(a.dot), dotKey(b.dot)].sort();
  return `${entityId}/${field}/${x}|${y}`;
}

function latestTag(record: FieldRecord<CardFields> | FieldRecord<ColumnFields> | undefined): Tag | undefined {
  if (record === undefined) return undefined;
  let latest: Tag | undefined;
  for (const reg of Object.values(record) as (LWWRegister<unknown> | undefined)[]) {
    if (reg !== undefined && (latest === undefined || compareTimestamps(reg.ts, latest.ts) > 0)) latest = reg;
  }
  return latest;
}

function detectFieldConflicts<F>(
  entity: "card" | "column",
  localRecords: Readonly<Record<string, FieldRecord<F>>>,
  incomingRecords: Readonly<Record<string, FieldRecord<F>>>,
  labelOf: (id: string) => string,
  input: ConflictDetectionInput,
): ConflictRecord[] {
  const conflicts: ConflictRecord[] = [];
  for (const [id, incomingRecord] of Object.entries(incomingRecords)) {
    const localRecord = localRecords[id];
    if (localRecord === undefined) continue;
    for (const field of Object.keys(incomingRecord) as (keyof F & string)[]) {
      const incomingReg = incomingRecord[field];
      const localReg = localRecord[field];
      if (incomingReg === undefined || localReg === undefined) continue;
      if (!areConcurrent(localReg, incomingReg, input)) continue;
      const remoteWins = compareTimestamps(incomingReg.ts, localReg.ts) > 0;
      const winnerTs = remoteWins ? incomingReg.ts : localReg.ts;
      const loserTs = remoteWins ? localReg.ts : incomingReg.ts;
      conflicts.push({
        id: conflictId(id, field, localReg, incomingReg),
        detectedAt: input.detectedAt,
        detectedBy: input.detectedBy,
        kind: "concurrent-write",
        entity,
        entityId: id,
        entityLabel: labelOf(id),
        field,
        local: side(formatValue(localReg.value, input), localReg),
        remote: side(formatValue(incomingReg.value, input), incomingReg),
        winner: remoteWins ? "remote" : "local",
        explanation: explainTimestampWin(winnerTs, loserTs),
      });
    }
  }
  return conflicts;
}

/** Explains which component of the (wall, counter, node) order decided an LWW race. */
export function explainTimestampWin(winner: { wall: number; counter: number; node: string }, loser: typeof winner): string {
  const prefix = `Concurrent writes (neither causal context contains the other's dot). LWW keeps the greater HLC: ${formatTimestamp(winner)} > ${formatTimestamp(loser)}`;
  if (winner.wall !== loser.wall) return `${prefix}, decided by wall time (+${winner.wall - loser.wall} ms).`;
  if (winner.counter !== loser.counter) return `${prefix}, same wall time so decided by the logical counter.`;
  return `${prefix}, identical wall time and counter, so decided by the node-id tiebreak ("${winner.node}" > "${loser.node}").`;
}

/**
 * Delete-vs-edit: one side tombstoned an entity while the other concurrently
 * edited one of its fields. Membership in an LWW-Element-Set depends only on
 * add/remove tags, so the edit is kept in state but the entity stays deleted
 * unless a later add exists.
 */
function detectDeleteVsEdit(
  entity: "card" | "column",
  set: "cardSet" | "columnSet",
  records: "cards" | "columns",
  labelOf: (id: string) => string,
  input: ConflictDetectionInput,
): ConflictRecord[] {
  const conflicts: ConflictRecord[] = [];
  const check = (
    id: string,
    removeTag: Tag,
    editRecord: FieldRecord<CardFields> | FieldRecord<ColumnFields> | undefined,
    deleteIsRemote: boolean,
  ): void => {
    const edit = latestTag(editRecord);
    if (edit === undefined) return;
    const [localTag, incomingTag] = deleteIsRemote ? [edit, removeTag] : [removeTag, edit];
    if (!areConcurrent(localTag, incomingTag, input)) return;
    const localAdd = input.local[set].adds[id];
    const incomingAdd = input.incoming[set].adds[id];
    const addTs = [localAdd, incomingAdd]
      .filter((t): t is Tag => t !== undefined)
      .reduce<Tag | undefined>((acc, t) => (acc === undefined || compareTimestamps(t.ts, acc.ts) > 0 ? t : acc), undefined);
    const staysDeleted = addTs === undefined || compareTimestamps(removeTag.ts, addTs.ts) > 0;
    const deleteSide = side("(deleted)", removeTag);
    const editSide = side("(edited)", edit);
    conflicts.push({
      id: conflictId(id, "membership", localTag, incomingTag),
      detectedAt: input.detectedAt,
      detectedBy: input.detectedBy,
      kind: "delete-vs-edit",
      entity,
      entityId: id,
      entityLabel: labelOf(id),
      field: "membership",
      local: deleteIsRemote ? editSide : deleteSide,
      remote: deleteIsRemote ? deleteSide : editSide,
      winner: staysDeleted === deleteIsRemote ? "remote" : "local",
      explanation: staysDeleted
        ? `Concurrent delete and edit. LWW-Element-Set membership looks only at add/remove tags: remove ${formatTimestamp(removeTag.ts)} is newer than the latest add, so the ${entity} stays deleted. The edit is kept under the tombstone.`
        : `Concurrent delete and edit, but a later add (${formatTimestamp(addTs.ts)}) outranks the remove, so the ${entity} stays visible.`,
    });
  };

  for (const [id, removeTag] of Object.entries(input.incoming[set].removes)) {
    check(id, removeTag, input.local[records][id], true);
  }
  for (const [id, removeTag] of Object.entries(input.local[set].removes)) {
    check(id, removeTag, input.incoming[records][id], false);
  }
  return conflicts;
}

/** Detects every conflict that merging `incoming` into `local` would resolve. */
export function detectConflicts(input: ConflictDetectionInput): ConflictRecord[] {
  const cardLabel = (id: string): string =>
    input.local.cards[id]?.title?.value ?? input.incoming.cards[id]?.title?.value ?? id;
  const columnLabel = (id: string): string => columnTitle(id, input);
  return [
    ...detectFieldConflicts<CardFields>("card", input.local.cards, input.incoming.cards, cardLabel, input),
    ...detectFieldConflicts<ColumnFields>("column", input.local.columns, input.incoming.columns, columnLabel, input),
    ...detectDeleteVsEdit("card", "cardSet", "cards", cardLabel, input),
    ...detectDeleteVsEdit("column", "columnSet", "columns", columnLabel, input),
  ];
}
