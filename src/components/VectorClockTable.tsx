"use client";

import type { ReactElement } from "react";
import { compareContexts, contextNodes, type CausalContext, type NodeId } from "../core/crdt";

export interface VectorClockTableProps {
  readonly self: NodeId;
  readonly local: CausalContext;
  readonly server: CausalContext;
  readonly peers: readonly NodeId[];
}

const ORDERING_LABEL: Record<ReturnType<typeof compareContexts>, { text: string; tone: string }> = {
  equal: { text: "local = server · fully synced", tone: "text-emerald-400" },
  before: { text: "local ⊂ server · behind", tone: "text-sky-400" },
  after: { text: "local ⊃ server · unpushed writes", tone: "text-amber-400" },
  concurrent: { text: "local ∥ server · concurrent (diverged)", tone: "text-rose-400" },
};

/**
 * Shows the replica's causal context next to its view of the server's.
 * Each row is one node: the contiguous prefix it has seen, plus any
 * out-of-order "cloud" dots still waiting for a gap to fill.
 */
export function VectorClockTable({ self, local, server, peers }: VectorClockTableProps): ReactElement {
  const nodes = [...new Set([...contextNodes(local), ...contextNodes(server), self])].sort((a, b) =>
    a === self ? -1 : b === self ? 1 : a.localeCompare(b),
  );
  const ordering = ORDERING_LABEL[compareContexts(local, server)];

  return (
    <div>
      <p className={`mb-2 font-mono text-[11px] ${ordering.tone}`}>{ordering.text}</p>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[11px]">
          <thead>
            <tr className="text-left text-zinc-500">
              <th className="py-1 pr-2 font-normal">node</th>
              <th className="py-1 pr-2 text-right font-normal">local</th>
              <th className="py-1 pr-2 text-right font-normal">server</th>
              <th className="py-1 text-right font-normal">Δ</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => {
              const l = local.clock[node] ?? 0;
              const s = server.clock[node] ?? 0;
              const cloud = local.cloud[node] ?? [];
              const delta = l + cloud.length - s;
              return (
                <tr key={node} className="border-t border-zinc-800">
                  <td className="max-w-32 truncate py-1 pr-2 text-zinc-300" title={node}>
                    <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${peers.includes(node) ? "bg-emerald-400" : "bg-zinc-600"}`} />
                    {node}
                    {node === self && <span className="ml-1 text-indigo-400">(you)</span>}
                  </td>
                  <td className="py-1 pr-2 text-right text-zinc-100">
                    {l}
                    {cloud.length > 0 && <span className="text-amber-400" title="Out-of-order dots awaiting a gap"> +[{cloud.join(",")}]</span>}
                  </td>
                  <td className="py-1 pr-2 text-right text-zinc-400">{s}</td>
                  <td className={`py-1 text-right ${delta > 0 ? "text-amber-400" : delta < 0 ? "text-sky-400" : "text-zinc-600"}`}>
                    {delta > 0 ? `+${delta}` : delta === 0 ? "·" : delta}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 break-all font-mono text-[10px] text-zinc-500">VC = {JSON.stringify(local.clock)}</p>
    </div>
  );
}
