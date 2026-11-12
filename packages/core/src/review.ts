import type { SqlDriver } from "./db/driver.ts";
import { getSetting } from "./db/seed.ts";
import { LABEL_SQL } from "./queries.ts";

/**
 * Decides which transactions deserve a look and why. This is the first cut
 * of the Review queue (docs/PLAN.md section 6): M4 replaces the merchant key
 * with the normalized merchant and wires this into sync.
 */

/** Duplicate charges are an M6 alert, not a reason here. */
export type ReviewReason = "uncategorized" | "large" | "unfamiliar" | "unusual";

export const REVIEW_DEFAULTS = { largeCents: 20_000, newMerchantCents: 2_500 } as const;

interface Row {
  id: string;
  account_id: string;
  label: string;
  posted_date: string;
  amount_cents: number;
  category_id: string | null;
  kind: string | null;
  reviewed_at: string | null;
}

/**
 * Recompute `review_reasons` for unreviewed transactions. Only charges dated
 * on or after `since` are judged for size and familiarity, so a first sync
 * does not queue years of history; a missing category is queued at any age. Returns how many transactions are queued.
 */
export async function refreshReviewQueue(db: SqlDriver, since: string): Promise<number> {
  const largeCents = await getSetting(db, "review_large_cents", REVIEW_DEFAULTS.largeCents);
  const newMerchantCents = await getSetting(db, "review_new_merchant_cents", REVIEW_DEFAULTS.newMerchantCents);
  const rows = await db.all<Row>(
    `SELECT t.id, t.account_id, ${LABEL_SQL} AS label, t.posted_date, t.amount_cents, t.category_id, c.kind, t.reviewed_at
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.removed_at IS NULL AND t.is_split_parent = 0
     ORDER BY t.posted_date, t.id`,
  );

  const seen = new Map<string, number[]>();
  const reasons = new Map<string, ReviewReason[]>();
  for (const row of rows) {
    const earlier = seen.get(row.label) ?? [];
    const outflow = row.amount_cents < 0;
    const transfer = row.kind === "transfer" || row.kind === "investment";
    if (!row.reviewed_at && !transfer) {
      const recent = row.posted_date >= since;
      const why: ReviewReason[] = [];
      // A missing category always needs an answer; the rest only apply to recent charges.
      if (!row.category_id || row.category_id === "uncategorized.uncategorized") why.push("uncategorized");
      if (!recent) {
        if (why.length) reasons.set(row.id, why);
        if (outflow) seen.set(row.label, [...earlier, -row.amount_cents]);
        continue;
      }
      if (outflow && -row.amount_cents >= largeCents) why.push("large");
      if (outflow && earlier.length === 0 && -row.amount_cents >= newMerchantCents) why.push("unfamiliar");
      if (outflow && earlier.length >= 4) {
        const sorted = [...earlier].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)]!;
        if (-row.amount_cents > median * 3 && -row.amount_cents >= newMerchantCents) why.push("unusual");
      }
      if (why.length) reasons.set(row.id, why);
    }
    if (outflow) seen.set(row.label, [...earlier, -row.amount_cents]);
  }

  await db.transaction(async () => {
    await db.run(
      "UPDATE transactions SET review_reasons = NULL WHERE reviewed_at IS NULL AND review_reasons IS NOT NULL",
    );
    for (const [id, why] of reasons) {
      await db.run("UPDATE transactions SET review_reasons = ? WHERE id = ?", [JSON.stringify(why), id]);
    }
  });
  return reasons.size;
}
