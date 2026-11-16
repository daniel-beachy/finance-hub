import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type CategoryView, type RuleEditResult, type RuleMatch, type Status, type TransactionView, type UndoResult } from "../api.ts";
import { dismissUndo, offerUndo } from "./undo.ts";

/** GET a path. The previous result stays on screen while the next one loads. */
export function useGet<T>(path: string | null) {
  return useQuery({
    queryKey: [path],
    queryFn: () => api<T>(path as string),
    enabled: path !== null,
    placeholderData: keepPreviousData,
  });
}

export const useStatus = () => useGet<Status>("/api/status");

export function useCategories(): CategoryView[] {
  return useGet<{ categories: CategoryView[] }>("/api/categories").data?.categories ?? [];
}

export interface TransactionPatch {
  category_id?: string;
  note?: string | null;
  reviewed?: boolean;
  flag?: "suspicious" | "disputed" | "resolved" | null;
  excluded?: boolean;
}

/** What the undo toast says about a patch. */
function describePatch(patch: TransactionPatch, categories: CategoryView[]): string {
  if (patch.category_id) return `Moved to ${categories.find((c) => c.id === patch.category_id)?.name ?? "category"}`;
  if (patch.reviewed === true) return "Marked reviewed";
  if (patch.reviewed === false) return "Back in Review";
  if (patch.flag === "suspicious") return "Flagged";
  if (patch.flag === "resolved") return "Marked resolved";
  if (patch.note !== undefined) return patch.note ? "Note saved" : "Note removed";
  if (patch.excluded !== undefined) return patch.excluded ? "Left out of totals" : "Counted in totals";
  return "Saved";
}

/** Edit one transaction, then refresh everything that might show it. */
export function useUpdateTransaction() {
  const client = useQueryClient();
  const categories = useCategories();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TransactionPatch }) =>
      api<{ transaction: TransactionView; batch_id: string | null }>(`/api/transactions/${id}`, patch, "PATCH"),
    onSuccess: (res, { patch }) => offerUndo(describePatch(patch, categories), res.batch_id),
    onSettled: () => client.invalidateQueries(),
  });
}

export function useCategorizeMany() {
  const client = useQueryClient();
  const categories = useCategories();
  return useMutation({
    mutationFn: (input: { ids: string[]; category_id: string; create_rule?: boolean; remember?: boolean }) =>
      api<{ updated: number; batch_id: string }>("/api/transactions/categorize", input),
    onSuccess: (res, input) =>
      offerUndo(
        `${res.updated} moved to ${categories.find((c) => c.id === input.category_id)?.name ?? "category"}`,
        res.batch_id,
      ),
    onSettled: () => client.invalidateQueries(),
  });
}

export interface RuleBody {
  match?: RuleMatch;
  category_id?: string;
  priority?: number;
  enabled?: boolean;
  created_from_transaction_id?: string | null;
}

/** Create, change or delete a rule for real. Dry runs go through `api` directly. */
export function useRuleEdit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; body?: RuleBody; remove?: boolean; message: string }) =>
      input.remove
        ? api<RuleEditResult>(`/api/rules/${input.id}`, undefined, "DELETE")
        : input.id
          ? api<RuleEditResult>(`/api/rules/${input.id}`, input.body, "PATCH")
          : api<RuleEditResult>("/api/rules", input.body),
    onSuccess: (res, input) => {
      const n = res.changed;
      offerUndo(`${input.message}${n ? `: ${n} transaction${n === 1 ? "" : "s"} changed` : ""}`, res.batch_id);
    },
    onSettled: () => client.invalidateQueries(),
  });
}

export function useTransferEdit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { unmark: string } | { mark: [string, string] }) =>
      "unmark" in input
        ? api<{ batch_id: string }>("/api/transfers/unmark", { id: input.unmark })
        : api<{ batch_id: string }>("/api/transfers/mark", { ids: input.mark }),
    onSuccess: (res, input) => offerUndo("unmark" in input ? "Transfer unpaired" : "Paired as a transfer", res.batch_id),
    onSettled: () => client.invalidateQueries(),
  });
}

export function useUndo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => api<UndoResult>("/api/undo", { batch_id: batchId }),
    onSuccess: () => dismissUndo(),
    onSettled: () => client.invalidateQueries(),
  });
}

/** Width of an element, tracked as it resizes. Charts draw in real pixels. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
