import type {
  AccountView,
  CashFlowMonth,
  CategoryView,
  ConnectionView,
  MerchantHistory,
  NetWorthPoint,
  Overview,
  ReviewCounts,
  SpendingBreakdown,
  SyncRunView,
  TransactionView,
} from "@finance-hub/core";

export type {
  AccountView,
  CashFlowMonth,
  CategoryView,
  ConnectionView,
  MerchantHistory,
  NetWorthPoint,
  Overview,
  ReviewCounts,
  SpendingBreakdown,
  SyncRunView,
  TransactionView,
};

export const DEMO = import.meta.env.VITE_MODE === "demo";

export interface Status {
  mode: "local" | "demo";
  today: string;
  plaid_env: "sandbox" | "production";
  slots_used: number;
  slot_limit: number;
  net_worth: { assets_cents: number; liabilities_cents: number; net_cents: number };
}

export interface TransactionPage {
  total: number;
  sum_cents: number;
  rows: TransactionView[];
}

export interface ReviewItem {
  transaction: TransactionView;
  history: MerchantHistory;
}

export interface NetWorthData {
  today: string;
  now: Status["net_worth"];
  history: NetWorthPoint[];
  accounts: AccountView[];
}

export class ApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

type Send = (path: string, init?: RequestInit) => Promise<Response>;

// The demo runs the very same API inside the page, on a database held in
// memory. The condition is static, so the local build leaves that code out.
const send: Send = DEMO
  ? async (path, init) => (await import("./demo.ts")).demoFetch(path, init)
  : (path, init) => fetch(path, init);

export async function api<T>(path: string, body?: unknown, method?: "POST" | "PATCH"): Promise<T> {
  const res = await send(path, {
    method: body === undefined ? "GET" : (method ?? "POST"),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, json.code);
  return json as T;
}
