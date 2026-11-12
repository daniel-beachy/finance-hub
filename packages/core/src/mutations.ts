import type { SqlDriver, SqlValue } from "./db/driver.ts";
import type { CoreDeps } from "./deps.ts";
import { getTransaction, type TransactionView } from "./queries.ts";

/** Edits a person (or Claude) makes to a transaction. Every edit is logged to `changes`. */

export type Actor = "user" | "claude";

export interface TransactionPatch {
  category_id?: string;
  note?: string | null;
  /** true marks it reviewed; false puts it back in the queue. */
  reviewed?: boolean;
  flag?: "suspicious" | "disputed" | "resolved" | null;
}

export class NotFound extends Error {}
export class InvalidInput extends Error {}

const FLAGS = new Set(["suspicious", "disputed", "resolved"]);

export async function updateTransaction(
  deps: Pick<CoreDeps, "db" | "now" | "newId">,
  id: string,
  patch: TransactionPatch,
  actor: Actor = "user",
): Promise<TransactionView> {
  const { db } = deps;
  return db.transaction(async () => {
    const before = await getTransaction(db, id);
    if (!before) throw new NotFound(`No transaction with id ${id}`);
    const now = deps.now().toISOString();
    const set: string[] = [];
    const params: SqlValue[] = [];
    const assign = (column: string, value: SqlValue) => {
      set.push(`${column} = ?`);
      params.push(value);
    };

    let reasons = before.review_reasons;
    if (patch.category_id !== undefined) {
      await requireCategory(db, patch.category_id);
      assign("category_id", patch.category_id);
      assign("category_source", actor === "claude" ? "claude" : "manual");
      assign("needs_review", 0);
      assign("rule_id", null);
      // Naming the category answers "uncategorized"; other reasons still stand.
      reasons = reasons.filter((r) => r !== "uncategorized");
      assign("review_reasons", reasons.length ? JSON.stringify(reasons) : null);
    }
    if (patch.note !== undefined) {
      const note = patch.note?.trim() || null;
      if (note && note.length > 2000) throw new InvalidInput("A note can be at most 2,000 characters");
      assign("note", note);
    }
    if (patch.reviewed !== undefined) assign("reviewed_at", patch.reviewed ? now : null);
    if (patch.flag !== undefined) {
      if (patch.flag !== null && !FLAGS.has(patch.flag)) throw new InvalidInput("Unknown flag");
      assign("flag", patch.flag);
    }
    if (set.length === 0) return before;

    assign("updated_at", now);
    await db.run(`UPDATE transactions SET ${set.join(", ")} WHERE id = ?`, [...params, id]);
    const after = (await getTransaction(db, id))!;
    await db.run(
      "INSERT INTO changes (id, at, actor, tool, entity, entity_id, before, after) VALUES (?, ?, ?, ?, 'transaction', ?, ?, ?)",
      [deps.newId(), now, actor, "update_transaction", id, JSON.stringify(pick(before)), JSON.stringify(pick(after))],
    );
    return after;
  });
}

/** Set one category on many transactions. Returns how many changed. */
export async function categorizeTransactions(
  deps: Pick<CoreDeps, "db" | "now" | "newId">,
  ids: string[],
  categoryId: string,
  actor: Actor = "user",
): Promise<number> {
  if (ids.length > 500) throw new InvalidInput("At most 500 transactions at a time");
  return deps.db.transaction(async () => {
    await requireCategory(deps.db, categoryId);
    for (const id of ids) await updateTransaction(deps, id, { category_id: categoryId }, actor);
    return ids.length;
  });
}

async function requireCategory(db: SqlDriver, id: string): Promise<void> {
  const rows = await db.all("SELECT 1 FROM categories WHERE id = ?", [id]);
  if (rows.length === 0) throw new InvalidInput(`No category with id ${id}`);
}

function pick(t: TransactionView) {
  return {
    category_id: t.category_id,
    category_source: t.category_source,
    note: t.note,
    flag: t.flag,
    reviewed_at: t.reviewed_at,
    review_reasons: t.review_reasons,
  };
}
