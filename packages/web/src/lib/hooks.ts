import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type CategoryView, type Status, type TransactionView } from "../api.ts";

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
}

/** Edit one transaction, then refresh everything that might show it. */
export function useUpdateTransaction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TransactionPatch }) =>
      api<{ transaction: TransactionView }>(`/api/transactions/${id}`, patch, "PATCH"),
    onSettled: () => client.invalidateQueries(),
  });
}

export function useCategorizeMany() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: string[]; category_id: string }) =>
      api<{ updated: number }>("/api/transactions/categorize", input),
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
