"use client";

import { useState, type ReactElement } from "react";
import type { ColumnView } from "../core/crdt/types";
import type { WorkspaceActions } from "../hooks/useSyncEngine";
import { CARD_DRAG_TYPE, CardItem } from "./CardItem";

export interface ColumnProps {
  readonly column: ColumnView;
  readonly columnIds: readonly string[];
  readonly actions: WorkspaceActions;
}

export function Column({ column, columnIds, actions }: ColumnProps): ReactElement {
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(column.title);
  const [dragOver, setDragOver] = useState(false);

  const dropAt = (cardId: string, index: number): void => {
    if (column.virtual) return;
    // moveCard's index ignores the moved card itself, so shift down if it currently sits above the drop target.
    const current = column.cards.findIndex((c) => c.id === cardId);
    actions.moveCard(cardId, column.id, current >= 0 && current < index ? index - 1 : index);
  };

  return (
    <section
      className={`flex w-72 shrink-0 flex-col rounded-xl border bg-zinc-100/80 ${
        column.virtual ? "border-dashed border-amber-400 bg-amber-50" : "border-zinc-200"
      } ${dragOver ? "ring-2 ring-indigo-300" : ""}`}
      onDragOver={(e) => {
        if (!column.virtual && e.dataTransfer.types.includes(CARD_DRAG_TYPE)) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const id = e.dataTransfer.getData(CARD_DRAG_TYPE);
        if (id) dropAt(id, column.cards.length);
      }}
    >
      <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        {renaming ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim() && title.trim() !== column.title) actions.renameColumn(column.id, title.trim());
              setRenaming(false);
            }}
          >
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => setRenaming(false)}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-0.5 text-sm font-semibold outline-none focus:border-indigo-500"
              aria-label="Column title"
            />
          </form>
        ) : (
          <h2
            className={`truncate text-sm font-semibold ${column.virtual ? "text-amber-800" : "cursor-text text-zinc-800"}`}
            onDoubleClick={() => {
              if (column.virtual) return;
              setTitle(column.title);
              setRenaming(true);
            }}
            title={column.virtual ? "Cards whose column was deleted concurrently with a move or create" : "Double-click to rename"}
          >
            {column.title}
          </h2>
        )}
        <div className="flex items-center gap-1">
          <span className="rounded-full bg-zinc-200 px-2 text-xs font-medium text-zinc-600">{column.cards.length}</span>
          {!column.virtual && (
            <button
              type="button"
              aria-label={`Delete column ${column.title}`}
              title="Delete column (and its cards)"
              onClick={() => actions.deleteColumn(column.id)}
              className="grid h-6 w-6 place-items-center rounded text-xs text-zinc-400 hover:bg-zinc-200 hover:text-rose-600"
            >
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-2">
        {column.cards.map((card, index) => (
          <CardItem key={card.id} card={card} index={index} columnIds={columnIds} actions={actions} onDropBefore={dropAt} />
        ))}
        {column.cards.length === 0 && <p className="py-4 text-center text-xs text-zinc-400">Drop cards here</p>}
      </div>

      {!column.virtual && (
        <form
          className="p-3 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            actions.createCard({ columnId: column.id, title: draft.trim() });
            setDraft("");
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="+ Add a card"
            className="w-full rounded-lg border border-transparent bg-white/60 px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-indigo-400 focus:bg-white"
            aria-label={`Add card to ${column.title}`}
          />
        </form>
      )}
    </section>
  );
}
