"use client";

import { useState, type ReactElement } from "react";
import type { BoardView } from "../core/crdt/types";
import type { WorkspaceActions } from "../hooks/useSyncEngine";
import { Column } from "./Column";

export interface BoardProps {
  readonly board: BoardView;
  readonly actions: WorkspaceActions;
}

export function Board({ board, actions }: BoardProps): ReactElement {
  const [draft, setDraft] = useState("");
  const columnIds = board.columns.filter((c) => !c.virtual).map((c) => c.id);

  return (
    <div className="flex h-full items-start gap-4 overflow-x-auto p-4 sm:p-6">
      {board.columns.map((column) => (
        <Column key={column.id} column={column} columnIds={columnIds} actions={actions} />
      ))}
      <form
        className="w-64 shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          actions.createColumn(draft.trim());
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="+ Add a column"
          className="w-full rounded-xl border border-dashed border-zinc-300 bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-zinc-400 focus:border-indigo-400 focus:bg-white"
          aria-label="Add column"
        />
      </form>
    </div>
  );
}
