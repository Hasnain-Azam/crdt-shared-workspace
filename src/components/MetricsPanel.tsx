"use client";

import type { ReactElement, ReactNode } from "react";
import type { EngineState, NetworkStatus } from "../core/network/syncEngine";
import type { WorkspaceActions } from "../hooks/useSyncEngine";
import { ConflictLog } from "./ConflictLog";
import { formatClockTime, formatMs } from "./format";
import { VectorClockTable } from "./VectorClockTable";

export interface MetricsPanelProps {
  readonly state: EngineState;
  readonly actions: WorkspaceActions;
}

const STATUS_STYLE: Record<NetworkStatus, { label: string; dot: string; text: string }> = {
  offline: { label: "Offline", dot: "bg-zinc-500", text: "text-zinc-300" },
  connecting: { label: "Connecting", dot: "bg-amber-400 animate-pulse", text: "text-amber-300" },
  handshaking: { label: "Handshaking", dot: "bg-sky-400 animate-pulse", text: "text-sky-300" },
  synced: { label: "Online · Synced", dot: "bg-emerald-400", text: "text-emerald-300" },
};

export function StatusBadge({ status }: { status: NetworkStatus }): ReactElement {
  const style = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${style.text}`}>
      <span className={`h-2 w-2 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section className="border-b border-zinc-800 px-4 py-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): ReactElement {
  return (
    <div className="rounded-md bg-zinc-900 px-2.5 py-2" title={hint}>
      <dt className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-zinc-100">{value}</dd>
    </div>
  );
}

export function MetricsPanel({ state, actions }: MetricsPanelProps): ReactElement {
  const m = state.metrics;
  return (
    <div className="text-zinc-200">
      <Section title="Network" aside={<StatusBadge status={state.status} />}>
        <dl className="grid grid-cols-3 gap-2">
          <Stat label="RTT" value={formatMs(m.lastRttMs)} hint="Latest ping→pong round trip" />
          <Stat label="avg RTT" value={formatMs(m.avgRttMs)} hint="Mean of the last 20 pings" />
          <Stat label="ack" value={formatMs(m.lastAckMs)} hint="Delta push → server ack" />
          <Stat label="handshake" value={formatMs(m.lastHandshakeMs)} hint="hello → sync reply → merge" />
          <Stat label="sent / recv" value={`${m.deltasSent} / ${m.deltasReceived}`} hint="Deltas pushed / applied from remote" />
          <Stat label="dupes" value={String(m.duplicatesDropped)} hint="Redundant deliveries absorbed by idempotent merge" />
        </dl>
        <p className="mt-2 font-mono text-[10px] text-zinc-500">
          last sync {m.lastSyncAt === null ? "never" : formatClockTime(m.lastSyncAt)} · log {state.logSize} deltas · peers{" "}
          {state.peers.length}
        </p>
      </Section>

      <Section
        title="Outbox"
        aside={<span className={`font-mono text-xs ${state.outbox.length > 0 ? "text-amber-400" : "text-zinc-500"}`}>{state.outbox.length} pending</span>}
      >
        {state.outbox.length === 0 ? (
          <p className="text-xs text-zinc-500">Every local delta has been acknowledged by the relay.</p>
        ) : (
          <ul className="max-h-32 space-y-1 overflow-y-auto font-mono text-[11px]">
            {state.outbox.map((op, i) => (
              <li key={`${op.entityId}-${i}`} className="truncate text-amber-200/90">
                <span className="text-zinc-500">{op.kind}</span> {op.label}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Vector clocks">
        <VectorClockTable self={state.nodeId} local={state.context} server={state.serverContext} peers={state.peers} />
      </Section>

      <Section title={`Conflict log (${state.conflicts.length})`}>
        <ConflictLog conflicts={state.conflicts} onClear={actions.clearConflicts} />
      </Section>

      <Section title="Sync events">
        <ol className="max-h-64 space-y-1 overflow-y-auto font-mono text-[10.5px] leading-relaxed">
          {state.events.map((e) => (
            <li key={e.id} className="flex gap-2">
              <time className="shrink-0 text-zinc-600">{formatClockTime(e.at)}</time>
              <span className={e.level === "warn" ? "text-amber-300" : e.level === "success" ? "text-emerald-300" : "text-zinc-400"}>{e.message}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
