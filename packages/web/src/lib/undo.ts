import { useSyncExternalStore } from "react";

/**
 * The last edit that can be undone. Every edit route returns a `batch_id`;
 * the toast in the shell offers to reverse it until the next edit replaces it
 * or it times out.
 */
export interface UndoOffer {
  id: number;
  message: string;
  batchId: string;
}

let current: UndoOffer | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function offerUndo(message: string, batchId: string | null | undefined): void {
  if (!batchId) return;
  current = { id: ++seq, message, batchId };
  clearTimeout(timer);
  timer = setTimeout(dismissUndo, 15_000);
  emit();
}

export function dismissUndo(): void {
  clearTimeout(timer);
  if (current === null) return;
  current = null;
  emit();
}

/** Keep the toast up while the pointer or focus is on it. */
export function holdUndo(hold: boolean): void {
  clearTimeout(timer);
  if (!hold && current) timer = setTimeout(dismissUndo, 6_000);
}

export function useUndoOffer(): UndoOffer | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
