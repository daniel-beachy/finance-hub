import type { SqlDriver } from "../db/driver.ts";
import type { CoreDeps } from "../deps.ts";
import { refreshAlerts } from "../alerts.ts";
import { refreshRecurring } from "../recurring.ts";
import { refreshReviewQueue } from "../review.ts";
import { UNCATEGORIZED } from "../seed/categories.ts";
import { normalizeMerchant } from "./normalize.ts";
import { type CompiledRule, compileRule, listRules, type Rule } from "./rules.ts";

/**
 * The categorizer (docs/PLAN.md section 6).
 *
 * `settle` brings every transaction that no person or Claude has categorized
 * to the state the current rules, merchant memory and transfer pairs imply.
 * It always looks at everything and writes only what differs, so it is safe
 * to call after any change: a sync, an import, a new rule, a hand edit, an
 * undo. Nothing it writes is logged to `changes`, because all of it can be
 * worked out again from the things that are.
 *
 * For each transaction, the first step that applies decides:
 *   1. locked   a person or Claude set the category: never touched
 *   2. transfer one side of a matched pair, or an unmistakable card payment
 *   3. rule     the first enabled rule that matches
 *   4. memory   the merchant's default category
 *   5. plaid    Plaid's category, when Plaid is confident
 *   6. queue    Uncategorized, waiting in Review
 */

export type TransferKind = "internal_transfer" | "card_payment" | "investment_contribution";

export const TRANSFER_CATEGORY: Record<TransferKind, string> = {
  internal_transfer: "transfers.internal",
  card_payment: "transfers.card-payment",
  investment_contribution: "transfers.investment",
};

/** Two sides of one movement post at most this many days apart. */
export const TRANSFER_WINDOW_DAYS = 4;

const TRANSFER_PRIMARIES = new Set(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"]);
/** For rows with no Plaid category (file imports): the description has to say so. */
const TRANSFER_WORDS = /\b(TRANSFER|XFER|PAYMENT|PYMT|PMT|AUTOPAY|DIRECTPAY|DEPOSIT|WITHDRAWAL|CONTRIB\w*|ACH|EFT)\b/i;
const NOT_TRANSFER_WORDS = /\b(INTEREST|DIVIDEND|PAYROLL|REFUND|REWARDS?|CASH ?BACK|FEE)\b/i;
/** Money arriving on a credit card that is a payment, not a refund or a reward. */
const CARD_PAYMENT_WORDS = /\b(PAYMENT|PYMT|PMT|AUTOPAY|DIRECTPAY)\b/i;
const CARD_CREDIT_WORDS = /\b(REFUND|REWARDS?|CASH ?BACK|REDEMPTION|REDEEMED|ADJUST\w*|STATEMENT CREDIT|RETURN)\b/i;

export interface PipelineRow {
  id: string;
  account_id: string;
  account_type: string;
  posted_date: string;
  amount_cents: number;
  description_raw: string;
  pending: number;
  category_id: string | null;
  category_source: string | null;
  rule_id: string | null;
  needs_review: number;
  plaid_pfc_primary: string | null;
  plaid_pfc_detailed: string | null;
  plaid_pfc_confidence: string | null;
  transfer_group_id: string | null;
  group_kind: TransferKind | null;
  merchant_key: string | null;
  merchant_default: string | null;
}

export interface Decision {
  category_id: string;
  category_source: "transfer" | "rule" | "memory" | "plaid" | null;
  rule_id: string | null;
  needs_review: 0 | 1;
}

export const isLocked = (source: string | null): boolean => source === "manual" || source === "claude";

/** Could this row be one side of a movement between Dan's own accounts? */
export function transferLike(t: Pick<PipelineRow, "plaid_pfc_primary" | "description_raw">): boolean {
  if (t.plaid_pfc_primary) return TRANSFER_PRIMARIES.has(t.plaid_pfc_primary);
  return TRANSFER_WORDS.test(t.description_raw) && !NOT_TRANSFER_WORDS.test(t.description_raw);
}

/** A card payment even with no other side in view (the paying account isn't tracked, or is out of history). */
function loneCardPayment(t: PipelineRow): boolean {
  if (t.plaid_pfc_detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return true;
  return (
    t.account_type === "credit" &&
    t.amount_cents > 0 &&
    CARD_PAYMENT_WORDS.test(t.description_raw) &&
    !CARD_CREDIT_WORDS.test(t.description_raw)
  );
}

export interface PipelineContext {
  rules: CompiledRule[];
  plaidMap: Map<string, string>;
}

/** Steps 2 to 6 for one unlocked transaction. Pure. */
export function decide(t: PipelineRow, ctx: PipelineContext): Decision {
  if (t.transfer_group_id && t.group_kind) {
    return { category_id: TRANSFER_CATEGORY[t.group_kind], category_source: "transfer", rule_id: null, needs_review: 0 };
  }
  if (loneCardPayment(t)) {
    return { category_id: TRANSFER_CATEGORY.card_payment, category_source: "transfer", rule_id: null, needs_review: 0 };
  }
  for (const r of ctx.rules) {
    if (r.test(t)) {
      return { category_id: r.rule.actions.category_id, category_source: "rule", rule_id: r.rule.id, needs_review: 0 };
    }
  }
  if (t.merchant_default) {
    return { category_id: t.merchant_default, category_source: "memory", rule_id: null, needs_review: 0 };
  }
  if (t.plaid_pfc_confidence === "VERY_HIGH" || t.plaid_pfc_confidence === "HIGH") {
    const mapped =
      (t.plaid_pfc_detailed && ctx.plaidMap.get(t.plaid_pfc_detailed)) ||
      // "Some kind of transfer" is too vague to file money under on its own.
      (t.plaid_pfc_primary && !t.plaid_pfc_primary.startsWith("TRANSFER_") && ctx.plaidMap.get(t.plaid_pfc_primary));
    if (mapped && mapped !== UNCATEGORIZED) {
      return { category_id: mapped, category_source: "plaid", rule_id: null, needs_review: 0 };
    }
  }
  return { category_id: UNCATEGORIZED, category_source: null, rule_id: null, needs_review: 1 };
}

const differs = (t: PipelineRow, d: Decision): boolean =>
  t.category_id !== d.category_id ||
  t.category_source !== d.category_source ||
  t.rule_id !== d.rule_id ||
  t.needs_review !== d.needs_review;

async function loadRows(db: SqlDriver): Promise<PipelineRow[]> {
  return db.all<PipelineRow>(
    `SELECT t.id, t.account_id, a.type AS account_type, t.posted_date, t.amount_cents, t.description_raw, t.pending,
       t.category_id, t.category_source, t.rule_id, t.needs_review, t.plaid_pfc_primary, t.plaid_pfc_detailed,
       t.plaid_pfc_confidence, t.transfer_group_id, g.kind AS group_kind,
       m.normalized_key AS merchant_key, m.default_category_id AS merchant_default
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN merchants m ON m.id = t.merchant_id
     LEFT JOIN transfer_groups g ON g.id = t.transfer_group_id
     WHERE t.removed_at IS NULL AND t.is_split_parent = 0 AND t.parent_id IS NULL
     ORDER BY t.posted_date, t.id`,
  );
}

async function loadContext(db: SqlDriver, rules?: Rule[]): Promise<PipelineContext> {
  const all = rules ?? (await listRules(db));
  const map = await db.all<{ pfc_key: string; category_id: string }>("SELECT pfc_key, category_id FROM plaid_category_map");
  return {
    rules: all.filter((r) => r.enabled).map(compileRule),
    plaidMap: new Map(map.map((r) => [r.pfc_key, r.category_id])),
  };
}

/** Give every transaction its merchant, creating merchants as they first appear. */
async function ensureMerchants(deps: Pick<CoreDeps, "db" | "newId">): Promise<number> {
  const { db } = deps;
  const rows = await db.all<{ id: string; description_raw: string; merchant_raw: string | null }>(
    "SELECT id, description_raw, merchant_raw FROM transactions WHERE merchant_id IS NULL AND removed_at IS NULL",
  );
  if (rows.length === 0) return 0;
  const known = new Map(
    (await db.all<{ id: string; normalized_key: string }>("SELECT id, normalized_key FROM merchants")).map((m) => [
      m.normalized_key,
      m.id,
    ]),
  );
  let created = 0;
  for (const row of rows) {
    const { key, name } = normalizeMerchant(row.merchant_raw, row.description_raw);
    let id = known.get(key);
    if (!id) {
      id = deps.newId();
      await db.run("INSERT INTO merchants (id, name, normalized_key) VALUES (?, ?, ?)", [id, name, key]);
      known.set(key, id);
      created++;
    }
    await db.run("UPDATE transactions SET merchant_id = ? WHERE id = ?", [id, row.id]);
  }
  return created;
}

const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

export function transferKind(a: string, b: string): TransferKind {
  if (a === "credit" || b === "credit") return "card_payment";
  if (a === "investment" || b === "investment") return "investment_contribution";
  return "internal_transfer";
}

/**
 * Pair equal and opposite amounts in different accounts, at most
 * TRANSFER_WINDOW_DAYS apart. Both sides must look like a transfer, so a
 * purchase and an unrelated refund of the same amount are never paired.
 * Closest dates win; ties go to the earlier pair. Pure.
 */
export function matchTransfers(rows: PipelineRow[]): { out: PipelineRow; in: PipelineRow; kind: TransferKind }[] {
  const candidates = rows.filter(
    (t) => !t.pending && !t.transfer_group_id && !isLocked(t.category_source) && t.amount_cents !== 0 && transferLike(t),
  );
  const arriving = new Map<number, PipelineRow[]>();
  for (const t of candidates) {
    if (t.amount_cents > 0) arriving.set(t.amount_cents, [...(arriving.get(t.amount_cents) ?? []), t]);
  }
  const options: { out: PipelineRow; in: PipelineRow; gap: number }[] = [];
  for (const out of candidates) {
    if (out.amount_cents >= 0) continue;
    for (const into of arriving.get(-out.amount_cents) ?? []) {
      if (into.account_id === out.account_id) continue;
      const gap = Math.abs(dayNumber(into.posted_date) - dayNumber(out.posted_date));
      if (gap <= TRANSFER_WINDOW_DAYS) options.push({ out, in: into, gap });
    }
  }
  options.sort(
    (a, b) =>
      a.gap - b.gap ||
      a.out.posted_date.localeCompare(b.out.posted_date) ||
      a.out.id.localeCompare(b.out.id) ||
      a.in.id.localeCompare(b.in.id),
  );
  const used = new Set<string>();
  const pairs: { out: PipelineRow; in: PipelineRow; kind: TransferKind }[] = [];
  for (const o of options) {
    if (used.has(o.out.id) || used.has(o.in.id)) continue;
    used.add(o.out.id);
    used.add(o.in.id);
    pairs.push({ out: o.out, in: o.in, kind: transferKind(o.out.account_type, o.in.account_type) });
  }
  return pairs;
}

/**
 * Drop automatic pairs that no longer hold: a side was removed, or Plaid
 * changed an amount. A pair a person made by hand is left alone.
 */
async function dissolveBrokenPairs(db: SqlDriver): Promise<number> {
  const members = await db.all<{
    transfer_group_id: string;
    amount_cents: number;
    removed_at: string | null;
    category_source: string | null;
  }>("SELECT transfer_group_id, amount_cents, removed_at, category_source FROM transactions WHERE transfer_group_id IS NOT NULL");
  const groups = new Map<string, typeof members>();
  for (const m of members) groups.set(m.transfer_group_id, [...(groups.get(m.transfer_group_id) ?? []), m]);
  let dissolved = 0;
  for (const [id, group] of groups) {
    if (group.some((m) => isLocked(m.category_source))) continue;
    const live = group.filter((m) => m.removed_at === null);
    if (live.length === 2 && live[0]!.amount_cents + live[1]!.amount_cents === 0) continue;
    await dissolveGroup(db, id);
    dissolved++;
  }
  return dissolved;
}

export async function dissolveGroup(db: SqlDriver, groupId: string): Promise<void> {
  await db.run("UPDATE transactions SET transfer_group_id = NULL WHERE transfer_group_id = ?", [groupId]);
  await db.run("DELETE FROM transfer_groups WHERE id = ?", [groupId]);
}

export interface SettleResult {
  merchants_created: number;
  pairs_made: number;
  pairs_dissolved: number;
  /** Transactions whose category, source or rule changed. */
  changed: number;
  /** Transactions now waiting in Review. */
  queued: number;
  /** Recurring series stored. */
  recurring: number;
  /** Open alerts. */
  alerts: number;
}

export async function settle(deps: Pick<CoreDeps, "db" | "now" | "newId">): Promise<SettleResult> {
  const { db } = deps;
  return db.transaction(async () => {
    const merchants_created = await ensureMerchants(deps);
    const pairs_dissolved = await dissolveBrokenPairs(db);

    const rows = await loadRows(db);
    const pairs = matchTransfers(rows);
    for (const pair of pairs) {
      const groupId = deps.newId();
      await db.run("INSERT INTO transfer_groups (id, kind) VALUES (?, ?)", [groupId, pair.kind]);
      await db.run("UPDATE transactions SET transfer_group_id = ? WHERE id IN (?, ?)", [groupId, pair.out.id, pair.in.id]);
      for (const side of [pair.out, pair.in]) {
        side.transfer_group_id = groupId;
        side.group_kind = pair.kind;
      }
    }

    const ctx = await loadContext(db);
    let changed = 0;
    for (const t of rows) {
      if (isLocked(t.category_source)) continue;
      const d = decide(t, ctx);
      if (!differs(t, d)) continue;
      await db.run(
        "UPDATE transactions SET category_id = ?, category_source = ?, rule_id = ?, needs_review = ? WHERE id = ?",
        [d.category_id, d.category_source, d.rule_id, d.needs_review, t.id],
      );
      changed++;
    }
    await db.run(
      `UPDATE rules SET hit_count = (
         SELECT COUNT(*) FROM transactions t WHERE t.rule_id = rules.id AND t.removed_at IS NULL)`,
    );
    const queued = await refreshReviewQueue(db);
    // Recurring series depend on categories (transfers are left out), and alerts on both.
    const recurring = await refreshRecurring(deps);
    const alerts = await refreshAlerts(deps);
    return { merchants_created, pairs_made: pairs.length, pairs_dissolved, changed, queued, recurring, alerts };
  });
}

/** `settle` for callers that must not fail because of it (a sync, an import). */
export async function settleQuietly(deps: Pick<CoreDeps, "db" | "now" | "newId">): Promise<SettleResult | null> {
  try {
    return await settle(deps);
  } catch (err) {
    console.error("Categorizing failed:", err);
    return null;
  }
}

export interface RulePreview {
  /** Unlocked transactions whose category would change. */
  would_change: number;
  /** Up to ten of them. */
  sample: { id: string; posted_date: string; description_raw: string; amount_cents: number; from: string | null; to: string }[];
}

/**
 * What would change if the rules were `rules` instead of what is stored.
 * Reads only. Transfer pairs are taken as they stand.
 */
export async function previewRules(db: SqlDriver, rules: Rule[]): Promise<RulePreview> {
  const ctx = await loadContext(db, [...rules].sort(ruleOrder));
  const preview: RulePreview = { would_change: 0, sample: [] };
  for (const t of await loadRows(db)) {
    if (isLocked(t.category_source)) continue;
    const d = decide(t, ctx);
    if (d.category_id === t.category_id) continue;
    preview.would_change++;
    if (preview.sample.length < 10) {
      preview.sample.push({
        id: t.id,
        posted_date: t.posted_date,
        description_raw: t.description_raw,
        amount_cents: t.amount_cents,
        from: t.category_id,
        to: d.category_id,
      });
    }
  }
  return preview;
}

/** The order rules are tried in: lowest priority number first, newest first within one. */
export const ruleOrder = (a: Rule, b: Rule): number =>
  a.priority - b.priority || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
