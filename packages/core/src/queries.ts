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
  account_mask: string | null;
  posted_date: string;
  amount_cents: number;
  description_raw: string;
  merchant_raw: string | null;
  /** The merchant name when known, otherwise the bank's description. */
  label: string;
  pending: number;
  category_id: string | null;
  category_name: string | null;
  category_kind: string | null;
  group_name: string | null;
  category_source: string | null;
  plaid_pfc_detailed: string | null;
  note: string | null;
  flag: string | null;
  reviewed_at: string | null;
  review_reasons: string[];
}

export type ReviewTab = "all" | "large" | "unfamiliar" | "uncategorized" | "flagged";

export interface TransactionFilter {
  limit?: number;
  offset?: number;
  q?: string;
  accountId?: string;
  categoryId?: string;
  groupId?: string;
  /** income | expense | transfer | investment */
  kind?: string;
  /** Exact merchant label. */
  merchant?: string;
  from?: string;
  to?: string;
  /** Limits to what is waiting in Review, optionally one tab of it. */
  review?: ReviewTab;
}

/** What a transaction is called on screen: the merchant if known, else the description. */
export const LABEL_SQL = "COALESCE(t.merchant_raw, t.description_raw)";

/** Waiting in Review: has unreviewed reasons, or carries an open flag. */
export const IN_REVIEW_SQL =
  "((t.review_reasons IS NOT NULL AND t.reviewed_at IS NULL) OR t.flag IN ('suspicious', 'disputed'))";

const REVIEW_TAB_SQL: Record<ReviewTab, string> = {
  all: IN_REVIEW_SQL,
  large: `(t.reviewed_at IS NULL AND (t.review_reasons LIKE '%"large"%' OR t.review_reasons LIKE '%"unusual"%'))`,
  unfamiliar: `(t.reviewed_at IS NULL AND (t.review_reasons LIKE '%"unfamiliar"%' OR t.review_reasons LIKE '%"duplicate"%'))`,
  uncategorized: `(t.reviewed_at IS NULL AND t.review_reasons LIKE '%"uncategorized"%')`,
  flagged: "t.flag IN ('suspicious', 'disputed')",
};

const TRANSACTION_SELECT = `SELECT t.id, t.account_id, a.name AS account_name, a.mask AS account_mask, t.posted_date,
       t.amount_cents, t.description_raw, t.merchant_raw, ${LABEL_SQL} AS label, t.pending, t.category_id,
       c.name AS category_name, c.kind AS category_kind, g.name AS group_name, t.category_source,
       t.plaid_pfc_detailed, t.note, t.flag, t.reviewed_at, t.review_reasons
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN category_groups g ON g.id = c.group_id`;

type TransactionRow = Omit<TransactionView, "review_reasons"> & { review_reasons: string | null };

function toView(row: TransactionRow): TransactionView {
  return { ...row, review_reasons: row.review_reasons ? (JSON.parse(row.review_reasons) as string[]) : [] };
}

export async function getTransaction(db: SqlDriver, id: string): Promise<TransactionView | undefined> {
  const rows = await db.all<TransactionRow>(`${TRANSACTION_SELECT} WHERE t.id = ?`, [id]);
  return rows[0] ? toView(rows[0]) : undefined;
}

export async function listTransactions(
  db: SqlDriver,
  opts: TransactionFilter = {},
): Promise<{ total: number; sum_cents: number; rows: TransactionView[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where = ["t.removed_at IS NULL", "t.is_split_parent = 0"];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    params.push(...values);
  };
  if (opts.accountId) add("t.account_id = ?", opts.accountId);
  if (opts.categoryId) add("t.category_id = ?", opts.categoryId);
  if (opts.groupId) add("c.group_id = ?", opts.groupId);
  if (opts.kind) add("c.kind = ?", opts.kind);
  if (opts.merchant) add(`${LABEL_SQL} = ?`, opts.merchant);
  if (opts.from) add("t.posted_date >= ?", opts.from);
  if (opts.to) add("t.posted_date <= ?", opts.to);
  if (opts.review) where.push(REVIEW_TAB_SQL[opts.review] ?? IN_REVIEW_SQL);
  const q = opts.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    add(
      `(t.description_raw LIKE ? ESCAPE '\\' OR t.merchant_raw LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`,
      like,
      like,
      like,
      like,
    );
  }
  const clause = where.join(" AND ");
  const totals = await db.all<{ n: number; sum_cents: number | null }>(
    `SELECT COUNT(*) AS n, SUM(t.amount_cents) AS sum_cents FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id WHERE ${clause}`,
    params,
  );
  const rows = await db.all<TransactionRow>(
    `${TRANSACTION_SELECT} WHERE ${clause} ORDER BY t.posted_date DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, opts.offset ?? 0],
  );
  return { total: totals[0]?.n ?? 0, sum_cents: totals[0]?.sum_cents ?? 0, rows: rows.map(toView) };
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
