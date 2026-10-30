/**
 * Wire protocol between clients and the relay server, with runtime guards.
 *
 *   client → server   hello  { clientId, room, context }   start of the anti-entropy handshake
 *                     deltas { deltas }                     push local or unacked deltas
 *                     ping   { t }                          latency probe
 *
 *   server → client   sync   { deltas, context }            deltas the client lacks + the server's context
 *                     deltas { deltas, from }               live fan-out of another peer's deltas
 *                     ack    { dots }                       dots now durably held by the server
 *                     pong   { t }                          echo of ping.t
 *                     peers  { peers }                      node ids currently connected to the room
 *                     error  { message }
 *
 * Messages are JSON. Network input is untrusted, so every message is
 * structurally validated before use, and invalid ones are dropped.
 */
import { CARD_COLORS } from "../crdt/types";
import type {
  CardColor,
  CausalContext,
  Delta,
  DocState,
  Dot,
  LWWElementSetState,
  LWWRegister,
  NodeId,
  OperationKind,
  Tag,
  Timestamp,
} from "../crdt/types";

export type ClientMessage =
  | { readonly type: "hello"; readonly clientId: NodeId; readonly room: string; readonly context: CausalContext }
  | { readonly type: "deltas"; readonly deltas: readonly Delta[] }
  | { readonly type: "ping"; readonly t: number };

export type ServerMessage =
  | { readonly type: "sync"; readonly deltas: readonly Delta[]; readonly context: CausalContext }
  | { readonly type: "deltas"; readonly deltas: readonly Delta[]; readonly from: NodeId }
  | { readonly type: "ack"; readonly dots: readonly Dot[] }
  | { readonly type: "pong"; readonly t: number }
  | { readonly type: "peers"; readonly peers: readonly NodeId[] }
  | { readonly type: "error"; readonly message: string };

// ───────────────────────────── Primitive guards ─────────────────────────────

type Guard<T> = (value: unknown) => value is T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNonNegInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function isArrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every(guard);
}

function isRecordOf<T>(guard: Guard<T>): Guard<Record<string, T>> {
  return (value: unknown): value is Record<string, T> => isRecord(value) && Object.values(value).every(guard);
}

// ───────────────────────────── CRDT guards ─────────────────────────────

export const isTimestamp: Guard<Timestamp> = (v): v is Timestamp =>
  isRecord(v) && isFiniteNumber(v.wall) && isNonNegInt(v.counter) && isString(v.node);

export const isDot: Guard<Dot> = (v): v is Dot => isRecord(v) && isString(v.node) && Number.isInteger(v.seq);

const isTag: Guard<Tag> = (v): v is Tag => isRecord(v) && isTimestamp(v.ts) && isDot(v.dot);

export const isCausalContext: Guard<CausalContext> = (v): v is CausalContext =>
  isRecord(v) && isRecordOf(isNonNegInt)(v.clock) && isRecordOf(isArrayOf(isNonNegInt))(v.cloud);

function isRegisterOf<T>(guard: Guard<T>): Guard<LWWRegister<T>> {
  return (v: unknown): v is LWWRegister<T> => isTag(v) && guard((v as unknown as Record<string, unknown>).value);
}

const isOptional =
  <T>(guard: Guard<T>): Guard<T | undefined> =>
  (v): v is T | undefined =>
    v === undefined || guard(v);

const isColor: Guard<CardColor> = (v): v is CardColor => isString(v) && (CARD_COLORS as readonly string[]).includes(v);
const isPosition = (v: unknown): v is { columnId: string; order: string } =>
  isRecord(v) && isString(v.columnId) && isString(v.order);

const isCardRecord = (v: unknown): boolean =>
  isRecord(v) &&
  isOptional(isRegisterOf(isString))(v.title) &&
  isOptional(isRegisterOf(isString))(v.description) &&
  isOptional(isRegisterOf(isColor))(v.color) &&
  isOptional(isRegisterOf(isPosition))(v.position);

const isColumnRecord = (v: unknown): boolean =>
  isRecord(v) && isOptional(isRegisterOf(isString))(v.title) && isOptional(isRegisterOf(isString))(v.order);

const isSetState: Guard<LWWElementSetState> = (v): v is LWWElementSetState =>
  isRecord(v) && isRecordOf(isTag)(v.adds) && isRecordOf(isTag)(v.removes);

export const isDocState: Guard<DocState> = (v): v is DocState =>
  isRecord(v) &&
  isSetState(v.columnSet) &&
  isSetState(v.cardSet) &&
  isRecord(v.columns) &&
  Object.values(v.columns).every(isColumnRecord) &&
  isRecord(v.cards) &&
  Object.values(v.cards).every(isCardRecord);

const OPERATION_KINDS: readonly OperationKind[] = [
  "column.create",
  "column.rename",
  "column.delete",
  "card.create",
  "card.update",
  "card.move",
  "card.delete",
];

export const isDelta: Guard<Delta> = (v): v is Delta =>
  isRecord(v) &&
  isDot(v.dot) &&
  isTimestamp(v.ts) &&
  isCausalContext(v.context) &&
  isDocState(v.patch) &&
  isRecord(v.op) &&
  isString(v.op.kind) &&
  (OPERATION_KINDS as readonly string[]).includes(v.op.kind) &&
  isString(v.op.entityId) &&
  isString(v.op.label);

const isDeltaList = isArrayOf(isDelta);

// ───────────────────────────── Message parsing ─────────────────────────────

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses and validates a client→server message. Returns null if it's invalid. */
export function parseClientMessage(raw: string): ClientMessage | null {
  const m = parseJson(raw);
  if (!isRecord(m)) return null;
  switch (m.type) {
    case "hello":
      return isString(m.clientId) && isString(m.room) && isCausalContext(m.context)
        ? { type: "hello", clientId: m.clientId, room: m.room, context: m.context }
        : null;
    case "deltas":
      return isDeltaList(m.deltas) ? { type: "deltas", deltas: m.deltas } : null;
    case "ping":
      return isFiniteNumber(m.t) ? { type: "ping", t: m.t } : null;
    default:
      return null;
  }
}

/** Parses and validates a server→client message. Returns null if it's invalid. */
export function parseServerMessage(raw: string): ServerMessage | null {
  const m = parseJson(raw);
  if (!isRecord(m)) return null;
  switch (m.type) {
    case "sync":
      return isDeltaList(m.deltas) && isCausalContext(m.context) ? { type: "sync", deltas: m.deltas, context: m.context } : null;
    case "deltas":
      return isDeltaList(m.deltas) && isString(m.from) ? { type: "deltas", deltas: m.deltas, from: m.from } : null;
    case "ack":
      return isArrayOf(isDot)(m.dots) ? { type: "ack", dots: m.dots } : null;
    case "pong":
      return isFiniteNumber(m.t) ? { type: "pong", t: m.t } : null;
    case "peers":
      return isArrayOf(isString)(m.peers) ? { type: "peers", peers: m.peers } : null;
    case "error":
      return isString(m.message) ? { type: "error", message: m.message } : null;
    default:
      return null;
  }
}

/** Serialises any protocol message. */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
