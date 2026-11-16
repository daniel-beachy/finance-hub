import { isGenericMerchant } from "../categorize/normalize.ts";
import { listRules } from "../categorize/rules.ts";
import { PLAID_SLOT_LIMIT } from "../connections.ts";
import type { SqlDriver } from "../db/driver.ts";
import { InvalidInput } from "../errors.ts";
import { IN_REVIEW_SQL, LABEL_SQL, listConnections, listSyncRuns } from "../queries.ts";
import { UNCATEGORIZED } from "../seed/categories.ts";

/**
 * Read models the MCP tools need beyond what the dashboard already has.
 * Conventions match `insights.ts`: pending, excluded, removed and split
 * originals are left out; spending is the net of expense-kind categories.
 */

const COUNTED = "t.removed_at IS NULL AND t.is_split_parent = 0 AND t.excluded = 0 AND t.pending = 0";

export type SummaryGroup = "category" | "group" | "merchant" | "month";
export type SummaryKind = "expense" | "income" | "all";

export interface SummaryRow {
  key: string;
  name: string;
  /** Signed: spending is negative, income positive. */
  total_cents: number;
  count: number;
}

export async function spendingSummary(
  db: SqlDriver,
  opts: { from: string; to: string; groupBy?: SummaryGroup; kind?: SummaryKind; limit?: number },
): Promise<{ from: string; to: string; group_by: SummaryGroup; kind: SummaryKind; total_cents: number; count: number; rows: SummaryRow[] }> {
  const groupBy = opts.groupBy ?? "category";
  const kind = opts.kind ?? "expense";
  const kinds = kind === "all" ? "('income', 'expense')" : kind === "income" ? "('income')" : "('expense')";
  const select: Record<SummaryGroup, [string, string]> = {
    category: ["c.id", "c.name"],
    group: ["g.id", "g.name"],
    merchant: [`COALESCE(m.normalized_key, ${LABEL_SQL})`, `COALESCE(m.name, ${LABEL_SQL})`],
    month: ["substr(t.posted_date, 1, 7)", "substr(t.posted_date, 1, 7)"],
  };
  const pick = select[groupBy];
  if (!pick) throw new InvalidInput("group_by must be category, group, merchant or month");
  const [key, name] = pick;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await db.all<SummaryRow>(
    `SELECT ${key} AS key, MIN(${name}) AS name, SUM(t.amount_cents) AS total_cents, COUNT(*) AS count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     JOIN category_groups g ON g.id = c.group_id
     LEFT JOIN merchants m ON m.id = t.merchant_id
     WHERE ${COUNTED} AND c.kind IN ${kinds} AND t.posted_date BETWEEN ? AND ?
     GROUP BY ${key}
     ORDER BY ${groupBy === "month" ? "key" : "ABS(SUM(t.amount_cents)) DESC, key"}
     LIMIT ?`,
    [opts.from, opts.to, limit],
  );
  const totals = await db.all<{ total: number | null; n: number }>(
    `SELECT SUM(t.amount_cents) AS total, COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE ${COUNTED} AND c.kind IN ${kinds} AND t.posted_date BETWEEN ? AND ?`,
    [opts.from, opts.to],
  );
  return {
    from: opts.from,
    to: opts.to,
    group_by: groupBy,
    kind,
    total_cents: totals[0]?.total ?? 0,
    count: totals[0]?.n ?? 0,
    rows,
  };
}

/** Latest positions per investment account, with totals by asset class and by tax treatment. */
export async function holdingsReport(db: SqlDriver) {
  const positions = await db.all<{
    account_id: string;
    account_name: string;
    tax_treatment: string;
    as_of: string;
    ticker: string | null;
    security_name: string | null;
    asset_class: string;
    quantity: number;
    price: number | null;
    value_cents: number;
    cost_basis_cents: number | null;
  }>(
    `SELECT h.account_id, a.name AS account_name, a.tax_treatment, h.as_of, s.ticker, s.name AS security_name,
       s.asset_class, h.quantity, h.price, h.value_cents, h.cost_basis_cents
     FROM holdings h
     JOIN accounts a ON a.id = h.account_id
     JOIN securities s ON s.id = h.security_id
     WHERE a.closed_at IS NULL AND h.as_of = (SELECT MAX(as_of) FROM holdings WHERE account_id = h.account_id)
     ORDER BY a.name, h.value_cents DESC`,
  );
  const total = positions.reduce((n, p) => n + p.value_cents, 0);
  const by = (field: "asset_class" | "tax_treatment") => {
    const sums = new Map<string, number>();
    for (const p of positions) sums.set(p[field], (sums.get(p[field]) ?? 0) + p.value_cents);
    return [...sums]
      .map(([key, value_cents]) => ({ key, value_cents, share: total ? Math.round((value_cents / total) * 1000) / 1000 : 0 }))
      .sort((a, b) => b.value_cents - a.value_cents);
  };
  return { total_cents: total, by_asset_class: by("asset_class"), by_tax_treatment: by("tax_treatment"), positions };
}

export async function syncStatus(db: SqlDriver) {
  const connections = (await listConnections(db)).map((c) => ({
    id: c.id,
    institution: c.institution_name,
    source: c.source,
    plaid_env: c.plaid_env,
    status: c.status,
    last_synced_at: c.last_synced_at,
    consent_expires_at: c.consent_expires_at,
    last_error: c.last_error,
    accounts: c.accounts.length,
  }));
  const slots = await db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM connections WHERE source = 'plaid' AND plaid_env = 'production'",
  );
  return {
    connections,
    plaid_production_connections: slots[0]?.n ?? 0,
    plaid_connection_limit: PLAID_SLOT_LIMIT,
    recent_runs: (await listSyncRuns(db, 12)).map((r) => ({
      started_at: r.started_at,
      institution: r.institution_name,
      trigger: r.trigger,
      status: r.status,
      added: r.added,
      modified: r.modified,
      removed: r.removed,
      error_code: r.error_code,
    })),
  };
}

// ---------------------------------------------------------------------------
// Review queue, grouped by merchant

export interface ReviewQueueOptions {
  /** Only transactions with this reason: uncategorized, large, unfamiliar, unusual, or flagged. */
  reason?: string;
  /** Most merchant groups to return. */
  limit?: number;
  /** Most transactions shown per group. */
  perMerchant?: number;
}

interface QueueRow {
  id: string;
  posted_date: string;
  amount_cents: number;
  description_raw: string;
  merchant_raw: string | null;
  account_name: string;
  account_type: string;
  category_id: string | null;
  category_name: string | null;
  category_source: string | null;
  plaid_pfc_detailed: string | null;
  plaid_pfc_confidence: string | null;
  review_reasons: string | null;
  flag: string | null;
  note: string | null;
  pending: number;
  merchant_id: string | null;
  merchant_key: string | null;
  merchant_name: string | null;
  merchant_default: string | null;
}

const REASONS = new Set(["uncategorized", "large", "unfamiliar", "unusual", "flagged"]);

/**
 * Everything in Review, grouped by merchant, with what Claude needs to
 * decide each group in one go: Plaid's guess and confidence, how this
 * merchant was categorized before, whether it varies, and any rule on it.
 */
export async function reviewQueue(db: SqlDriver, opts: ReviewQueueOptions = {}) {
  if (opts.reason !== undefined && !REASONS.has(opts.reason)) {
    throw new InvalidInput("reason must be uncategorized, large, unfamiliar, unusual or flagged");
  }
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const perMerchant = Math.min(Math.max(opts.perMerchant ?? 8, 1), 50);
  const reasonSql =
    opts.reason === undefined
      ? ""
      : opts.reason === "flagged"
        ? " AND t.flag IN ('suspicious', 'disputed')"
        : ` AND t.reviewed_at IS NULL AND t.review_reasons LIKE '%"${opts.reason}"%'`;
  const rows = await db.all<QueueRow>(
    `SELECT t.id, t.posted_date, t.amount_cents, t.description_raw, t.merchant_raw, a.name AS account_name,
       a.type AS account_type, t.category_id, c.name AS category_name, t.category_source, t.plaid_pfc_detailed,
       t.plaid_pfc_confidence, t.review_reasons, t.flag, t.note, t.pending, t.merchant_id,
       m.normalized_key AS merchant_key, m.name AS merchant_name, m.default_category_id AS merchant_default
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN merchants m ON m.id = t.merchant_id
     WHERE t.removed_at IS NULL AND t.is_split_parent = 0 AND ${IN_REVIEW_SQL}${reasonSql}
     ORDER BY t.posted_date DESC, t.id DESC`,
  );

  const groups = new Map<string, QueueRow[]>();
  for (const r of rows) {
    const key = r.merchant_id ?? `label:${r.merchant_raw ?? r.description_raw}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => b.length - a.length || sumAbs(b) - sumAbs(a) || a[0]!.id.localeCompare(b[0]!.id),
  );

  const categoryNames = new Map(
    (await db.all<{ id: string; name: string }>("SELECT id, name FROM categories")).map((c) => [c.id, c.name]),
  );
  const rules = await listRules(db);
  const out = [];
  for (const items of ordered.slice(0, limit)) {
    const head = items[0]!;
    const history = head.merchant_id
      ? await db.all<{ posted_date: string; amount_cents: number; category_id: string; category_name: string; category_source: string | null }>(
          `SELECT t.posted_date, t.amount_cents, t.category_id, c.name AS category_name, t.category_source
           FROM transactions t JOIN categories c ON c.id = t.category_id
           WHERE t.merchant_id = ? AND t.removed_at IS NULL AND t.is_split_parent = 0 AND t.category_id != ?
             AND NOT ${IN_REVIEW_SQL}
           ORDER BY t.posted_date DESC LIMIT 6`,
          [head.merchant_id, UNCATEGORIZED],
        )
      : [];
    const pastCategories = [...new Set(history.map((h) => h.category_id))];
    const plaid = new Map<string, number>();
    for (const r of items) {
      if (r.plaid_pfc_detailed) {
        const k = `${r.plaid_pfc_detailed} (${r.plaid_pfc_confidence ?? "no confidence"})`;
        plaid.set(k, (plaid.get(k) ?? 0) + 1);
      }
    }
    const reasons = new Set<string>();
    for (const r of items) {
      for (const why of r.review_reasons ? (JSON.parse(r.review_reasons) as string[]) : []) reasons.add(why);
      if (r.flag === "suspicious" || r.flag === "disputed") reasons.add("flagged");
    }
    const generic = head.merchant_key ? isGenericMerchant(head.merchant_key) : true;
    const rule = head.merchant_key
      ? rules.find((r) => r.match.merchant_key === head.merchant_key && Object.keys(r.match).length === 1)
      : undefined;
    out.push({
      merchant_key: head.merchant_key,
      merchant_name: head.merchant_name ?? head.merchant_raw ?? head.description_raw,
      count: items.length,
      total_cents: items.reduce((n, r) => n + r.amount_cents, 0),
      reasons: [...reasons].sort(),
      varies: generic || pastCategories.length > 1,
      plaid_categories: [...plaid].map(([category, count]) => ({ category, count })),
      merchant_default_category: head.merchant_default
        ? { id: head.merchant_default, name: categoryNames.get(head.merchant_default) ?? head.merchant_default }
        : null,
      existing_rule: rule
        ? { id: rule.id, enabled: rule.enabled, category_id: rule.actions.category_id, category_name: categoryNames.get(rule.actions.category_id) ?? null }
        : null,
      past_charges: history.map((h) => ({
        date: h.posted_date,
        amount_cents: h.amount_cents,
        category_id: h.category_id,
        category: h.category_name,
        set_by: h.category_source,
      })),
      suggested_category_id: !generic && pastCategories.length === 1 ? pastCategories[0]! : null,
      transactions: items.slice(0, perMerchant).map((r) => ({
        id: r.id,
        date: r.posted_date,
        amount_cents: r.amount_cents,
        description: r.description_raw,
        account: `${r.account_name} (${r.account_type})`,
        category_id: r.category_id,
        category: r.category_name,
        set_by: r.category_source,
        reasons: r.review_reasons ? (JSON.parse(r.review_reasons) as string[]) : [],
        flag: r.flag,
        note: r.note,
        pending: r.pending === 1,
      })),
      more_transactions: Math.max(items.length - perMerchant, 0),
    });
  }
  const byReason: Record<string, number> = {};
  for (const r of rows) {
    for (const why of r.review_reasons ? (JSON.parse(r.review_reasons) as string[]) : []) byReason[why] = (byReason[why] ?? 0) + 1;
    if (r.flag === "suspicious" || r.flag === "disputed") byReason.flagged = (byReason.flagged ?? 0) + 1;
  }
  return {
    total_transactions: rows.length,
    total_merchants: groups.size,
    by_reason: byReason,
    merchants: out,
    more_merchants: Math.max(groups.size - limit, 0),
  };
}

const sumAbs = (rows: QueueRow[]) => rows.reduce((n, r) => n + Math.abs(r.amount_cents), 0);

// ---------------------------------------------------------------------------
// Automatic review runs

export interface ReviewRun {
  id: string;
  started_at: string;
  finished_at: string;
  trigger: "schedule" | "manual";
  queue_before: number | null;
  queue_after: number;
  categorized: number;
  reviewed: number;
  flagged: number;
  rules_created: number;
  batch_ids: string[];
  summary: string | null;
}

/**
 * Close out a categorizing run by Claude. The counts come from the `changes`
 * log (everything Claude did since `startedAt` and hasn't been undone), not
 * from Claude's own tally, so they can be trusted for the eight-week numbers.
 */
export async function recordReviewRun(
  deps: { db: SqlDriver; now: () => Date; newId: () => string },
  input: { startedAt: string; trigger?: "schedule" | "manual"; queueBefore?: number | null; summary?: string | null },
): Promise<ReviewRun> {
  const { db } = deps;
  if (Number.isNaN(Date.parse(input.startedAt))) throw new InvalidInput("started_at must be an ISO timestamp");
  // Same shape as `changes.at`, so the text comparison below is a time comparison.
  const startedAt = new Date(input.startedAt).toISOString();
  const finished = deps.now().toISOString();
  if (startedAt > finished) throw new InvalidInput("started_at is in the future");
  const rows = await db.all<{ entity: string; entity_id: string; before: string | null; after: string | null; batch_id: string | null }>(
    `SELECT entity, entity_id, before, after, batch_id FROM changes
     WHERE actor = 'claude' AND at >= ? AND undone_at IS NULL ORDER BY rowid`,
    [startedAt],
  );
  const categorized = new Set<string>();
  const reviewed = new Set<string>();
  const flagged = new Set<string>();
  let rulesCreated = 0;
  const batches = new Set<string>();
  for (const r of rows) {
    if (r.batch_id) batches.add(r.batch_id);
    const before = r.before ? JSON.parse(r.before) : null;
    const after = r.after ? JSON.parse(r.after) : null;
    if (r.entity === "rule" && before === null && after) rulesCreated++;
    if (r.entity !== "transaction" || !before || !after) continue;
    if (after.category_id !== before.category_id && after.category_id !== UNCATEGORIZED) categorized.add(r.entity_id);
    if (after.reviewed_at && !before.reviewed_at) reviewed.add(r.entity_id);
    if ((after.flag === "suspicious" || after.flag === "disputed") && before.flag !== after.flag) flagged.add(r.entity_id);
  }
  const queue = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM transactions t WHERE t.removed_at IS NULL AND t.is_split_parent = 0 AND ${IN_REVIEW_SQL}`,
  );
  const summary = input.summary?.trim().slice(0, 4000) || null;
  const run: ReviewRun = {
    id: deps.newId(),
    started_at: startedAt,
    finished_at: finished,
    trigger: input.trigger ?? "schedule",
    queue_before: input.queueBefore ?? null,
    queue_after: queue[0]?.n ?? 0,
    categorized: categorized.size,
    reviewed: reviewed.size,
    flagged: flagged.size,
    rules_created: rulesCreated,
    batch_ids: [...batches],
    summary,
  };
  await db.run(
    `INSERT INTO review_runs (id, started_at, finished_at, trigger, queue_before, queue_after, categorized, reviewed, flagged,
       rules_created, batch_ids, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.started_at,
      run.finished_at,
      run.trigger,
      run.queue_before,
      run.queue_after,
      run.categorized,
      run.reviewed,
      run.flagged,
      run.rules_created,
      JSON.stringify(run.batch_ids),
      run.summary,
    ],
  );
  return run;
}

export async function listReviewRuns(db: SqlDriver, limit = 20): Promise<ReviewRun[]> {
  const rows = await db.all<Omit<ReviewRun, "batch_ids"> & { batch_ids: string }>(
    "SELECT * FROM review_runs ORDER BY started_at DESC LIMIT ?",
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({ ...r, batch_ids: JSON.parse(r.batch_ids) as string[] }));
}
