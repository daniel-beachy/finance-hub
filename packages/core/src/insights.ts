import type { SqlDriver } from "./db/driver.ts";
import { IN_REVIEW_SQL, LABEL_SQL, listTransactions, netWorth, type TransactionView } from "./queries.ts";
import { addDays } from "./util/money.ts";

/**
 * Read models for the dashboard. Conventions: "spending" is the net of every
 * expense-kind category shown as a positive number (refunds reduce it);
 * "income" is the net of income-kind categories. Transfers, investment
 * moves, pending rows and excluded rows are left out of both.
 */

const COUNTED = "t.removed_at IS NULL AND t.is_split_parent = 0 AND t.excluded = 0 AND t.pending = 0";

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  return addDays(monthStart(shiftMonth(month, 1)), -1);
}

export interface CashFlowMonth {
  month: string;
  income_cents: number;
  spending_cents: number;
}

/** Income and spending for each month in the range, including empty months. */
export async function cashFlowByMonth(db: SqlDriver, fromMonth: string, toMonth: string): Promise<CashFlowMonth[]> {
  const rows = await db.all<{ month: string; kind: string; total: number }>(
    `SELECT substr(t.posted_date, 1, 7) AS month, c.kind, SUM(t.amount_cents) AS total
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE ${COUNTED} AND c.kind IN ('income', 'expense') AND t.posted_date BETWEEN ? AND ?
     GROUP BY month, c.kind`,
    [monthStart(fromMonth), monthEnd(toMonth)],
  );
  const out: CashFlowMonth[] = [];
  for (let month = fromMonth; month <= toMonth; month = shiftMonth(month, 1)) {
    const find = (kind: string) => rows.find((r) => r.month === month && r.kind === kind)?.total ?? 0;
    out.push({ month, income_cents: find("income"), spending_cents: -find("expense") });
  }
  return out;
}

export interface CategoryTotal {
  category_id: string;
  name: string;
  group_id: string;
  group_name: string;
  kind: string;
  /** Signed sum: negative for spending. */
  total_cents: number;
  count: number;
}

export interface MerchantTotal {
  merchant: string;
  total_cents: number;
  count: number;
}

export interface SpendingBreakdown {
  from: string;
  to: string;
  spending_cents: number;
  income_cents: number;
  /** Spending over the period of the same length just before this one. */
  previous_spending_cents: number;
  categories: CategoryTotal[];
  merchants: MerchantTotal[];
}

export async function totalsByCategory(db: SqlDriver, from: string, to: string): Promise<CategoryTotal[]> {
  return db.all<CategoryTotal>(
    `SELECT c.id AS category_id, c.name, g.id AS group_id, g.name AS group_name, c.kind,
       SUM(t.amount_cents) AS total_cents, COUNT(*) AS count
     FROM transactions t JOIN categories c ON c.id = t.category_id JOIN category_groups g ON g.id = c.group_id
     WHERE ${COUNTED} AND c.kind IN ('income', 'expense') AND t.posted_date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY total_cents ASC, c.id`,
    [from, to],
  );
}

export async function spendingBreakdown(db: SqlDriver, from: string, to: string): Promise<SpendingBreakdown> {
  const categories = await totalsByCategory(db, from, to);
  const merchants = await db.all<MerchantTotal>(
    `SELECT ${LABEL_SQL} AS merchant, SUM(t.amount_cents) AS total_cents, COUNT(*) AS count
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE ${COUNTED} AND c.kind = 'expense' AND t.posted_date BETWEEN ? AND ?
     GROUP BY merchant HAVING SUM(t.amount_cents) < 0 ORDER BY total_cents ASC, merchant LIMIT 12`,
    [from, to],
  );
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const previous = await db.all<{ total: number | null }>(
    `SELECT SUM(t.amount_cents) AS total FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE ${COUNTED} AND c.kind = 'expense' AND t.posted_date BETWEEN ? AND ?`,
    [addDays(from, -days), addDays(from, -1)],
  );
  const sum = (kind: string) => categories.filter((c) => c.kind === kind).reduce((n, c) => n + c.total_cents, 0);
  return {
    from,
    to,
    spending_cents: -sum("expense"),
    income_cents: sum("income"),
    previous_spending_cents: -(previous[0]?.total ?? 0),
    categories,
    merchants,
  };
}

export interface NetWorthPoint {
  date: string;
  assets_cents: number;
  liabilities_cents: number;
  net_cents: number;
}

/**
 * Net worth at each month end up to `today`, plus `today` itself. Each
 * account carries its latest known balance forward, so accounts that report
 * on different days still add up.
 */
export async function netWorthHistory(db: SqlDriver, today: string, months: number): Promise<NetWorthPoint[]> {
  const rows = await db.all<{ account_id: string; as_of: string; current_cents: number }>(
    `SELECT b.account_id, b.as_of, b.current_cents FROM balances b JOIN accounts a ON a.id = b.account_id
     WHERE a.include_in_net_worth = 1 AND a.closed_at IS NULL AND b.as_of <= ?
     ORDER BY b.as_of`,
    [today],
  );
  if (rows.length === 0) return [];
  const earliest = monthOf(rows[0]!.as_of);
  const dates: string[] = [];
  for (let month = shiftMonth(monthOf(today), -months); month < monthOf(today); month = shiftMonth(month, 1)) {
    if (month >= earliest) dates.push(monthEnd(month));
  }
  dates.push(today);

  const latest = new Map<string, number>();
  const out: NetWorthPoint[] = [];
  let i = 0;
  for (const date of dates) {
    while (i < rows.length && rows[i]!.as_of <= date) {
      latest.set(rows[i]!.account_id, rows[i]!.current_cents);
      i++;
    }
    let assets = 0;
    let liabilities = 0;
    for (const cents of latest.values()) {
      if (cents >= 0) assets += cents;
      else liabilities += cents;
    }
    out.push({ date, assets_cents: assets, liabilities_cents: liabilities, net_cents: assets + liabilities });
  }
  return out;
}

export interface ReviewCounts {
  all: number;
  large: number;
  unfamiliar: number;
  uncategorized: number;
  flagged: number;
}

export async function reviewCounts(db: SqlDriver): Promise<ReviewCounts> {
  const rows = await db.all<ReviewCounts>(
    `SELECT COUNT(*) AS "all",
       COALESCE(SUM(t.reviewed_at IS NULL AND (t.review_reasons LIKE '%"large"%' OR t.review_reasons LIKE '%"unusual"%')), 0) AS large,
       COALESCE(SUM(t.reviewed_at IS NULL AND (t.review_reasons LIKE '%"unfamiliar"%' OR t.review_reasons LIKE '%"duplicate"%')), 0) AS unfamiliar,
       COALESCE(SUM(t.reviewed_at IS NULL AND t.review_reasons LIKE '%"uncategorized"%'), 0) AS uncategorized,
       COALESCE(SUM(t.flag IN ('suspicious', 'disputed')), 0) AS flagged
     FROM transactions t WHERE t.removed_at IS NULL AND ${IN_REVIEW_SQL}`,
  );
  return rows[0] ?? { all: 0, large: 0, unfamiliar: 0, uncategorized: 0, flagged: 0 };
}

export interface MerchantHistory {
  merchant: string;
  count: number;
  first_date: string | null;
  median_cents: number | null;
  /** The most recent other charges from the same merchant. */
  recent: { id: string; posted_date: string; amount_cents: number; category_name: string | null }[];
}

/** What else this merchant has charged: context for judging one transaction. */
export async function merchantHistory(db: SqlDriver, tx: Pick<TransactionView, "id" | "label">): Promise<MerchantHistory> {
  const rows = await db.all<{ id: string; posted_date: string; amount_cents: number; category_name: string | null }>(
    `SELECT t.id, t.posted_date, t.amount_cents, c.name AS category_name
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.removed_at IS NULL AND t.is_split_parent = 0 AND ${LABEL_SQL} = ? AND t.id != ?
     ORDER BY t.posted_date DESC, t.id DESC`,
    [tx.label, tx.id],
  );
  const amounts = rows.map((r) => r.amount_cents).sort((a, b) => a - b);
  return {
    merchant: tx.label,
    count: rows.length,
    first_date: rows.length ? rows[rows.length - 1]!.posted_date : null,
    median_cents: amounts.length ? amounts[Math.floor(amounts.length / 2)]! : null,
    recent: rows.slice(0, 5),
  };
}

export interface Overview {
  today: string;
  net_worth: { assets_cents: number; liabilities_cents: number; net_cents: number };
  net_worth_history: NetWorthPoint[];
  cash_flow: CashFlowMonth[];
  month: {
    month: string;
    spending_cents: number;
    income_cents: number;
    /** Average spending by this day of the month over the three months before. */
    typical_to_date_cents: number;
    /** Average full-month spending over the three months before. */
    typical_month_cents: number;
  };
  top_categories: CategoryTotal[];
  review: ReviewCounts;
  recent: TransactionView[];
}

export async function overview(db: SqlDriver, today: string): Promise<Overview> {
  const month = monthOf(today);
  const cashFlow = await cashFlowByMonth(db, shiftMonth(month, -5), month);
  const thisMonth = cashFlow[cashFlow.length - 1]!;
  const day = today.slice(8);
  let toDate = 0;
  let full = 0;
  for (let i = 1; i <= 3; i++) {
    const m = shiftMonth(month, -i);
    const end = monthEnd(m);
    const sameDay = `${m}-${day}` > end ? end : `${m}-${day}`;
    const rows = await db.all<{ to_date: number | null; full: number | null }>(
      `SELECT SUM(CASE WHEN t.posted_date <= ? THEN t.amount_cents END) AS to_date, SUM(t.amount_cents) AS full
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE ${COUNTED} AND c.kind = 'expense' AND t.posted_date BETWEEN ? AND ?`,
      [sameDay, monthStart(m), end],
    );
    toDate -= rows[0]?.to_date ?? 0;
    full -= rows[0]?.full ?? 0;
  }
  const categories = await totalsByCategory(db, monthStart(month), today);
  return {
    today,
    net_worth: await netWorth(db),
    net_worth_history: await netWorthHistory(db, today, 12),
    cash_flow: cashFlow,
    month: {
      month,
      spending_cents: thisMonth.spending_cents,
      income_cents: thisMonth.income_cents,
      typical_to_date_cents: Math.round(toDate / 3),
      typical_month_cents: Math.round(full / 3),
    },
    top_categories: categories.filter((c) => c.kind === "expense" && c.total_cents < 0).slice(0, 6),
    review: await reviewCounts(db),
    recent: (await listTransactions(db, { limit: 8 })).rows,
  };
}
