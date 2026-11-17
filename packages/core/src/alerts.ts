import type { SqlDriver } from "./db/driver.ts";
import { getSetting } from "./db/seed.ts";
import type { CoreDeps } from "./deps.ts";
import { localDate } from "./deps.ts";
import { addDays } from "./util/money.ts";
import { CADENCE_DAYS, type Cadence, graceDays } from "./recurring.ts";
import { REVIEW_DEFAULTS } from "./review.ts";
import { LABEL_SQL } from "./queries.ts";

/**
 * Alerts (docs/PLAN.md M6): things worth a look, worked out from the data
 * after every `settle`. Each alert has a key naming what it's about, so it is
 * raised once, and a dismissed alert never comes back. An open alert whose
 * reason has gone (a charge Plaid removed, a late charge that arrived) is
 * taken away.
 *
 * Charges are judged from the same start date as Review: the `review_since`
 * setting, else the day each account was added. So linking an account
 * doesn't raise alerts for years of history.
 */

export type AlertKind =
  | "duplicate"
  | "large"
  | "new_merchant"
  | "fee"
  | "price_increase"
  | "new_subscription"
  | "missed_recurring"
  | "connection"
  | "import";

export const ALERT_DEFAULTS = {
  /** A first charge from a merchant at least this large is a large-charge alert. */
  largeNewMerchantCents: 50_000,
  /** Over this many times the merchant's median is a large-charge alert. */
  largeMultiple: 3,
  /** Same merchant, same amount, same account, within this many days. */
  duplicateDays: 3,
  /**
   * A merchant that has charged the exact amount this many times before is
   * charging a regular price (a transit fare, a car wash), not a duplicate.
   */
  regularPriceCount: 3,
} as const;

interface Desired {
  key: string;
  kind: AlertKind;
  transaction_id: string | null;
  series_id: string | null;
  connection_id: string | null;
  message: string;
  data: Record<string, unknown>;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** `$1,234.56` for a size of money, sign dropped. */
export const dollars = (cents: number): string => usd.format(Math.abs(cents) / 100);

const CADENCE_WORD: Record<Cadence, string> = {
  weekly: "a week",
  biweekly: "every two weeks",
  monthly: "a month",
  quarterly: "a quarter",
  yearly: "a year",
};

interface ChargeRow {
  id: string;
  account_id: string;
  account_name: string;
  merchant: string;
  label: string;
  description_raw: string;
  posted_date: string;
  amount_cents: number;
  category_id: string | null;
  plaid_pfc_primary: string | null;
  since: string;
}

/** Work out which alerts should be open now. Reads only. */
export async function desiredAlerts(db: SqlDriver, today: string): Promise<Desired[]> {
  const fixedSince = await getSetting<string | null>(db, "review_since", null);
  const largeNew = await getSetting(db, "alert_large_new_merchant_cents", ALERT_DEFAULTS.largeNewMerchantCents);
  const newMerchant = await getSetting(db, "review_new_merchant_cents", REVIEW_DEFAULTS.newMerchantCents);
  const out: Desired[] = [];

  // Charges as the bank sent them: money out, not transfers, split originals rather than parts.
  const charges = await db.all<ChargeRow>(
    `SELECT t.id, t.account_id, a.name AS account_name, COALESCE(t.merchant_id, ${LABEL_SQL}) AS merchant,
       COALESCE(m.name, ${LABEL_SQL}) AS label, t.description_raw, t.posted_date, t.amount_cents, t.category_id,
       t.plaid_pfc_primary, substr(a.created_at, 1, 10) AS since
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN merchants m ON m.id = t.merchant_id
     WHERE t.removed_at IS NULL AND t.pending = 0 AND t.parent_id IS NULL AND t.excluded = 0
       AND t.amount_cents < 0 AND (c.kind IS NULL OR c.kind = 'expense')
     ORDER BY t.posted_date, t.id`,
  );
  const recent = (c: ChargeRow) => c.posted_date >= (fixedSince ?? c.since);

  // Large, new merchant and fee: walk forward in time, knowing each merchant's past.
  const past = new Map<string, number[]>();
  for (const c of charges) {
    const earlier = past.get(c.merchant) ?? [];
    const size = -c.amount_cents;
    if (recent(c)) {
      const fee = c.category_id === "financial.fees" || c.plaid_pfc_primary === "BANK_FEES";
      if (fee) {
        out.push({
          key: `fee:${c.id}`,
          kind: "fee",
          transaction_id: c.id,
          series_id: null,
          connection_id: null,
          message: `${dollars(size)} on ${c.account_name}: ${c.description_raw}.`,
          data: { date: c.posted_date, amount_cents: c.amount_cents },
        });
      } else if (earlier.length === 0) {
        if (size >= largeNew) {
          out.push(alertFor(c, "large", `${dollars(size)} at ${c.label}, a merchant not seen before.`, { amount_cents: c.amount_cents }));
        } else if (size >= newMerchant) {
          out.push(alertFor(c, "new_merchant", `${c.label} charged ${dollars(size)} on ${c.posted_date}, the first charge from them.`, { amount_cents: c.amount_cents }));
        }
      } else if (earlier.length >= 3) {
        const sorted = [...earlier].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)]!;
        if (size > median * ALERT_DEFAULTS.largeMultiple && size >= newMerchant) {
          out.push(
            alertFor(c, "large", `${dollars(size)} at ${c.label}, over ${ALERT_DEFAULTS.largeMultiple} times its usual ${dollars(median)}.`, {
              amount_cents: c.amount_cents,
              median_cents: -median,
            }),
          );
        }
      }
    }
    earlier.push(size);
    past.set(c.merchant, earlier);
  }

  // Duplicates: same merchant, amount and account within a few days, unless that's the merchant's regular price.
  const seenAmount = new Map<string, ChargeRow[]>();
  for (const c of charges) {
    const key = `${c.merchant}\u0000${c.account_id}\u0000${c.amount_cents}`;
    const before = seenAmount.get(key) ?? [];
    const prior = before[before.length - 1];
    if (
      prior &&
      recent(c) &&
      addDays(prior.posted_date, ALERT_DEFAULTS.duplicateDays) >= c.posted_date &&
      before.length - 1 < ALERT_DEFAULTS.regularPriceCount
    ) {
      out.push(
        alertFor(c, "duplicate", `${c.label} charged ${dollars(c.amount_cents)} on ${prior.posted_date} and again on ${c.posted_date}, both on ${c.account_name}.`, {
          amount_cents: c.amount_cents,
          other_transaction_id: prior.id,
        }),
      );
    }
    before.push(c);
    seenAmount.set(key, before);
  }

  // Recurring: price increases, new subscriptions and missed charges.
  const sinceFor = new Map<string, string>();
  for (const a of await db.all<{ id: string; since: string }>("SELECT id, substr(created_at, 1, 10) AS since FROM accounts")) {
    sinceFor.set(a.id, fixedSince ?? a.since);
  }
  const series = await db.all<{
    id: string;
    label: string;
    account_id: string;
    cadence: Cadence;
    typical_amount_cents: number;
    previous_amount_cents: number | null;
    price_changed_on: string | null;
    next_expected_date: string;
    last_date: string;
    status: string;
    is_subscription: number;
  }>(
    `SELECT id, label, account_id, cadence, typical_amount_cents, previous_amount_cents, price_changed_on, next_expected_date,
       last_date, status, is_subscription
     FROM recurring_series WHERE status = 'active'`,
  );
  for (const s of series) {
    const since = sinceFor.get(s.account_id) ?? today;
    const charges3 = await db.all<{ id: string; posted_date: string }>(
      `SELECT t.id, t.posted_date FROM recurring_members m JOIN transactions t ON t.id = m.transaction_id
       WHERE m.series_id = ? ORDER BY t.posted_date, t.id`,
      [s.id],
    );
    if (
      s.previous_amount_cents !== null &&
      s.price_changed_on &&
      s.price_changed_on >= since &&
      -s.typical_amount_cents > -s.previous_amount_cents
    ) {
      const step = charges3.find((c) => c.posted_date === s.price_changed_on);
      out.push({
        key: `price_increase:${s.id}:${s.price_changed_on}`,
        kind: "price_increase",
        transaction_id: step?.id ?? null,
        series_id: s.id,
        connection_id: null,
        message: `${s.label} went up from ${dollars(s.previous_amount_cents)} to ${dollars(s.typical_amount_cents)} ${CADENCE_WORD[s.cadence]}.`,
        data: { from_cents: s.previous_amount_cents, to_cents: s.typical_amount_cents, date: s.price_changed_on },
      });
    }
    // A subscription becomes a series with its third charge; that's when it's new.
    const third = charges3[2];
    if (s.is_subscription && third && third.posted_date >= since) {
      out.push({
        key: `new_subscription:${s.id}`,
        kind: "new_subscription",
        transaction_id: third.id,
        series_id: s.id,
        connection_id: null,
        message: `${s.label}, ${dollars(s.typical_amount_cents)} ${CADENCE_WORD[s.cadence]} since ${charges3[0]!.posted_date}.`,
        data: { amount_cents: s.typical_amount_cents, cadence: s.cadence },
      });
    }
    const due = addDays(s.next_expected_date, graceDays(s.cadence));
    if (today > due && s.next_expected_date >= since) {
      out.push({
        key: `missed_recurring:${s.id}:${s.next_expected_date}`,
        kind: "missed_recurring",
        transaction_id: null,
        series_id: s.id,
        connection_id: null,
        message: `${s.label} usually charges ${dollars(s.typical_amount_cents)} ${CADENCE_WORD[s.cadence]} and was due ${s.next_expected_date}, but nothing has arrived. Cancelled, or a card change?`,
        data: { expected_date: s.next_expected_date, period_days: CADENCE_DAYS[s.cadence] },
      });
    }
  }

  // Connections that need Dan.
  const connections = await db.all<{ id: string; institution_name: string; status: string; last_error: string | null }>(
    "SELECT id, institution_name, status, last_error FROM connections WHERE source = 'plaid' AND status IN ('login_required', 'error')",
  );
  for (const c of connections) {
    out.push({
      key: `connection:${c.id}:${c.status}`,
      kind: "connection",
      transaction_id: null,
      series_id: null,
      connection_id: c.id,
      message:
        c.status === "login_required"
          ? `${c.institution_name} needs you to sign in again before it can sync.`
          : `${c.institution_name} failed to sync${c.last_error ? `: ${c.last_error}` : ""}.`,
      data: { status: c.status },
    });
  }
  return out;
}

function alertFor(c: ChargeRow, kind: AlertKind, message: string, data: Record<string, unknown>): Desired {
  return {
    key: `${kind}:${c.id}`,
    kind,
    transaction_id: c.id,
    series_id: null,
    connection_id: null,
    message,
    data: { date: c.posted_date, account: c.account_name, ...data },
  };
}

/**
 * Bring the stored alerts in line with the data: raise new ones, refresh the
 * wording of open ones, and take away open ones whose reason has gone.
 * Dismissed alerts are kept as they are. Returns how many are open.
 */
export async function refreshAlerts(deps: Pick<CoreDeps, "db" | "now" | "newId">): Promise<number> {
  const { db } = deps;
  const desired = await desiredAlerts(db, localDate(deps.now()));
  const stored = await db.all<{ id: string; key: string; dismissed_at: string | null; message: string }>(
    "SELECT id, key, dismissed_at, message FROM alerts WHERE key IS NOT NULL",
  );
  const byKey = new Map(stored.map((a) => [a.key, a]));
  const wanted = new Set<string>();
  const now = deps.now().toISOString();
  let open = 0;
  for (const d of desired) {
    if (wanted.has(d.key)) continue;
    wanted.add(d.key);
    const existing = byKey.get(d.key);
    if (!existing) {
      await db.run(
        `INSERT INTO alerts (id, kind, transaction_id, series_id, connection_id, message, data, created_at, key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [deps.newId(), d.kind, d.transaction_id, d.series_id, d.connection_id, d.message, JSON.stringify(d.data), now, d.key],
      );
      open++;
    } else if (!existing.dismissed_at) {
      if (existing.message !== d.message) {
        await db.run("UPDATE alerts SET message = ?, data = ? WHERE id = ?", [d.message, JSON.stringify(d.data), existing.id]);
      }
      open++;
    }
  }
  for (const a of stored) {
    if (!a.dismissed_at && !wanted.has(a.key)) await db.run("DELETE FROM alerts WHERE id = ?", [a.id]);
  }
  return open;
}

export interface AlertView {
  id: string;
  kind: AlertKind;
  message: string;
  created_at: string;
  dismissed_at: string | null;
  transaction_id: string | null;
  series_id: string | null;
  connection_id: string | null;
  /** The date of what the alert is about: the charge's date, or when a charge was due. */
  date: string | null;
  data: Record<string, unknown>;
}

export async function listAlerts(db: SqlDriver, opts: { includeDismissed?: boolean; limit?: number } = {}): Promise<AlertView[]> {
  const rows = await db.all<Omit<AlertView, "data" | "date"> & { data: string | null; tx_date: string | null }>(
    `SELECT al.id, al.kind, al.message, al.created_at, al.dismissed_at, al.transaction_id, al.series_id, al.connection_id,
       al.data, t.posted_date AS tx_date
     FROM alerts al LEFT JOIN transactions t ON t.id = al.transaction_id
     ${opts.includeDismissed ? "" : "WHERE al.dismissed_at IS NULL"}
     ORDER BY COALESCE(t.posted_date, substr(al.created_at, 1, 10)) DESC, al.created_at DESC, al.id
     LIMIT ?`,
    [Math.min(Math.max(opts.limit ?? 100, 1), 500)],
  );
  return rows.map(({ data, tx_date, ...r }) => {
    const parsed = data ? (JSON.parse(data) as Record<string, unknown>) : {};
    const expected = typeof parsed.expected_date === "string" ? parsed.expected_date : null;
    return { ...r, data: parsed, date: tx_date ?? expected ?? r.created_at.slice(0, 10) };
  });
}
