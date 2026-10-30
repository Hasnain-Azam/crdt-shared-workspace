"use client";

/**
 * React binding for the sync engine. It is deliberately thin: it owns the
 * engine's lifecycle and exposes its state via useSyncExternalStore.
 * All sync logic stays in src/core.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createBrowserEngine, type BrowserEngine } from "../client/bootstrap";
import type { CardUpdate, CreateCardInput } from "../core/crdt/workspaceDoc";
import type { EngineState, SimulationResult } from "../core/network/syncEngine";

export interface WorkspaceActions {
  createCard(input: CreateCardInput): void;
  updateCard(id: string, update: CardUpdate): void;
  moveCard(id: string, columnId: string, index: number): void;
  deleteCard(id: string): void;
  createColumn(title: string): void;
  renameColumn(id: string, title: string): void;
  deleteColumn(id: string): void;
  setOnline(online: boolean): void;
  simulateConflict(cardId: string): Promise<SimulationResult | null>;
  clearConflicts(): void;
  resetLocalData(): Promise<void>;
}

export interface UseSyncEngineResult {
  readonly state: EngineState | null;
  readonly actions: WorkspaceActions | null;
  readonly error: string | null;
  readonly dismissError: () => void;
}

const noopUnsubscribe = (): void => {};

export function useSyncEngine(room: string): UseSyncEngineResult {
  const [handle, setHandle] = useState<BrowserEngine | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: BrowserEngine | null = null;
    createBrowserEngine(room)
      .then((h) => {
        if (cancelled) {
          h.engine.dispose();
          return;
        }
        created = h;
        setHandle(h);
        h.engine.start(); // hydration finished in open(), so the network starts only now
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      created?.engine.dispose();
    };
  }, [room]);

  const engine = handle?.engine ?? null;
  const subscribe = useCallback((cb: () => void) => (engine ? engine.subscribe(cb) : noopUnsubscribe), [engine]);
  const state = useSyncExternalStore(
    subscribe,
    () => engine?.getState() ?? null,
    () => null,
  );

  const actions = useMemo<WorkspaceActions | null>(() => {
    if (handle === null) return null;
    const { engine: e, store } = handle;
    // Mutations can fail legitimately, e.g. editing a card a peer deleted a moment ago.
    const run = (fn: () => Promise<unknown>): void => {
      fn().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    };
    return {
      createCard: (input) => run(() => e.mutate((d) => d.createCard(input))),
      updateCard: (id, update) => run(() => e.mutate((d) => d.updateCard(id, update))),
      moveCard: (id, columnId, index) => run(() => e.mutate((d) => d.moveCard(id, columnId, index))),
      deleteCard: (id) => run(() => e.mutate((d) => d.deleteCard(id))),
      createColumn: (title) => run(() => e.mutate((d) => d.createColumn(title))),
      renameColumn: (id, title) => run(() => e.mutate((d) => d.renameColumn(id, title))),
      deleteColumn: (id) => run(() => e.mutate((d) => d.deleteColumn(id))),
      setOnline: (online) => e.setOnline(online),
      simulateConflict: async (cardId) => {
        try {
          return await e.simulateConflict(cardId);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : String(err));
          return null;
        }
      },
      clearConflicts: () => e.clearConflicts(),
      resetLocalData: async () => {
        e.dispose();
        await store.clear();
        window.location.reload();
      },
    };
  }, [handle]);

  return { state, actions, error, dismissError: () => setError(null) };
}
