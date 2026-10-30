"use client";

import { useState, type DragEvent, type ReactElement } from "react";
import { CARD_COLORS, type CardView } from "../core/crdt/types";
import type { WorkspaceActions } from "../hooks/useSyncEngine";
import { COLOR_ACCENT, COLOR_SWATCH } from "./format";

export interface CardItemProps {
  readonly card: CardView;
  readonly index: number;
  readonly columnIds: readonly string[];
  readonly actions: WorkspaceActions;
  readonly onDropBefore: (cardId: string, index: number) => void;
}

export const CARD_DRAG_TYPE = "application/x-crdt-card";

export function CardItem({ card, index, columnIds, actions, onDropBefore }: CardItemProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [dragOver, setDragOver] = useState(false);
  const [simulating, setSimulating] = useState(false);

  const columnIndex = columnIds.indexOf(card.columnId);
  const prevColumn = columnIndex > 0 ? columnIds[columnIndex - 1] : undefined;
  const nextColumn = columnIndex >= 0 && columnIndex < columnIds.length - 1 ? columnIds[columnIndex + 1] : undefined;

  const startEditing = (): void => {
    setTitle(card.title);
    setDescription(card.description);
    setEditing(true);
  };

  const save = (): void => {
    const update: { title?: string; description?: string } = {};
    if (title.trim() && title.trim() !== card.title) update.title = title.trim();
    if (description !== card.description) update.description = description;
    if (Object.keys(update).length > 0) actions.updateCard(card.id, update);
    setEditing(false);
  };

  const onDragStart = (e: DragEvent<HTMLElement>): void => {
    e.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    const id = e.dataTransfer.getData(CARD_DRAG_TYPE);
    setDragOver(false);
    if (!id || id === card.id) return;
    e.preventDefault();
    e.stopPropagation();
    onDropBefore(id, index);
  };

  const simulate = async (): Promise<void> => {
    setSimulating(true);
    await actions.simulateConflict(card.id);
    setSimulating(false);
  };

  return (
    <article
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(CARD_DRAG_TYPE)) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`group rounded-lg border border-l-4 border-zinc-200 bg-white p-3 shadow-sm transition ${COLOR_ACCENT[card.color]} ${
        dragOver ? "translate-y-1 ring-2 ring-indigo-400" : "hover:shadow-md"
      } ${editing ? "" : "cursor-grab active:cursor-grabbing"}`}
    >
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded border border-zinc-300 px-2 py-1 text-sm font-medium outline-none focus:border-indigo-500"
            aria-label="Card title"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Description"
            className="w-full resize-none rounded border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-indigo-500"
            aria-label="Card description"
          />
          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {CARD_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  title={color}
                  aria-label={`Color ${color}`}
                  onClick={() => actions.updateCard(card.id, { color })}
                  className={`h-4 w-4 rounded-full ${COLOR_SWATCH[color]} ${card.color === color ? "ring-2 ring-zinc-900 ring-offset-1" : ""}`}
                />
              ))}
            </div>
            <div className="flex gap-1">
              <button type="button" onClick={() => setEditing(false)} className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100">
                Cancel
              </button>
              <button type="submit" className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500">
                Save
              </button>
            </div>
          </div>
        </form>
      ) : (
        <>
          <button type="button" onClick={startEditing} className="block w-full text-left">
            <h3 className="text-sm font-medium leading-snug text-zinc-900 break-words">{card.title}</h3>
            {card.description && <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-500 break-words">{card.description}</p>}
          </button>
          <footer className="mt-2 flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[10px] text-zinc-400" title="Last writer (HLC max over this card's registers)">
              ✎ {card.lastEditedBy}
            </span>
            <div className="flex shrink-0 gap-0.5 opacity-60 transition group-hover:opacity-100">
              <IconButton label="Move left" disabled={!prevColumn} onClick={() => prevColumn && actions.moveCard(card.id, prevColumn, Number.MAX_SAFE_INTEGER)}>
                ←
              </IconButton>
              <IconButton label="Move right" disabled={!nextColumn} onClick={() => nextColumn && actions.moveCard(card.id, nextColumn, Number.MAX_SAFE_INTEGER)}>
                →
              </IconButton>
              <IconButton label="Simulate a concurrent conflicting edit on this card" disabled={simulating} onClick={() => void simulate()}>
                ⚡
              </IconButton>
              <IconButton label="Delete card" onClick={() => actions.deleteCard(card.id)}>
                ✕
              </IconButton>
            </div>
          </footer>
        </>
      )}
    </article>
  );
}

function IconButton(props: { label: string; disabled?: boolean; onClick: () => void; children: string }): ReactElement {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="grid h-6 w-6 place-items-center rounded text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-30"
    >
      {props.children}
    </button>
  );
}
