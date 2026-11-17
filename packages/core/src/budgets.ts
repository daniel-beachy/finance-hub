import type { SqlDriver } from "./db/driver.ts";
import { monthEnd, monthOf, monthStart, shiftMonth } from "./insights.ts";
import { COUNTED_SQL } from "./queries.ts";

/**
 * Budgets (docs/PLAN.md M6): an amount per expense category, either for one
 * month or as the default for every month without its own amount. Spent is
 * the same figure `spending_summary` gives for the category and month: net of
 * refunds, transfers and excluded rows left out.
 *
 * Rollover: when a month's budget has rollover on, what was left of last
 * month's budget (or the overspend) is added to this month's. It counts back
 * to the month the category's budget was first set, never before.
 */

export interface BudgetRow {
  id: string;
  category_id: string;
  /** `YYYY-MM`, or null for the default. */
  month: string | null;
  amount_cents: number;
  rollover: number;
  since_month: string | null;
}

export interface BudgetLine {
  category_id: string;
  name: string;
  group_id: string;
  group_name: string;
  /** The amount set for this month, or null when the category has no budget. */
  budget_cents: number | null;
  /** Where the amount comes from: this month's own row, or the default. */
  source: "month" | "default" | null;
  rollover: boolean;
  /** Left over (positive) or overspent (negative) from last month, when rollover is on. */
  carried_cents: number;
  /** Budget plus what was carried. */
  available_cents: number;
  /** Net spending this month, positive. */
  spent_cents: number;
  /** Available minus spent; negative when over. */
  remaining_cents: number;
}

export interface BudgetStatus {
  month: string;
  /** Share of the month gone by `today`: 1 for a past month, 0 for a future one. */
  elapsed: number;
  lines: BudgetLine[];
  totals: {
    budget_cents: number;
    carried_cents: number;
    available_cents: number;
    /** Spending in categories that have a budget. */
    budgeted_spent_cents: number;
    /** Spending in categories without one. */
    unbudgeted_spent_cents: number;
    /** All spending this month: the same as spending_summary's total. */
    spent_cents: number;
    remaining_cents: number;
    /**
     * What spending would be by now at an even pace through the month,
     * counting recurring charges already paid (rent on the 1st) as on time.
     */
    expected_by_now_cents: number;
  };
}

/** How many months back rollover is followed at most. */
const ROLLOVER_LIMIT = 36;

export async function listBudgets(db: SqlDriver): Promise<BudgetRow[]> {
  return db.all<BudgetRow>("SELECT id, category_id, month, amount_cents, rollover, since_month FROM budgets ORDER BY category_id, month");
}

/** The budget that applies to a category in a month: its own row, else the default. */
function effective(rows: BudgetRow[], month: string): BudgetRow | undefined {
  return rows.find((r) => r.month === month) ?? rows.find((r) => r.month === null);
}

function elapsedShare(month: string, today: string): number {
  const current = monthOf(today);
  if (month < current) return 1;
  if (month > current) return 0;
  const days = Number(monthEnd(month).slice(8));
  return Number(today.slice(8)) / days;
}

export async function budgetStatus(db: SqlDriver, month: string, today: string): Promise<BudgetStatus> {
  const budgets = await listBudgets(db);
  const byCategory = new Map<string, BudgetRow[]>();
  for (const b of budgets) byCategory.set(b.category_id, [...(byCategory.get(b.category_id) ?? []), b]);

  // Spending by category and month, from the earliest month rollover could need.
  const starts = budgets.map((b) => b.since_month).filter((m): m is string => !!m && m < month);
  const earliest = starts.length ? [...starts].sort()[0]! : month;
  // The later of the first budget month and the rollover limit (months compare as text).
  const from = [earliest, shiftMonth(month, -ROLLOVER_LIMIT)].sort()[1]!;
  const spentRows = await db.all<{ category_id: string; month: string; spent: number }>(
    `SELECT t.category_id, substr(t.posted_date, 1, 7) AS month, -SUM(t.amount_cents) AS spent
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE ${COUNTED_SQL} AND c.kind = 'expense' AND t.posted_date BETWEEN ? AND ?
     GROUP BY t.category_id, month`,
    [monthStart(from), monthEnd(month)],
  );
  const spent = new Map<string, number>();
  for (const r of spentRows) spent.set(`${r.category_id}|${r.month}`, r.spent);
  const spentIn = (category: string, m: string) => spent.get(`${category}|${m}`) ?? 0;

  /** Budget plus carry for a category in a month, following rollover back. */
  const available = (category: string, rows: BudgetRow[], m: string, depth: number): { carried: number; available: number } => {
    const row = effective(rows, m);
    if (!row) return { carried: 0, available: 0 };
    const since = rows.map((r) => r.since_month).filter((x): x is string => !!x).sort()[0] ?? m;
    const previous = shiftMonth(m, -1);
    let carried = 0;
    if (row.rollover && previous >= since && depth < ROLLOVER_LIMIT && effective(rows, previous)) {
      const prior = available(category, rows, previous, depth + 1);
      carried = prior.available - spentIn(category, previous);
    }
    return { carried, available: row.amount_cents + carried };
  };

  const categories = await db.all<{ id: string; name: string; group_id: string; group_name: string }>(
    `SELECT c.id, c.name, g.id AS group_id, g.name AS group_name FROM categories c JOIN category_groups g ON g.id = c.group_id
     WHERE c.kind = 'expense' ORDER BY g.sort, c.sort`,
  );
  const lines: BudgetLine[] = [];
  for (const c of categories) {
    const rows = byCategory.get(c.id) ?? [];
    const row = effective(rows, month);
    const s = spentIn(c.id, month);
    if (!row && s === 0) continue;
    const a = row ? available(c.id, rows, month, 0) : { carried: 0, available: 0 };
    lines.push({
      category_id: c.id,
      name: c.name,
      group_id: c.group_id,
      group_name: c.group_name,
      budget_cents: row ? row.amount_cents : null,
      source: row ? (row.month === null ? "default" : "month") : null,
      rollover: !!row?.rollover,
      carried_cents: a.carried,
      available_cents: a.available,
      spent_cents: s,
      remaining_cents: row ? a.available - s : 0,
    });
  }

  const elapsed = elapsedShare(month, today);
  // Recurring charges already paid this month (rent on the 1st) are on
  // schedule, not ahead of it: the even pace never counts them as early.
  const scheduled = new Map<string, number>();
  for (const r of await db.all<{ category_id: string; paid: number }>(
    `SELECT t.category_id, -SUM(t.amount_cents) AS paid
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE ${COUNTED_SQL} AND c.kind = 'expense' AND t.posted_date BETWEEN ? AND ?
       AND t.id IN (SELECT m.transaction_id FROM recurring_members m JOIN recurring_series s ON s.id = m.series_id WHERE s.status = 'active')
     GROUP BY t.category_id`,
    [monthStart(month), monthEnd(month)],
  )) {
    scheduled.set(r.category_id, r.paid);
  }
  const expectedFor = (l: BudgetLine) =>
    Math.min(l.available_cents, Math.max(Math.round(l.available_cents * elapsed), scheduled.get(l.category_id) ?? 0));
  const budgeted = lines.filter((l) => l.budget_cents !== null);
  const sum = (list: BudgetLine[], f: (l: BudgetLine) => number) => list.reduce((n, l) => n + f(l), 0);
  const budgetTotal = sum(budgeted, (l) => l.budget_cents ?? 0);
  return {
    month,
    elapsed,
    lines,
    totals: {
      budget_cents: budgetTotal,
      carried_cents: sum(budgeted, (l) => l.carried_cents),
      available_cents: sum(budgeted, (l) => l.available_cents),
      budgeted_spent_cents: sum(budgeted, (l) => l.spent_cents),
      unbudgeted_spent_cents: sum(
        lines.filter((l) => l.budget_cents === null),
        (l) => l.spent_cents,
      ),
      spent_cents: sum(lines, (l) => l.spent_cents),
      remaining_cents: sum(budgeted, (l) => l.remaining_cents),
      expected_by_now_cents: sum(budgeted, (l) => Math.max(0, expectedFor(l))),
    },
  };
}
