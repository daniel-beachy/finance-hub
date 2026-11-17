import { type AlertView, listAlerts } from "./alerts.ts";
import { budgetStatus } from "./budgets.ts";
import type { SqlDriver } from "./db/driver.ts";
import { monthOf, type ReviewCounts, reviewCounts } from "./insights.ts";
import { COUNTED_SQL, LABEL_SQL } from "./queries.ts";
import { listRecurring, type UpcomingCharge, upcomingCharges } from "./recurring.ts";
import { addDays } from "./util/money.ts";

/**
 * The weekly digest (docs/PLAN.md M6): the facts for a weekly review, worked
 * out the same way every time. Home shows it, `weekly_digest` returns it, and
 * the `weekly-review` prompt has Claude narrate it.
 */

export interface DigestGroup {
  group_id: string;
  name: string;
  /** Net spending in the 7 days, positive. */
  spent_cents: number;
  /** Average weekly spending over the 8 weeks before. */
  average_cents: number;
  change_cents: number;
}

export interface DigestCharge {
  id: string;
  date: string;
  merchant: string;
  amount_cents: number;
  category: string | null;
  account: string;
}

export interface WeeklyDigest {
  from: string;
  to: string;
  spending_cents: number;
  average_weekly_cents: number;
  income_cents: number;
  groups: DigestGroup[];
  largest: DigestCharge[];
  new_merchants: { merchant: string; first_date: string; amount_cents: number }[];
  alerts: AlertView[];
  budget: {
    month: string;
    available_cents: number;
    spent_cents: number;
    /** Where spending would be today at an even pace through the month. */
    expected_by_now_cents: number;
    over: { category_id: string; name: string; available_cents: number; spent_cents: number }[];
  } | null;
  review: ReviewCounts;
  upcoming: UpcomingCharge[];
}

export async function weeklyDigest(db: SqlDriver, today: string): Promise<WeeklyDigest> {
  const from = addDays(today, -6);
  const priorFrom = addDays(from, -56);

  const groups = await db.all<{ group_id: string; name: string; week: number; prior: number }>(
    `SELECT g.id AS group_id, g.name,
       -COALESCE(SUM(CASE WHEN t.posted_date >= ? THEN t.amount_cents END), 0) AS week,
       -COALESCE(SUM(CASE WHEN t.posted_date < ? THEN t.amount_cents END), 0) AS prior
     FROM transactions t JOIN categories c ON c.id = t.category_id JOIN category_groups g ON g.id = c.group_id
     WHERE ${COUNTED_SQL} AND c.kind = 'expense' AND t.posted_date BETWEEN ? AND ?
     GROUP BY g.id ORDER BY g.sort`,
    [from, from, priorFrom, today],
  );
  const groupRows: DigestGroup[] = groups
    .map((g) => ({ group_id: g.group_id, name: g.name, spent_cents: g.week, average_cents: Math.round(g.prior / 8), change_cents: g.week - Math.round(g.prior / 8) }))
    .filter((g) => g.spent_cents !== 0 || g.average_cents !== 0)
    .sort((a, b) => b.spent_cents - a.spent_cents);

  const income = await db.all<{ total: number | null }>(
    `SELECT SUM(t.amount_cents) AS total FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE ${COUNTED_SQL} AND c.kind = 'income' AND t.posted_date BETWEEN ? AND ?`,
    [from, today],
  );

  const largest = await db.all<DigestCharge>(
    `SELECT t.id, t.posted_date AS date, ${LABEL_SQL} AS merchant, t.amount_cents, c.name AS category, a.name AS account
     FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${COUNTED_SQL} AND (c.kind IS NULL OR c.kind = 'expense') AND t.amount_cents < 0 AND t.posted_date BETWEEN ? AND ?
     ORDER BY t.amount_cents ASC, t.posted_date DESC LIMIT 5`,
    [from, today],
  );

  const fresh = await db.all<{ merchant: string; first_date: string; amount_cents: number }>(
    `SELECT ${LABEL_SQL} AS merchant, MIN(t.posted_date) AS first_date, SUM(t.amount_cents) AS amount_cents
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.removed_at IS NULL AND t.pending = 0 AND t.parent_id IS NULL AND t.amount_cents < 0
       AND (c.kind IS NULL OR c.kind = 'expense')
     GROUP BY COALESCE(t.merchant_id, ${LABEL_SQL})
     HAVING MIN(t.posted_date) BETWEEN ? AND ?
     ORDER BY first_date DESC, merchant LIMIT 10`,
    [from, today],
  );

  const budget = await budgetStatus(db, monthOf(today), today);
  const hasBudget = budget.lines.some((l) => l.budget_cents !== null);

  return {
    from,
    to: today,
    spending_cents: groupRows.reduce((n, g) => n + g.spent_cents, 0),
    average_weekly_cents: groupRows.reduce((n, g) => n + g.average_cents, 0),
    income_cents: income[0]?.total ?? 0,
    groups: groupRows,
    largest,
    new_merchants: fresh,
    alerts: await listAlerts(db, { limit: 20 }),
    budget: hasBudget
      ? {
          month: budget.month,
          available_cents: budget.totals.available_cents,
          spent_cents: budget.totals.budgeted_spent_cents,
          expected_by_now_cents: budget.totals.expected_by_now_cents,
          over: budget.lines
            .filter((l) => l.budget_cents !== null && l.spent_cents > l.available_cents)
            .map((l) => ({ category_id: l.category_id, name: l.name, available_cents: l.available_cents, spent_cents: l.spent_cents })),
        }
      : null,
    review: await reviewCounts(db),
    upcoming: upcomingCharges(await listRecurring(db, today), today, 14),
  };
}
