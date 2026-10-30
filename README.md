# CRDT Shared Workspace

An **offline-first collaborative Kanban board** built on a CRDT sync engine written from scratch. It doesn't use Yjs or Automerge. Every tab is an independent replica. It persists to IndexedDB, syncs through a WebSocket relay, and converges deterministically after any network partition.

```
Next.js UI ──▶ useSyncEngine (thin React binding)
                    │
                    ▼
              SyncEngine (state machine, outbox, handshake, metrics)
               │            │                    │
               ▼            ▼                    ▼
        WorkspaceDoc   PersistencePort       Transport
         (pure CRDT)   (IndexedDB / memory)  (WebSocket / in-memory)
                                                 │
                                                 ▼
                                      Relay server (Node + ws)
                                      Room = replica + delta log
```

## Quick start

```bash
npm install
npm run dev          # Next.js on :3000 + relay on :4000
npm test             # 92 unit, property-based and scenario tests
npm run build        # Next production build + compiled relay (dist/)
```

Open <http://localhost:3000> in **two tabs**. Each tab is its own replica, with a unique node id and its own IndexedDB database. Use `?room=<name>` to open separate boards.

### Demo script

1. Add a card in tab A. It appears in tab B, and the ack latency shows up in the metrics panel.
2. Toggle **both tabs offline**. Edit the *same* card's title in each tab, and change a *different* field (description or color) too.
3. Watch the **Outbox** fill up. Reload a tab while it's offline: the edits come back from IndexedDB before any network I/O.
4. Toggle both tabs back online. The background handshake runs, the tabs converge, and the **Conflict log** shows the local and remote values, the winner, and which HLC component decided the race. The edits to different fields both survive.
5. Press **⚡** on any card to inject a concurrent edit from a phantom peer with a skewed clock. It's a real, replicated conflict.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/core/crdt/` | Pure CRDT: HLC, causal contexts, LWW register, LWW-Element-Set, fractional index, merge, conflict detection, `WorkspaceDoc` |
| `src/core/storage/` | `PersistencePort` + IndexedDB implementation (native API, small promise wrapper) + memory store |
| `src/core/network/` | Wire protocol with runtime guards, `Transport` abstraction + WebSocket implementation, `SyncEngine` |
| `src/client/` | Browser composition root (node-id claiming via Web Locks, IndexedDB, WebSocket URL) |
| `src/hooks/` | `useSyncEngine`: lifecycle + `useSyncExternalStore`, no logic |
| `src/components/`, `src/app/` | Next.js App Router UI (Tailwind v4) |
| `server/` | Relay: `room.ts` (transport-agnostic) + `index.ts` (`ws` + HTTP) |
| `tests/` | Vitest suites: `crdt/`, `scenarios/`, `storage/`, `network/` + an adversarial simulated network |

## The CRDT

### Payload

```ts
DocState = {
  columnSet: LWWElementSet          // membership: adds/removes → Tag
  columns:   ColumnId → { title: LWW<string>, order: LWW<string> }
  cardSet:   LWWElementSet
  cards:     CardId → { title, description, color: LWW<…>, position: LWW<{columnId, order}> }
}
Tag   = { ts: HLC, dot: (node, seq) }
Delta = { dot, ts, context /* author's causal context before the write */, patch: DocState, op }
```

* **Per-field registers:** concurrent edits to *different* fields of a card both survive. Only same-field writes compete.
* **Atomic moves:** `position` holds the column and the fractional sort key together, so a move can never be half-applied.
* **Fractional indexing:** an order key is a base-62 fraction, so a move rewrites only the moved card's key. Concurrent moves never conflict with each other.

### Timestamps: Hybrid Logical Clock

`ts = (wall, counter, node)`, ordered lexicographically. The HLC never goes backwards. `receive()` lifts the local clock above any timestamp it observes, so causally later writes always carry larger timestamps, even from a replica whose physical clock lags. The `node` tiebreak makes the order **strict and total**: no two writes are ever equal.

### Merge is a join-semilattice

* **LWW register:** `a ⊔ b = max_ts(a, b)`. The max over a total order is associative, commutative and idempotent.
* **LWW-Element-Set:** `(A₁ ⊔ A₂, R₁ ⊔ R₂)` with a per-key max. `e ∈ S ⇔ A[e] > R[e]`.
* **Maps:** pointwise join, with a missing key as ⊥.
* **DocState:** a product of semilattices, which is itself a semilattice.

So `mergeStates` (and `WorkspaceDoc.merge()`) is **associative, commutative and idempotent**. Applying a delta is the same join (`state ⊔ patch`), so delivery order, batching and duplication can't affect the result. That's strong eventual consistency. `tests/crdt/mergeLaws.test.ts` checks all three laws, plus convergence under arbitrary permutation and duplication of deltas, with fast-check over states produced by real replicas running random schedules.

### Causal contexts (vector clocks with gaps)

A context is a **set of dots**, stored as a contiguous vector clock plus a "cloud" of out-of-order dots:
`{ clock: {a: 3}, cloud: {a: [5]} }` means "saw a1–a3 and a5, but not a4". Merging contexts is set union. Contexts drive:

* **Sync diffs:** the server sends `{ δ ∈ log | dot(δ) ∉ C_client }`, and the client pushes `{ δ ∈ log | dot(δ) ∉ C_server }`.
* **Outbox:** the logged deltas whose dots aren't in the last known server context.
* **Conflict detection:** writes `w₁` and `w₂` are concurrent iff `dot(w₁) ∉ C_in ∧ dot(w₂) ∉ C_local`. A causal overwrite is never reported as a conflict.

### Conflict semantics

| Situation | Resolution |
| --- | --- |
| Same field, concurrent | Greater HLC wins. The log says whether wall time, the counter or the node id decided it |
| Different fields, concurrent | Both kept (independent registers) |
| Delete vs edit | The card stays deleted (membership uses only add/remove tags). The edit is kept under the tombstone |
| Move into a concurrently deleted column | The card shows up in a virtual **Recovered** lane instead of disappearing |
| Concurrent moves to the same slot | Equal order keys are broken by card id, so every replica renders the same order |

## Sync protocol

```
OFFLINE ─toggle─▶ CONNECTING ─open─▶ HANDSHAKING ─sync─▶ SYNCED
   ▲                 ▲  │ close → exponential backoff (500 ms … 10 s)
   └── toggle off ───┴──┘
```

1. `hello { context }` → the server replies `sync { deltas the client lacks, serverContext }`.
2. The client joins those deltas, *replaces* its view of the server context (so a relay restart triggers a full re-push), and pushes `log \ serverContext`.
3. Live traffic: `deltas` is fanned out to the other peers, and `ack { dots }` clears the outbox. `ping`/`pong` measures RTT.

Each local mutation is joined into memory, then **committed atomically to IndexedDB (snapshot + delta in one transaction)**, then sent. On load, the engine hydrates entirely from IndexedDB before it opens a socket.

## Testing

| Suite | What it proves |
| --- | --- |
| `crdt/mergeLaws` | ACI laws plus strong eventual consistency under random schedules, shuffling and duplicates (fast-check) |
| `scenarios/offlineConcurrentEdit` | Users A and B edit the same field offline, then reconnect simultaneously. Covers the winner, the logged conflict, preservation of non-conflicting fields, exact-tie node tiebreaks, clock skew and delete-vs-edit |
| `scenarios/outOfOrderDelivery` | All 120 permutations of a dependent delta chain, gap folding, duplicates, and seeded chaos networks with shuffling and duplication. Dropped fan-out is recovered by anti-entropy |
| `scenarios/partitionHeal` | Split brain, store-and-forward between peers never online together, relay restart, rapid offline/online flapping |
| `storage/workspaceStore` | IndexedDB round-trip (fake-indexeddb), hydration before network, outbox persistence across reloads, write-through |
| `network/*` | Protocol guards, relay room semantics, state machine, backoff, RTT, the conflict simulator, stale-socket isolation |

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `SYNC_PORT` | `4000` | relay server |
| `NEXT_PUBLIC_SYNC_URL` | `ws://<page host>:4000` | browser client |

## Limitations and next steps

* The relay keeps its rooms in memory. Clients re-push their history after a restart, but a durable server store would make that unnecessary.
* Delta logs grow without bound. Causal-stability-based garbage collection of tombstones and acked deltas is the natural next step.
* Card text is an LWW register, so concurrent typing in the *same* field resolves per write rather than per character. A sequence CRDT (RGA) for descriptions would fix that.
* There's no authentication or authorization on rooms.

## License

MIT
