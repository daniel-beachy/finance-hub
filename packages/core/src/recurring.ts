import { first, type SqlDriver } from "./db/driver.ts";
import type { CoreDeps } from "./deps.ts";
import { localDate } from "./deps.ts";
import { LABEL_SQL } from "./queries.ts";
import { addDays } from "./util/money.ts";

/**
 * Recurring charges (docs/PLAN.md M6). A series is three or more charges from
 * one merchant on one account at a steady cadence: every gap within 20% of a
 * week, two weeks, a month, a quarter or a year, and each amount within 15%
 * of the one before. Two refinements keep it honest on real data: a merchant
 * that also sells other things only forms a series from charges of exactly
 * the same amount (four of them), and a merchant whose every charge keeps the
 * cadence is a series even when the amount varies, like a utility bill (also
 * four of them). Detection runs inside
 * `settle`, after categorizing, so the series always match the current data.
 *
 * Only money out counts, and never transfers, card payments or investment
 * moves. A split original stands for the whole charge; its parts are left
 * out. Pending and excluded rows are left out.
 */

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
export type SeriesStatus = "active" | "ended" | "ignored";

/** The length of each cadence in days. */
export const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30.44,
  quarterly: 91.31,
  yearly: 365.25,
};
const CADENCES = Object.keys(CADENCE_DAYS) as Cadence[];

export const RECURRING_RULES = {
  minCharges: 3,
  /** Each gap may differ from the cadence by this share of it. */
  gapTolerance: 0.2,
  /** Each amount may differ from the previous one by this share. */
  amountTolerance: 0.15,
  /** A merchant whose every charge keeps the cadence is a bill even when the amount varies, up to this ratio. */
  billSpread: 3,
} as const;

/** Categories whose recurring charges are subscriptions rather than bills. */
export const SUBSCRIPTION_CATEGORIES: ReadonlySet<string> = new Set([
  "entertainment.streaming",
  "entertainment.games",
  "entertainment.media",
  "software.subscriptions",
  "software.cloud-ai",
  "health.fitness",
]);

/** One charge as detection sees it. `cents` is negative (money out). */
export interface Charge {
  id: string;
  account_id: string;
  /** What groups charges into one merchant: the merchant id, else the label. */
  merchant: string;
  merchant_id: string | null;
  label: string;
  date: string;
  cents: number;
  category_id: string | null;
}

export interface DetectedSeries {
  merchant_id: string | null;
  account_id: string;
  label: string;
  cadence: Cadence;
  /** The charges that make up the series, oldest first. */
  charges: Charge[];
  first_date: string;
  last_date: string;
  /** The latest charge's amount, negative. */
  amount_cents: number;
  /** The amount before the latest change in price, when the price stepped from a steady amount. */
  previous_amount_cents: number | null;
  price_changed_on: string | null;
  /** The charge that set the latest price, when there was a step. */
  price_change_transaction_id: string | null;
  category_id: string | null;
  next_expected_date: string;
}

const days = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** A date plus whole months, the day held where the month allows. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** When the next charge of a series is due after one on `date`. */
export function nextDate(date: string, cadence: Cadence): string {
  switch (cadence) {
    case "weekly":
      return addDays(date, 7);
    case "biweekly":
      return addDays(date, 14);
    case "monthly":
      return addMonths(date, 1);
    case "quarterly":
      return addMonths(date, 3);
    case "yearly":
      return addMonths(date, 12);
  }
}

/** How many days late a charge can be before it counts as missed. */
export function graceDays(cadence: Cadence): number {
  return Math.max(3, Math.round(CADENCE_DAYS[cadence] * RECURRING_RULES.gapTolerance));
}

/**
 * The latest run of charges at cadence `c`, oldest first. Every gap must fit
 * the cadence: a charge too soon after the one before means these aren't one
 * series. A gap too long ends a run (a missed stretch, or a restart), and the
 * latest run with enough charges counts.
 */
function runAt(charges: Charge[], c: Cadence): Charge[] | null {
  const period = CADENCE_DAYS[c];
  const lo = period * (1 - RECURRING_RULES.gapTolerance);
  const hi = period * (1 + RECURRING_RULES.gapTolerance);
  const runs: Charge[][] = [];
  let run = [charges[0]!];
  for (const charge of charges.slice(1)) {
    const gap = days(run[run.length - 1]!.date, charge.date);
    if (gap < lo) return null;
    if (gap <= hi) run.push(charge);
    else {
      runs.push(run);
      run = [charge];
    }
  }
  runs.push(run);
  const good = runs.filter((r) => r.length >= RECURRING_RULES.minCharges);
  return good.length ? good[good.length - 1]! : null;
}

/** The cadence that fits a list of charges (oldest first), or null. */
function bestRun(charges: Charge[]): { cadence: Cadence; kept: Charge[] } | null {
  if (charges.length < RECURRING_RULES.minCharges) return null;
  let best: { cadence: Cadence; kept: Charge[] } | null = null;
  for (const c of CADENCES) {
    const kept = runAt(charges, c);
    if (kept && (!best || kept.length > best.kept.length)) best = { cadence: c, kept };
  }
  return best;
}

const byDate = (a: Charge, b: Charge): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);

/** Each amount within 15% of the one before. */
function closeAmounts(run: Charge[]): boolean {
  return run.every((c, i) => i === 0 || Math.abs(c.cents - run[i - 1]!.cents) <= Math.abs(run[i - 1]!.cents) * RECURRING_RULES.amountTolerance);
}

/** A bill that varies (electricity, water), within a factor of three. */
function spreadOk(run: Charge[]): boolean {
  const sizes = run.map((c) => -c.cents);
  return Math.max(...sizes) <= Math.min(...sizes) * RECURRING_RULES.billSpread;
}

/**
 * The series in one merchant's charges on one account (oldest first).
 *
 * First, all of them: when every charge keeps one cadence, that's the series,
 * even if the amount varies like a utility bill (then it takes four charges,
 * not three). Otherwise the merchant also
 * sells other things (a store with a membership, an app store), so only
 * charges of exactly the same amount can form a series, and two such groups
 * that follow each other in time are one series whose price changed.
 */
function seriesIn(charges: Charge[]): { cadence: Cadence; kept: Charge[] }[] {
  const whole = bestRun(charges);
  if (whole && whole.kept.length === charges.length) {
    const close = closeAmounts(whole.kept);
    // Varying amounts need a fourth charge: three fill-ups two weeks apart are chance, not a bill.
    if (close || (spreadOk(whole.kept) && whole.kept.length > RECURRING_RULES.minCharges)) return [whole];
  }

  const exact = new Map<number, Charge[]>();
  for (const c of charges) exact.set(c.cents, [...(exact.get(c.cents) ?? []), c]);
  let groups = [...exact.values()];
  if (groups.length <= 60) {
    let merged = true;
    while (merged) {
      merged = false;
      groups.sort((a, b) => byDate(a[0]!, b[0]!));
      outer: for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const a = groups[i]!;
          const b = groups[j]!;
          if (a[a.length - 1]!.date >= b[0]!.date) continue;
          const together = bestRun([...a, ...b]);
          const alone = Math.max(bestRun(a)?.kept.length ?? 0, bestRun(b)?.kept.length ?? 0);
          if (together && together.kept.length > alone && together.kept.some((c) => a.includes(c)) && together.kept.some((c) => b.includes(c))) {
            groups = groups.filter((_, k) => k !== i && k !== j);
            groups.push([...a, ...b]);
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  // When this merchant also charges other amounts, a few equal charges could
  // be chance (a vending machine): one more charge than usual is needed.
  const needed = exact.size > 1 ? RECURRING_RULES.minCharges + 1 : RECURRING_RULES.minCharges;
  const out: { cadence: Cadence; kept: Charge[] }[] = [];
  for (const g of groups) {
    const run = bestRun(g);
    if (run && run.kept.length >= needed) out.push(run);
  }
  return out;
}

const mode = (values: (string | null)[]): string | null => {
  const counts = new Map<string | null, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
};

/** Every recurring series in a set of charges. Pure: the tests call it directly. */
export function detectSeries(charges: Charge[]): DetectedSeries[] {
  const byKey = new Map<string, Charge[]>();
  for (const c of [...charges].sort(byDate)) {
    if (c.cents >= 0) continue;
    const key = `${c.merchant}\u0000${c.account_id}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }
  const out: DetectedSeries[] = [];
  for (const list of byKey.values()) {
    for (const { cadence, kept } of seriesIn(list)) {
      const last = kept[kept.length - 1]!;
      // The latest step in price from a steady amount (two equal charges before it).
      let step: { from: number; on: string; id: string } | null = null;
      for (let i = 2; i < kept.length; i++) {
        const [a, b, c] = [kept[i - 2]!.cents, kept[i - 1]!.cents, kept[i]!.cents];
        if (a === b && c !== b) step = { from: b, on: kept[i]!.date, id: kept[i]!.id };
      }
      out.push({
        merchant_id: last.merchant_id,
        account_id: last.account_id,
        label: last.label,
        cadence,
        charges: kept,
        first_date: kept[0]!.date,
        last_date: last.date,
        amount_cents: last.cents,
        previous_amount_cents: step?.from ?? null,
        price_changed_on: step?.on ?? null,
        price_change_transaction_id: step?.id ?? null,
        category_id: mode(kept.map((c) => c.category_id)),
        next_expected_date: nextDate(last.date, cadence),
      });
    }
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.account_id < b.account_id ? -1 : 1));
}

/** The status detection gives a series on `today`: ended once a whole cadence has passed with no charge. */
export function detectedStatus(cadence: Cadence, nextExpected: string, today: string): "active" | "ended" {
  const limit = addDays(nextExpected, Math.round(CADENCE_DAYS[cadence]) + graceDays(cadence));
  return today > limit ? "ended" : "active";
}

/** Charges detection looks at: money out that isn't a transfer, as the bank sent it. */
export async function loadCharges(db: SqlDriver): Promise<Charge[]> {
  return db.all<Charge>(
    `SELECT t.id, t.account_id, COALESCE(t.merchant_id, ${LABEL_SQL}) AS merchant, t.merchant_id,
       COALESCE(m.name, ${LABEL_SQL}) AS label, t.posted_date AS date, t.amount_cents AS cents, t.category_id
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN merchants m ON m.id = t.merchant_id
     WHERE t.removed_at IS NULL AND t.pending = 0 AND t.parent_id IS NULL AND t.excluded = 0
       AND t.amount_cents < 0 AND (c.kind IS NULL OR c.kind IN ('expense'))
     ORDER BY t.posted_date, t.id`,
  );
}

interface StoredSeries {
  id: string;
  account_id: string | null;
  status: SeriesStatus;
  status_set_by: string | null;
  is_subscription: number;
  subscription_set_by: string | null;
}

/**
 * Detect series and store them. A stored series keeps its id (and anything a
 * person set on it) when detection finds it again, judged by shared charges.
 * A series no longer found is deleted, unless a person set its status or
 * subscription mark: then it stays, so their choice still applies if it
 * comes back. Returns how many series are stored.
 */
export async function refreshRecurring(deps: Pick<CoreDeps, "db" | "now" | "newId">): Promise<number> {
  const { db } = deps;
  const today = localDate(deps.now());
  const detected = detectSeries(await loadCharges(db));
  const stored = await db.all<StoredSeries>(
    "SELECT id, account_id, status, status_set_by, is_subscription, subscription_set_by FROM recurring_series",
  );
  const members = await db.all<{ series_id: string; transaction_id: string }>("SELECT series_id, transaction_id FROM recurring_members");
  const seriesOf = new Map<string, string>();
  for (const m of members) seriesOf.set(m.transaction_id, m.series_id);
  const byId = new Map(stored.map((s) => [s.id, s]));
  const claimed = new Set<string>();

  for (const d of detected) {
    // The stored series sharing the most charges with this one.
    const votes = new Map<string, number>();
    for (const c of d.charges) {
      const id = seriesOf.get(c.id);
      if (id && !claimed.has(id)) votes.set(id, (votes.get(id) ?? 0) + 1);
    }
    let match: StoredSeries | undefined;
    let most = 0;
    for (const [id, n] of votes) {
      if (n > most) [match, most] = [byId.get(id), n];
    }
    const status = match?.status_set_by ? match.status : detectedStatus(d.cadence, d.next_expected_date, today);
    const subscription = match?.subscription_set_by
      ? match.is_subscription
      : d.category_id && SUBSCRIPTION_CATEGORIES.has(d.category_id)
        ? 1
        : 0;
    const values = [
      d.merchant_id,
      d.account_id,
      d.cadence,
      d.amount_cents,
      d.last_date,
      d.next_expected_date,
      status,
      subscription,
      d.category_id,
      d.label,
      d.first_date,
      d.charges.length,
      d.previous_amount_cents,
      d.price_changed_on,
    ];
    let id: string;
    if (match) {
      id = match.id;
      claimed.add(id);
      await db.run(
        `UPDATE recurring_series SET merchant_id = ?, account_id = ?, cadence = ?, typical_amount_cents = ?, last_date = ?,
           next_expected_date = ?, status = ?, is_subscription = ?, category_id = ?, label = ?, first_date = ?,
           charge_count = ?, previous_amount_cents = ?, price_changed_on = ?
         WHERE id = ?`,
        [...values, id],
      );
      await db.run("DELETE FROM recurring_members WHERE series_id = ?", [id]);
    } else {
      id = deps.newId();
      claimed.add(id);
      await db.run(
        `INSERT INTO recurring_series (merchant_id, account_id, cadence, typical_amount_cents, last_date, next_expected_date,
           status, is_subscription, category_id, label, first_date, charge_count, previous_amount_cents, price_changed_on,
           id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, id, deps.now().toISOString()],
      );
    }
    for (const c of d.charges) {
      await db.run("INSERT OR IGNORE INTO recurring_members (series_id, transaction_id) VALUES (?, ?)", [id, c.id]);
    }
  }

  for (const s of stored) {
    if (claimed.has(s.id) || s.status_set_by || s.subscription_set_by) continue;
    await db.run("UPDATE alerts SET series_id = NULL WHERE series_id = ?", [s.id]);
    await db.run("DELETE FROM recurring_series WHERE id = ?", [s.id]);
  }
  const n = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM recurring_series");
  return n?.n ?? 0;
}

export interface RecurringView {
  id: string;
  label: string;
  merchant_id: string | null;
  account_id: string | null;
  account_name: string | null;
  account_mask: string | null;
  cadence: Cadence;
  /** The latest charge, negative. */
  amount_cents: number;
  previous_amount_cents: number | null;
  price_changed_on: string | null;
  first_date: string | null;
  last_date: string | null;
  next_expected_date: string | null;
  status: SeriesStatus;
  status_set_by: string | null;
  is_subscription: number;
  category_id: string | null;
  category_name: string | null;
  charge_count: number;
  /** The amount scaled to a year, negative. */
  yearly_cents: number;
  /** Whether the next charge is overdue by more than the grace days. */
  late: boolean;
}

const PER_YEAR: Record<Cadence, number> = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, yearly: 1 };

export async function listRecurring(db: SqlDriver, today: string): Promise<RecurringView[]> {
  const rows = await db.all<Omit<RecurringView, "yearly_cents" | "late" | "amount_cents"> & { typical_amount_cents: number }>(
    `SELECT s.id, s.label, s.merchant_id, s.account_id, a.name AS account_name, a.mask AS account_mask, s.cadence,
       s.typical_amount_cents, s.previous_amount_cents, s.price_changed_on, s.first_date, s.last_date, s.next_expected_date,
       s.status, s.status_set_by, s.is_subscription, s.category_id, c.name AS category_name, s.charge_count
     FROM recurring_series s
     LEFT JOIN accounts a ON a.id = s.account_id
     LEFT JOIN categories c ON c.id = s.category_id
     ORDER BY s.status = 'active' DESC, s.next_expected_date, s.label`,
  );
  return rows.map(({ typical_amount_cents, ...r }) => ({
    ...r,
    amount_cents: typical_amount_cents,
    yearly_cents: typical_amount_cents * PER_YEAR[r.cadence],
    late: r.status === "active" && !!r.next_expected_date && today > addDays(r.next_expected_date, graceDays(r.cadence)),
  }));
}

export interface UpcomingCharge {
  series_id: string;
  label: string;
  date: string;
  amount_cents: number;
  account_name: string | null;
  is_subscription: number;
  /** The charge is overdue; it's listed as due today. */
  late: boolean;
}

/** Charges expected from active series in the next `within` days, today included. */
export function upcomingCharges(series: RecurringView[], today: string, within = 14): UpcomingCharge[] {
  const end = addDays(today, within);
  const out: UpcomingCharge[] = [];
  for (const s of series) {
    if (s.status !== "active" || !s.next_expected_date) continue;
    // A late charge is still expected; show it as due today.
    let date = s.next_expected_date < today ? today : s.next_expected_date;
    let n = 0;
    while (date <= end && n < 5) {
      out.push({
        series_id: s.id,
        label: s.label,
        date,
        amount_cents: s.amount_cents,
        account_name: s.account_name,
        is_subscription: s.is_subscription,
        late: n === 0 && s.next_expected_date < today,
      });
      date = nextDate(date, s.cadence);
      n++;
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label < b.label ? -1 : 1));
}

/** The charges in one series, newest first. */
export async function seriesCharges(db: SqlDriver, seriesId: string): Promise<{ id: string; posted_date: string; amount_cents: number }[]> {
  return db.all(
    `SELECT t.id, t.posted_date, t.amount_cents FROM recurring_members m JOIN transactions t ON t.id = m.transaction_id
     WHERE m.series_id = ? ORDER BY t.posted_date DESC, t.id DESC`,
    [seriesId],
  );
}
