"use client";

import type { ReactElement } from "react";
import type { ConflictRecord, ConflictSide } from "../core/crdt/types";
import { formatClockTime, formatHlc } from "./format";

export interface ConflictLogProps {
  readonly conflicts: readonly ConflictRecord[];
  readonly onClear: () => void;
}

function Side({ label, side, won }: { label: string; side: ConflictSide; won: boolean }): ReactElement {
  return (
    <div className={`min-w-0 rounded-md border p-2 ${won ? "border-emerald-500/60 bg-emerald-500/10" : "border-zinc-700 bg-zinc-900 opacity-70"}`}>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide">
        <span className="text-zinc-400">{label}</span>
        {won ? <span className="font-semibold text-emerald-400">winner</span> : <span className="text-zinc-500 line-through">discarded</span>}
      </div>
      <p className="truncate font-mono text-xs text-zinc-100" title={side.value}>
        {side.value}
      </p>
      <p className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={`dot ${side.dot.node}#${side.dot.seq}`}>
        {formatHlc(side.ts)}
      </p>
    </div>
  );
}

export function ConflictLog({ conflicts, onClear }: ConflictLogProps): ReactElement {
  if (conflicts.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-zinc-500">
        No conflicts yet. Press <span className="text-zinc-300">⚡</span> on a card to inject a concurrent edit from a phantom peer. Or open
        a second tab, take both offline, edit the same card in each, then bring them back online.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" onClick={onClear} className="text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300">
          clear
        </button>
      </div>
      {conflicts.map((c) => (
        <article key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5">
          <header className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span
                className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                  c.kind === "concurrent-write" ? "bg-rose-500/20 text-rose-300" : "bg-amber-500/20 text-amber-300"
                }`}
              >
                {c.kind}
              </span>
              <span className="text-xs text-zinc-300">
                {c.entity} <span className="text-zinc-100">“{c.entityLabel}”</span> · <span className="font-mono">{c.field}</span>
              </span>
            </div>
            <time className="shrink-0 font-mono text-[10px] text-zinc-500">{formatClockTime(c.detectedAt)}</time>
          </header>
          <div className="grid grid-cols-2 gap-2">
            <Side label="local" side={c.local} won={c.winner === "local"} />
            <Side label="remote" side={c.remote} won={c.winner === "remote"} />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">{c.explanation}</p>
        </article>
      ))}
    </div>
  );
}
