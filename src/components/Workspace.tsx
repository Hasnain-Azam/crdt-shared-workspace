"use client";

import type { ReactElement } from "react";
import { useSyncEngine } from "../hooks/useSyncEngine";
import { Board } from "./Board";
import { MetricsPanel, StatusBadge } from "./MetricsPanel";

export interface WorkspaceProps {
  readonly room: string;
}

export function Workspace({ room }: WorkspaceProps): ReactElement {
  const { state, actions, error, dismissError } = useSyncEngine(room);

  if (state === null || actions === null) {
    return (
      <div className="grid h-dvh place-items-center bg-zinc-50 text-sm text-zinc-500">
        {error ? <p className="text-rose-600">Failed to start: {error}</p> : <p>Hydrating replica from IndexedDB…</p>}
      </div>
    );
  }

  const online = !state.simulatedOffline;

  return (
    <div className="flex h-dvh flex-col bg-zinc-50 lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-zinc-900">CRDT Shared Workspace</h1>
            <p className="truncate font-mono text-xs text-zinc-500">
              room <span className="text-zinc-800">{state.room}</span> · replica <span className="text-indigo-600">{state.nodeId}</span> ·
              hydrated from {state.hydratedFrom}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-zinc-900 px-3 py-1">
              <StatusBadge status={state.status} />
            </span>
            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-zinc-700">
              <span>{online ? "Online" : "Offline"}</span>
              <button
                type="button"
                role="switch"
                aria-checked={online}
                aria-label="Toggle simulated network partition"
                onClick={() => actions.setOnline(!online)}
                className={`relative h-6 w-11 rounded-full transition ${online ? "bg-emerald-500" : "bg-zinc-400"}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${online ? "left-[22px]" : "left-0.5"}`} />
              </button>
            </label>
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Delete this replica's IndexedDB data and reload?")) void actions.resetLocalData();
              }}
              className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
              title="Wipe local IndexedDB for this replica"
            >
              Reset local
            </button>
          </div>
        </header>

        {!online && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 sm:px-6">
            Simulated partition active. Edits are saved to IndexedDB and queued in the outbox ({state.outbox.length} pending). Go back
            online to run the background sync handshake.
          </div>
        )}
        {error && (
          <div className="flex items-center justify-between border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700 sm:px-6">
            <span>{error}</span>
            <button type="button" onClick={dismissError} className="font-medium hover:underline">
              dismiss
            </button>
          </div>
        )}

        <main className="min-h-[60vh] flex-1 overflow-hidden lg:min-h-0">
          <Board board={state.board} actions={actions} />
        </main>
      </div>

      <aside className="w-full shrink-0 overflow-y-auto border-t border-zinc-800 bg-zinc-950 lg:w-[420px] lg:border-l lg:border-t-0">
        <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
          <h2 className="text-sm font-semibold text-zinc-100">Systems Metrics</h2>
          <p className="text-[11px] text-zinc-500">State-based LWW CRDT · HLC timestamps · dot-set causal contexts</p>
        </div>
        <MetricsPanel state={state} actions={actions} />
      </aside>
    </div>
  );
}
