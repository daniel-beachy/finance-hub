export interface Account {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  current_cents: number | null;
  transaction_count: number;
}

export interface Connection {
  id: string;
  source: string;
  plaid_env: string | null;
  institution_name: string;
  status: string;
  consent_expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  accounts: Account[];
}

export interface SyncRun {
  id: string;
  started_at: string;
  institution_name: string | null;
  trigger: string;
  status: string;
  added: number;
  modified: number;
  removed: number;
  error_code: string | null;
}

export interface Status {
  mode: string;
  plaid_env: "sandbox" | "production";
  slots_used: number;
  slot_limit: number;
  net_worth: { assets_cents: number; liabilities_cents: number; net_cents: number };
}

export class ApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, json.code);
  return json as T;
}

export function money(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
