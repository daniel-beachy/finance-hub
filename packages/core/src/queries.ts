import type { SqlDriver } from "./db/driver.ts";

export interface AccountView {
  id: string;
  connection_id: string | null;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  tax_treatment: string;
  feed: string;
  current_cents: number | null;
  available_cents: number | null;
  balance_as_of: string | null;
  transaction_count: number;
}

export interface ConnectionView {
  id: string;
  source: string;
  plaid_env: string | null;
  institution_name: string;
  status: string;
  consent_expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  accounts: AccountView[];
}

export async function listAccounts(db: SqlDriver): Promise<AccountView[]> {
  return db.all<AccountView>(
    `SELECT a.id, a.connection_id, a.name, a.official_name, a.mask, a.type, a.subtype, a.tax_treatment, a.feed,
       b.current_cents, b.available_cents, b.as_of AS balance_as_of,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.removed_at IS NULL) AS transaction_count
     FROM accounts a
     LEFT JOIN balances b ON b.account_id = a.id
       AND b.as_of = (SELECT MAX(as_of) FROM balances WHERE account_id = a.id)
     WHERE a.closed_at IS NULL
     ORDER BY a.type, a.name`,
  );
}

export async function listConnections(db: SqlDriver): Promise<ConnectionView[]> {
  const connections = await db.all<Omit<ConnectionView, "accounts">>(
    `SELECT id, source, plaid_env, institution_name, status, consent_expires_at, last_synced_at, last_error, created_at
     FROM connections ORDER BY created_at`,
  );
  const accounts = await listAccounts(db);
  return connections.map((c) => ({ ...c, accounts: accounts.filter((a) => a.connection_id === c.id) }));
}

export interface TransactionView {
  id: string;
  account_id: string;
  account_name: string;
  posted_date: string;
  amount_cents: number;
  description_raw: string;
  merchant_raw: string | null;
  pending: number;
  category_id: string | null;
  category_name: string | null;
  plaid_pfc_detailed: string | null;
}

export async function listTransactions(
  db: SqlDriver,
  opts: { limit?: number; offset?: number; accountId?: string } = {},
): Promise<{ total: number; rows: TransactionView[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where = ["t.removed_at IS NULL", "t.is_split_parent = 0"];
  const params: (string | number)[] = [];
  if (opts.accountId) {
    where.push("t.account_id = ?");
    params.push(opts.accountId);
  }
  const clause = where.join(" AND ");
  const total = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions t WHERE ${clause}`, params);
  const rows = await db.all<TransactionView>(
    `SELECT t.id, t.account_id, a.name AS account_name, t.posted_date, t.amount_cents, t.description_raw,
       t.merchant_raw, t.pending, t.category_id, c.name AS category_name, t.plaid_pfc_detailed
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${clause}
     ORDER BY t.posted_date DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, opts.offset ?? 0],
  );
  return { total: total[0]?.n ?? 0, rows };
}

export interface SyncRunView {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  connection_id: string | null;
  institution_name: string | null;
  status: string;
  added: number;
  modified: number;
  removed: number;
  error_code: string | null;
  error_message: string | null;
}

export async function listSyncRuns(db: SqlDriver, limit = 30): Promise<SyncRunView[]> {
  return db.all<SyncRunView>(
    `SELECT r.*, c.institution_name FROM sync_runs r
     LEFT JOIN connections c ON c.id = r.connection_id
     ORDER BY r.started_at DESC, r.id DESC LIMIT ?`,
    [Math.min(Math.max(limit, 1), 200)],
  );
}

export interface CategoryView {
  id: string;
  group_id: string;
  group_name: string;
  name: string;
  kind: string;
  hidden: number;
}

export async function listCategories(db: SqlDriver): Promise<CategoryView[]> {
  return db.all<CategoryView>(
    `SELECT c.id, c.group_id, g.name AS group_name, c.name, c.kind, c.hidden
     FROM categories c JOIN category_groups g ON g.id = c.group_id
     ORDER BY g.sort, c.sort`,
  );
}

/** Totals by category over a date range. Transfers and excluded rows are left out. */
export async function spendingByCategory(
  db: SqlDriver,
  from: string,
  to: string,
): Promise<{ category_id: string; name: string; kind: string; total_cents: number; count: number }[]> {
  return db.all(
    `SELECT c.id AS category_id, c.name, c.kind, SUM(t.amount_cents) AS total_cents, COUNT(*) AS count
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE t.removed_at IS NULL AND t.is_split_parent = 0 AND t.excluded = 0 AND t.pending = 0
       AND c.kind != 'transfer' AND t.posted_date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY total_cents ASC, c.id`,
    [from, to],
  );
}

/** Latest balance per account, summed. Liabilities are stored negative. */
export async function netWorth(db: SqlDriver): Promise<{ assets_cents: number; liabilities_cents: number; net_cents: number }> {
  const rows = await db.all<{ current_cents: number }>(
    `SELECT b.current_cents FROM accounts a
     JOIN balances b ON b.account_id = a.id
       AND b.as_of = (SELECT MAX(as_of) FROM balances WHERE account_id = a.id)
     WHERE a.include_in_net_worth = 1 AND a.closed_at IS NULL`,
  );
  let assets = 0;
  let liabilities = 0;
  for (const r of rows) {
    if (r.current_cents >= 0) assets += r.current_cents;
    else liabilities += r.current_cents;
  }
  return { assets_cents: assets, liabilities_cents: liabilities, net_cents: assets + liabilities };
}
