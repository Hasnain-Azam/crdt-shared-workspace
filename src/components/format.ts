import type { CardColor, Timestamp } from "../core/crdt/types";

/** Formats epoch ms as HH:MM:SS.mmm. */
export function formatClockTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Formats an HLC timestamp compactly: wall time, counter and node. */
export function formatHlc(ts: Timestamp): string {
  return `${formatClockTime(ts.wall)} · c${ts.counter} · ${ts.node}`;
}

export function formatMs(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

/** Static class maps (Tailwind needs literal class names at build time). */
export const COLOR_ACCENT: Record<CardColor, string> = {
  slate: "border-l-slate-400",
  sky: "border-l-sky-500",
  emerald: "border-l-emerald-500",
  amber: "border-l-amber-500",
  rose: "border-l-rose-500",
  violet: "border-l-violet-500",
};

export const COLOR_SWATCH: Record<CardColor, string> = {
  slate: "bg-slate-400",
  sky: "bg-sky-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  violet: "bg-violet-500",
};
