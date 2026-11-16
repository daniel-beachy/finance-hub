import type { SqlDriver } from "./db/driver.ts";
import { getSetting } from "./db/seed.ts";
import { LABEL_SQL } from "./queries.ts";

/**
 * Decides which transactions deserve a look and why (docs/PLAN.md section 6).
 * `settle` calls this after categorizing. Merchants are told apart by their
 * normalized merchant, so "SPACE AGE #24" and "SPACE AGE #202" are one.
 */

/** Duplicate charges are an M6 alert, not a reason here. */
export type ReviewReason = "uncategorized" | "large" | "unfamiliar" | "unusual";

export const REVIEW_DEFAULTS = { largeCents: 20_000, newMerchantCents: 2_500 } as const;

interface Row {
  id: string;
  account_id: string;
  merchant: string;
  posted_date: string;
  amount_cents: number;
  category_id: string | null;
  kind: string | null;
  reviewed_at: string | null;
  review_reasons: string | null;
  account_since: string;
}

/**
 * Recompute `review_reasons` for unreviewed transactions and return how many
 * are queued. A missing category is queued at any age. Size and familiarity
 * are only judged from `since` on, so a first sync doesn't queue years of
 * history: `since` is the argument, else the `review_since` setting (the demo
 * pins it), else the day each account was added.
 */
export async function refreshReviewQueue(db: SqlDriver, since?: string): Promise<number> {
  const largeCents = await getSetting(db, "review_large_cents", REVIEW_DEFAULTS.largeCents);
  const newMerchantCents = await getSetting(db, "review_new_merchant_cents", REVIEW_DEFAULTS.newMerchantCents);
  const fixedSince = since ?? (await getSetting<string | null>(db, "review_since", null));
  const rows = await db.all<Row>(
    `SELECT t.id, t.account_id, COALESCE(t.merchant_id, ${LABEL_SQL}) AS merchant, t.posted_date, t.amount_cents,
       t.category_id, c.kind, t.reviewed_at, t.review_reasons, substr(a.created_at, 1, 10) AS account_since
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.removed_at IS NULL AND t.is_split_parent = 0
     ORDER BY t.posted_date, t.id`,
  );

  const seen = new Map<string, number[]>();
  const updates: [string, string | null][] = [];
  let queued = 0;
  for (const row of rows) {
    const earlier = seen.get(row.merchant) ?? [];
    const outflow = row.amount_cents < 0;
    if (outflow) seen.set(row.merchant, [...earlier, -row.amount_cents]);
    if (row.reviewed_at) continue;
    const why: ReviewReason[] = [];
    // Card payments and transfers between Dan's accounts are never queued.
    const transfer = row.kind === "transfer" || row.kind === "investment";
    if (!transfer) {
      // A missing category always needs an answer; the rest only apply to recent charges.
      if (!row.category_id || row.category_id === "uncategorized.uncategorized") why.push("uncategorized");
      if (outflow && row.posted_date >= (fixedSince ?? row.account_since)) {
        if (-row.amount_cents >= largeCents) why.push("large");
        if (earlier.length === 0 && -row.amount_cents >= newMerchantCents) why.push("unfamiliar");
        if (earlier.length >= 4) {
          const sorted = [...earlier].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)]!;
          if (-row.amount_cents > median * 3 && -row.amount_cents >= newMerchantCents) why.push("unusual");
        }
      }
    }
    const next = why.length ? JSON.stringify(why) : null;
    if (next) queued++;
    if (next !== row.review_reasons) updates.push([row.id, next]);
  }

  if (updates.length) {
    await db.transaction(async () => {
      for (const [id, reasons] of updates) {
        await db.run("UPDATE transactions SET review_reasons = ? WHERE id = ?", [reasons, id]);
      }
    });
  }
  return queued;
}
