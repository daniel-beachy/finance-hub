import { isGenericMerchant, normalizeMerchant } from "./categorize/normalize.ts";
import {
  DEFAULT_RULE_PRIORITY,
  getRule,
  listRules,
  type Rule,
  type RuleMatch,
  validateMatch,
} from "./categorize/rules.ts";
import {
  dissolveGroup,
  previewRules,
  type RulePreview,
  settle,
  TRANSFER_CATEGORY,
  type TransferKind,
  transferKind,
} from "./categorize/settle.ts";
import { first, type SqlDriver, type SqlValue } from "./db/driver.ts";
import type { CoreDeps } from "./deps.ts";
import { InvalidInput, NotFound } from "./errors.ts";
import { getTransaction, type TransactionView } from "./queries.ts";
import { UNCATEGORIZED } from "./seed/categories.ts";

/**
 * Everything a person or Claude can change: transactions, rules, transfer
 * pairs. The dashboard's routes and the MCP tools both call these.
 *
 * Each action writes `changes` rows that share a `batch_id`, holding what the
 * touched rows looked like before and after. `undo` reverses a whole batch.
 * What follows from an action (rules re-applied, merchant memory used, pairs
 * re-matched) is not logged: `settle` works it out again after every action
 * and after every undo.
 */

type Deps = Pick<CoreDeps, "db" | "now" | "newId">;
export type Actor = "user" | "claude";

export interface EditOptions {
  actor?: Actor;
  /**
   * Whether a category set by hand becomes the merchant's default. Leave on
   * for merchants that always mean one thing; turn off for ones that vary
   * (Amazon, Costco, Venmo).
   */
  remember?: boolean;
}

/** What an edit did, and the handle to undo it. */
export interface EditResult {
  batch_id: string;
  change_ids: string[];
}

interface Batch {
  id: string;
  actor: Actor;
  tool: string;
  changeIds: string[];
}

const FLAGS = new Set(["suspicious", "disputed", "resolved"]);
const KINDS = new Set<string>(["internal_transfer", "card_payment", "investment_contribution"]);

async function inBatch<T>(deps: Deps, actor: Actor, tool: string, work: (batch: Batch) => Promise<T>): Promise<T> {
  return deps.db.transaction(async () => work({ id: deps.newId(), actor, tool, changeIds: [] }));
}

async function log(deps: Deps, batch: Batch, entity: string, entityId: string, before: unknown, after: unknown): Promise<void> {
  const id = deps.newId();
  await deps.db.run(
    `INSERT INTO changes (id, at, actor, tool, entity, entity_id, before, after, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      deps.now().toISOString(),
      batch.actor,
      batch.tool,
      entity,
      entityId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      batch.id,
    ],
  );
  batch.changeIds.push(id);
}

const done = (batch: Batch): EditResult => ({ batch_id: batch.id, change_ids: batch.changeIds });

// ---------------------------------------------------------------------------
// Transactions

/** The parts of a transaction an edit can change, as stored in `changes`. */
interface Snapshot {
  category_id: string | null;
  category_source: string | null;
  rule_id: string | null;
  needs_review: number;
  note: string | null;
  flag: string | null;
  reviewed_at: string | null;
  review_reasons: string[] | null;
  excluded: number;
  transfer_group_id: string | null;
  transfer_kind: string | null;
  tags: string[];
}

async function tagsOf(db: SqlDriver, id: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    "SELECT g.name FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = ? ORDER BY g.name",
    [id],
  );
  return rows.map((r) => r.name);
}

/** Clean a tag list: trimmed, one space between words, no duplicates ignoring case, sorted. */
export function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) throw new InvalidInput("tags must be a list of names");
  const seen = new Map<string, string>();
  for (const raw of input) {
    if (typeof raw !== "string") throw new InvalidInput("tags must be a list of names");
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (name.length > 40) throw new InvalidInput("A tag can be at most 40 characters");
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  if (seen.size > 20) throw new InvalidInput("At most 20 tags on one transaction");
  return [...seen.values()].sort();
}

/** Replace a transaction's tags. A tag that exists under another case is reused. */
async function writeTags(deps: Deps, id: string, tags: string[]): Promise<void> {
  const { db } = deps;
  await db.run("DELETE FROM transaction_tags WHERE transaction_id = ?", [id]);
  for (const name of tags) {
    let tagId = (await first<{ id: string }>(db, "SELECT id FROM tags WHERE name = ? COLLATE NOCASE", [name]))?.id;
    if (!tagId) {
      tagId = deps.newId();
      await db.run("INSERT INTO tags (id, name) VALUES (?, ?)", [tagId, name]);
    }
    await db.run("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)", [id, tagId]);
  }
  await db.run("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM transaction_tags)");
}

async function snapshot(db: SqlDriver, id: string): Promise<Snapshot | undefined> {
  const row = await first<Omit<Snapshot, "review_reasons" | "tags"> & { review_reasons: string | null }>(
    db,
    `SELECT t.category_id, t.category_source, t.rule_id, t.needs_review, t.note, t.flag, t.reviewed_at,
       t.review_reasons, t.excluded, t.transfer_group_id, g.kind AS transfer_kind
     FROM transactions t LEFT JOIN transfer_groups g ON g.id = t.transfer_group_id WHERE t.id = ?`,
    [id],
  );
  if (!row) return undefined;
  return {
    ...row,
    review_reasons: row.review_reasons ? (JSON.parse(row.review_reasons) as string[]) : null,
    tags: await tagsOf(db, id),
  };
}

export interface TransactionPatch {
  category_id?: string;
  note?: string | null;
  /** true marks it reviewed; false puts it back in the queue. */
  reviewed?: boolean;
  flag?: "suspicious" | "disputed" | "resolved" | null;
  /** Leave it out of every total. */
  excluded?: boolean;
  /** The full set of tags; replaces what is there. */
  tags?: string[];
}

/** Apply a patch and log it. The caller settles afterwards. */
async function patchTransaction(deps: Deps, batch: Batch, id: string, patch: TransactionPatch, remember: boolean): Promise<void> {
  const { db } = deps;
  const before = await snapshot(db, id);
  if (!before) throw new NotFound(`No transaction with id ${id}`);
  const now = deps.now().toISOString();
  const set: string[] = [];
  const params: SqlValue[] = [];
  const assign = (column: string, value: SqlValue) => {
    set.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.category_id !== undefined) {
    await requireCategory(db, patch.category_id);
    assign("category_id", patch.category_id);
    assign("category_source", batch.actor === "claude" ? "claude" : "manual");
    assign("needs_review", 0);
    assign("rule_id", null);
    // Naming the category by hand overrides an automatic transfer pairing.
    if (before.transfer_group_id) await dissolveGroup(db, before.transfer_group_id);
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
  if (patch.excluded !== undefined) assign("excluded", patch.excluded ? 1 : 0);
  const tags = patch.tags === undefined ? undefined : cleanTags(patch.tags);
  const tagsChange = tags !== undefined && JSON.stringify(tags) !== JSON.stringify(before.tags);
  if (set.length === 0 && !tagsChange) return;

  assign("updated_at", now);
  await db.run(`UPDATE transactions SET ${set.join(", ")} WHERE id = ?`, [...params, id]);
  if (tagsChange) await writeTags(deps, id, tags);
  await log(deps, batch, "transaction", id, before, await snapshot(db, id));
  if (patch.category_id !== undefined && remember) await rememberMerchant(deps, batch, id);
}

/**
 * Merchant memory: when every hand-categorized transaction of a merchant
 * agrees, that category becomes the merchant's default and `settle` applies
 * it to the rest. When they disagree the merchant varies, and it has none.
 */
async function rememberMerchant(deps: Deps, batch: Batch, transactionId: string): Promise<void> {
  const { db } = deps;
  const tx = await first<{ merchant_id: string | null; description_raw: string; merchant_raw: string | null }>(
    db,
    "SELECT merchant_id, description_raw, merchant_raw FROM transactions WHERE id = ?",
    [transactionId],
  );
  if (!tx) return;
  let merchantId = tx.merchant_id;
  if (!merchantId) {
    // Not settled yet (it arrived moments ago): find or create its merchant now.
    const { key, name } = normalizeMerchant(tx.merchant_raw, tx.description_raw);
    merchantId = (await first<{ id: string }>(db, "SELECT id FROM merchants WHERE normalized_key = ?", [key]))?.id ?? null;
    if (!merchantId) {
      merchantId = deps.newId();
      await db.run("INSERT INTO merchants (id, name, normalized_key) VALUES (?, ?, ?)", [merchantId, name, key]);
    }
    await db.run("UPDATE transactions SET merchant_id = ? WHERE id = ?", [merchantId, transactionId]);
  }
  const key = await first<{ normalized_key: string }>(db, "SELECT normalized_key FROM merchants WHERE id = ?", [merchantId]);
  if (!key || isGenericMerchant(key.normalized_key)) return;
  const chosen = await db.all<{ category_id: string }>(
    `SELECT DISTINCT category_id FROM transactions
     WHERE merchant_id = ? AND removed_at IS NULL AND parent_id IS NULL AND is_split_parent = 0
       AND category_source IN ('manual', 'claude') AND category_id IS NOT NULL AND category_id != ?`,
    [merchantId, UNCATEGORIZED],
  );
  const next = chosen.length === 1 ? chosen[0]!.category_id : null;
  const merchant = await first<{ default_category_id: string | null }>(
    db,
    "SELECT default_category_id FROM merchants WHERE id = ?",
    [merchantId],
  );
  if (!merchant || merchant.default_category_id === next) return;
  await db.run("UPDATE merchants SET default_category_id = ? WHERE id = ?", [next, merchantId]);
  await log(deps, batch, "merchant", merchantId, { default_category_id: merchant.default_category_id }, { default_category_id: next });
}

export async function updateTransaction(
  deps: Deps,
  id: string,
  patch: TransactionPatch,
  actor: Actor = "user",
  options: Pick<EditOptions, "remember"> = {},
): Promise<TransactionView & { batch_id: string | null; change_ids: string[] }> {
  return inBatch(deps, actor, "update_transaction", async (batch) => {
    await patchTransaction(deps, batch, id, patch, options.remember ?? true);
    if (batch.changeIds.length) await settle(deps);
    const view = (await getTransaction(deps.db, id))!;
    // No batch when nothing changed, so there is nothing to undo.
    return { ...view, batch_id: batch.changeIds.length ? batch.id : null, change_ids: batch.changeIds };
  });
}

/** The same patch on many transactions, as one undoable batch. */
export async function patchTransactions(
  deps: Deps,
  ids: string[],
  patch: TransactionPatch,
  actor: Actor = "user",
  options: Pick<EditOptions, "remember"> & { tool?: string } = {},
): Promise<EditResult & { updated: number }> {
  if (ids.length === 0) throw new InvalidInput("Give at least one transaction id");
  if (ids.length > 500) throw new InvalidInput("At most 500 transactions at a time");
  return inBatch(deps, actor, options.tool ?? "update_transaction", async (batch) => {
    for (const id of ids) await patchTransaction(deps, batch, id, patch, options.remember ?? true);
    if (batch.changeIds.length) await settle(deps);
    return { ...done(batch), updated: ids.length };
  });
}

export interface CategorizeResult extends EditResult {
  updated: number;
  /** Rules made or repointed by `createRule`. */
  rules: Rule[];
}

/**
 * Set one category on many transactions. With `createRule`, each merchant
 * among them also gets a rule sending it to that category from now on.
 */
export async function categorizeTransactions(
  deps: Deps,
  ids: string[],
  categoryId: string,
  actor: Actor = "user",
  options: Pick<EditOptions, "remember"> & { createRule?: boolean } = {},
): Promise<CategorizeResult> {
  if (ids.length > 500) throw new InvalidInput("At most 500 transactions at a time");
  return inBatch(deps, actor, "categorize_transactions", async (batch) => {
    await requireCategory(deps.db, categoryId);
    for (const id of ids) {
      await patchTransaction(deps, batch, id, { category_id: categoryId }, options.remember ?? true);
    }
    const rules: Rule[] = [];
    if (options.createRule && ids.length) {
      const marks = ids.map(() => "?").join(", ");
      const merchants = await deps.db.all<{ key: string; transaction_id: string }>(
        `SELECT m.normalized_key AS key, MIN(t.id) AS transaction_id FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id WHERE t.id IN (${marks}) GROUP BY m.normalized_key`,
        ids,
      );
      const existing = await listRules(deps.db);
      for (const m of merchants) {
        const same = existing.find(
          (r) => Object.keys(r.match).length === 1 && r.match.merchant_key === m.key && r.origin !== "seed",
        );
        if (same) {
          if (same.actions.category_id !== categoryId || !same.enabled) {
            rules.push(await writeRule(deps, batch, same, { ...same, enabled: true, actions: { category_id: categoryId } }));
          }
        } else {
          rules.push(
            await writeRule(deps, batch, null, {
              id: deps.newId(),
              priority: DEFAULT_RULE_PRIORITY,
              enabled: true,
              match: { merchant_key: m.key },
              actions: { category_id: categoryId },
              origin: actor,
              created_from_transaction_id: m.transaction_id,
              hit_count: 0,
              created_at: deps.now().toISOString(),
            }),
          );
        }
      }
    }
    if (batch.changeIds.length) await settle(deps);
    return { ...done(batch), updated: ids.length, rules };
  });
}

async function requireCategory(db: SqlDriver, id: string): Promise<void> {
  const rows = await db.all("SELECT 1 FROM categories WHERE id = ?", [id]);
  if (rows.length === 0) throw new InvalidInput(`No category with id ${id}`);
}

// ---------------------------------------------------------------------------
// Rules

export interface RuleInput {
  match: unknown;
  category_id: string;
  /** Lower runs first. Default 100. */
  priority?: number;
  enabled?: boolean;
  created_from_transaction_id?: string | null;
}

export interface RuleEditOptions {
  actor?: Actor;
  /** Report what would change and write nothing. */
  dryRun?: boolean;
}

export interface RuleEditResult extends Partial<EditResult> {
  dry_run: boolean;
  rule: Rule | null;
  /** Unlocked transactions whose category changes (or would). */
  changed: number;
  sample: RulePreview["sample"];
}

/** Insert, update (`next` and `before`) or delete (`next` null) a rule row and log it. */
async function writeRule(deps: Deps, batch: Batch, before: Rule | null, next: Rule): Promise<Rule>;
async function writeRule(deps: Deps, batch: Batch, before: Rule, next: null): Promise<null>;
async function writeRule(deps: Deps, batch: Batch, before: Rule | null, next: Rule | null): Promise<Rule | null> {
  const { db } = deps;
  if (next === null) {
    await db.run("UPDATE transactions SET rule_id = NULL WHERE rule_id = ?", [before!.id]);
    await db.run("DELETE FROM rules WHERE id = ?", [before!.id]);
  } else if (before === null) {
    await insertRule(db, next);
  } else {
    await db.run("UPDATE rules SET priority = ?, enabled = ?, match = ?, actions = ? WHERE id = ?", [
      next.priority,
      next.enabled ? 1 : 0,
      JSON.stringify(next.match),
      JSON.stringify(next.actions),
      next.id,
    ]);
  }
  await log(deps, batch, "rule", (next ?? before)!.id, before, next);
  return next;
}

async function insertRule(db: SqlDriver, r: Rule): Promise<void> {
  await db.run(
    `INSERT INTO rules (id, priority, enabled, match, actions, origin, created_from_transaction_id, hit_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.priority,
      r.enabled ? 1 : 0,
      JSON.stringify(r.match),
      JSON.stringify(r.actions),
      r.origin,
      r.created_from_transaction_id,
      r.hit_count,
      r.created_at,
    ],
  );
}

function checkPriority(priority: unknown): number {
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 100_000) {
    throw new InvalidInput("priority must be a whole number from 0 to 100000");
  }
  return priority;
}

/** Shared tail of the three rule edits: preview for a dry run, otherwise write and settle. */
async function editRules(
  deps: Deps,
  tool: string,
  options: RuleEditOptions,
  before: Rule | null,
  next: Rule | null,
): Promise<RuleEditResult> {
  const id = (next ?? before)!.id;
  if (options.dryRun) {
    const others = (await listRules(deps.db)).filter((r) => r.id !== id);
    const preview = await previewRules(deps.db, next ? [...others, next] : others);
    return { dry_run: true, rule: next, changed: preview.would_change, sample: preview.sample };
  }
  return inBatch(deps, options.actor ?? "user", tool, async (batch) => {
    // Preview first, against the rules as they stood, so the count means the same thing as a dry run.
    const others = (await listRules(deps.db)).filter((r) => r.id !== id);
    const preview = await previewRules(deps.db, next ? [...others, next] : others);
    if (next) await writeRule(deps, batch, before, next);
    else await writeRule(deps, batch, before!, null);
    await settle(deps);
    const rule = next ? ((await getRule(deps.db, id)) ?? null) : null;
    return { ...done(batch), dry_run: false, rule, changed: preview.would_change, sample: preview.sample };
  });
}

export async function createRule(deps: Deps, input: RuleInput, options: RuleEditOptions = {}): Promise<RuleEditResult> {
  await requireCategory(deps.db, input.category_id);
  const rule: Rule = {
    id: deps.newId(),
    priority: input.priority === undefined ? DEFAULT_RULE_PRIORITY : checkPriority(input.priority),
    enabled: input.enabled ?? true,
    match: validateMatch(input.match),
    actions: { category_id: input.category_id },
    origin: options.actor ?? "user",
    created_from_transaction_id: input.created_from_transaction_id ?? null,
    hit_count: 0,
    created_at: deps.now().toISOString(),
  };
  return editRules(deps, "create_rule", options, null, rule);
}

export async function updateRule(
  deps: Deps,
  id: string,
  patch: Partial<Omit<RuleInput, "created_from_transaction_id">>,
  options: RuleEditOptions = {},
): Promise<RuleEditResult> {
  const before = await getRule(deps.db, id);
  if (!before) throw new NotFound(`No rule with id ${id}`);
  if (patch.category_id !== undefined) await requireCategory(deps.db, patch.category_id);
  const next: Rule = {
    ...before,
    priority: patch.priority === undefined ? before.priority : checkPriority(patch.priority),
    enabled: patch.enabled ?? before.enabled,
    match: patch.match === undefined ? before.match : validateMatch(patch.match),
    actions: patch.category_id === undefined ? before.actions : { category_id: patch.category_id },
  };
  return editRules(deps, "update_rule", options, before, next);
}

export async function deleteRule(deps: Deps, id: string, options: RuleEditOptions = {}): Promise<RuleEditResult> {
  const before = await getRule(deps.db, id);
  if (!before) throw new NotFound(`No rule with id ${id}`);
  return editRules(deps, "delete_rule", options, before, null);
}

/** Shorthand for the common rule: this merchant always goes to this category. */
export const merchantRule = (merchantKey: string): RuleMatch => ({ merchant_key: merchantKey });

// ---------------------------------------------------------------------------
// Transfers

/**
 * Pair two transactions by hand as one movement between Dan's accounts.
 * Both become locked, so nothing automatic splits them up again.
 */
export async function markTransfer(
  deps: Deps,
  ids: [string, string],
  options: { actor?: Actor; kind?: TransferKind } = {},
): Promise<EditResult & { kind: TransferKind }> {
  const { db } = deps;
  if (ids[0] === ids[1]) throw new InvalidInput("A transfer needs two different transactions");
  if (options.kind !== undefined && !KINDS.has(options.kind)) throw new InvalidInput("Unknown transfer kind");
  return inBatch(deps, options.actor ?? "user", "mark_transfer", async (batch) => {
    const sides: { id: string; type: string; removed_at: string | null; transfer_group_id: string | null }[] = [];
    for (const id of ids) {
      const row = await first<(typeof sides)[number]>(
        db,
        `SELECT t.id, a.type, t.removed_at, t.transfer_group_id FROM transactions t
         JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
        [id],
      );
      if (!row || row.removed_at) throw new NotFound(`No transaction with id ${id}`);
      sides.push(row);
    }
    const kind = options.kind ?? transferKind(sides[0]!.type, sides[1]!.type);
    const before = [await snapshot(db, ids[0]), await snapshot(db, ids[1])];
    for (const side of sides) if (side.transfer_group_id) await dissolveGroup(db, side.transfer_group_id);
    const groupId = deps.newId();
    await db.run("INSERT INTO transfer_groups (id, kind) VALUES (?, ?)", [groupId, kind]);
    await db.run(
      `UPDATE transactions SET transfer_group_id = ?, category_id = ?, category_source = ?, rule_id = NULL,
         needs_review = 0, updated_at = ? WHERE id IN (?, ?)`,
      [groupId, TRANSFER_CATEGORY[kind], batch.actor === "claude" ? "claude" : "manual", deps.now().toISOString(), ...ids],
    );
    for (const [i, id] of ids.entries()) await log(deps, batch, "transaction", id, before[i], await snapshot(db, id));
    await settle(deps);
    return { ...done(batch), kind };
  });
}

/** Undo a pairing, automatic or by hand. Both sides go back to the categorizer. */
export async function unmarkTransfer(deps: Deps, id: string, options: { actor?: Actor } = {}): Promise<EditResult> {
  const { db } = deps;
  return inBatch(deps, options.actor ?? "user", "mark_transfer", async (batch) => {
    const tx = await first<{ transfer_group_id: string | null }>(db, "SELECT transfer_group_id FROM transactions WHERE id = ?", [id]);
    if (!tx) throw new NotFound(`No transaction with id ${id}`);
    if (!tx.transfer_group_id) throw new InvalidInput("That transaction isn't part of a transfer");
    const members = await db.all<{ id: string }>("SELECT id FROM transactions WHERE transfer_group_id = ? ORDER BY id", [
      tx.transfer_group_id,
    ]);
    const before = new Map<string, Snapshot | undefined>();
    for (const m of members) before.set(m.id, await snapshot(db, m.id));
    await dissolveGroup(db, tx.transfer_group_id);
    // Lock both as "not a transfer, category unknown" so the matcher doesn't pair them straight back.
    await db.run(
      `UPDATE transactions SET category_id = ?, category_source = ?, rule_id = NULL, needs_review = 1, updated_at = ?
       WHERE id IN (${members.map(() => "?").join(", ")})`,
      [UNCATEGORIZED, batch.actor === "claude" ? "claude" : "manual", deps.now().toISOString(), ...members.map((m) => m.id)],
    );
    for (const m of members) await log(deps, batch, "transaction", m.id, before.get(m.id), await snapshot(db, m.id));
    await settle(deps);
    return done(batch);
  });
}

// ---------------------------------------------------------------------------
// Splits

export interface SplitPart {
  amount_cents: number;
  category_id: string;
  note?: string | null;
}

/** A split child as stored in `changes`, enough to put it back exactly. */
interface SplitChild {
  id: string;
  account_id: string;
  source: string;
  external_id: string;
  pending: number;
  posted_date: string;
  authorized_date: string | null;
  amount_cents: number;
  currency: string;
  description_raw: string;
  merchant_raw: string | null;
  merchant_id: string | null;
  category_id: string | null;
  category_source: string | null;
  parent_id: string;
  note: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

const CHILD_COLUMNS = [
  "id",
  "account_id",
  "source",
  "external_id",
  "pending",
  "posted_date",
  "authorized_date",
  "amount_cents",
  "currency",
  "description_raw",
  "merchant_raw",
  "merchant_id",
  "category_id",
  "category_source",
  "parent_id",
  "note",
  "reviewed_at",
  "created_at",
  "updated_at",
] as const;

async function childrenOf(db: SqlDriver, parentId: string): Promise<SplitChild[]> {
  return db.all<SplitChild>(
    `SELECT ${CHILD_COLUMNS.join(", ")} FROM transactions WHERE parent_id = ? ORDER BY external_id`,
    [parentId],
  );
}

async function insertChild(db: SqlDriver, c: SplitChild): Promise<void> {
  await db.run(
    `INSERT INTO transactions (${CHILD_COLUMNS.join(", ")}) VALUES (${CHILD_COLUMNS.map(() => "?").join(", ")})`,
    CHILD_COLUMNS.map((k) => c[k]),
  );
}

async function removeChildren(db: SqlDriver, parentId: string): Promise<void> {
  await db.run("DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE parent_id = ?)", [parentId]);
  await db.run("DELETE FROM transactions WHERE parent_id = ?", [parentId]);
}

/**
 * Split one transaction into parts that each carry their own category, such
 * as one store receipt that was half groceries and half household. The parts
 * must add up to the original amount, to the cent. The original stays, marked
 * as split, and drops out of every total; the parts take its place. An empty
 * `parts` list removes a split. Undo puts back whatever was there before.
 */
export async function splitTransaction(
  deps: Deps,
  id: string,
  parts: SplitPart[],
  actor: Actor = "user",
): Promise<EditResult & { children: string[] }> {
  const { db } = deps;
  return inBatch(deps, actor, "split_transaction", async (batch) => {
    const parent = await first<{
      account_id: string;
      source: string;
      external_id: string;
      pending: number;
      posted_date: string;
      authorized_date: string | null;
      amount_cents: number;
      currency: string;
      description_raw: string;
      merchant_raw: string | null;
      merchant_id: string | null;
      parent_id: string | null;
      removed_at: string | null;
      transfer_group_id: string | null;
    }>(db, "SELECT * FROM transactions WHERE id = ?", [id]);
    if (!parent || parent.removed_at) throw new NotFound(`No transaction with id ${id}`);
    if (parent.parent_id) throw new InvalidInput("That is already one part of a split; split the original instead");
    if (parent.transfer_group_id) throw new InvalidInput("A transfer can't be split; unpair it first");
    if (parts.length === 1) throw new InvalidInput("A split needs at least two parts");
    if (parts.length > 20) throw new InvalidInput("At most 20 parts");
    let sum = 0;
    for (const part of parts) {
      if (!Number.isInteger(part.amount_cents) || part.amount_cents === 0) throw new InvalidInput("Each part needs a whole, non-zero number of cents");
      if (Math.sign(part.amount_cents) !== Math.sign(parent.amount_cents)) throw new InvalidInput("Each part must have the same sign as the original");
      if (typeof part.note === "string" && part.note.length > 2000) throw new InvalidInput("A note can be at most 2,000 characters");
      await requireCategory(db, part.category_id);
      sum += part.amount_cents;
    }
    if (parts.length && sum !== parent.amount_cents) {
      throw new InvalidInput(`The parts add up to ${sum} cents but the transaction is ${parent.amount_cents}`);
    }

    const before = await childrenOf(db, id);
    if (before.length === 0 && parts.length === 0) throw new InvalidInput("That transaction isn't split");
    await removeChildren(db, id);
    const now = deps.now().toISOString();
    const source = actor === "claude" ? "claude" : "manual";
    for (const [i, part] of parts.entries()) {
      await insertChild(db, {
        id: deps.newId(),
        account_id: parent.account_id,
        source: "manual",
        external_id: `${parent.external_id}#split-${batch.id}-${i + 1}`,
        pending: parent.pending,
        posted_date: parent.posted_date,
        authorized_date: parent.authorized_date,
        amount_cents: part.amount_cents,
        currency: parent.currency,
        description_raw: parent.description_raw,
        merchant_raw: parent.merchant_raw,
        merchant_id: parent.merchant_id,
        category_id: part.category_id,
        category_source: source,
        parent_id: id,
        note: part.note?.trim() || null,
        // Splitting is a decision about the charge, so the parts don't wait in Review.
        reviewed_at: now,
        created_at: now,
        updated_at: now,
      });
    }
    await db.run("UPDATE transactions SET is_split_parent = ?, updated_at = ? WHERE id = ?", [parts.length ? 1 : 0, now, id]);
    const after = await childrenOf(db, id);
    await log(deps, batch, "split", id, { children: before }, { children: after });
    await settle(deps);
    return { ...done(batch), children: after.map((c) => c.id) };
  });
}

// ---------------------------------------------------------------------------
// Undo

export interface UndoResult {
  /** `changes` rows reversed. */
  undone: string[];
  /** Rows left alone, with why: usually something else changed them since. */
  skipped: { change_id: string; reason: string }[];
}

interface ChangeRow {
  id: string;
  entity: string;
  entity_id: string;
  before: string | null;
  after: string | null;
  undone_at: string | null;
}

/** Fields that show a person's intent. If one moved since the change, undoing would clobber newer work. */
const INTENT: (keyof Snapshot)[] = ["category_id", "category_source", "note", "flag", "excluded", "reviewed_at", "transfer_group_id", "tags"];
const RESTORABLE: (keyof Snapshot)[] = [
  "category_id",
  "category_source",
  "rule_id",
  "needs_review",
  "note",
  "flag",
  "reviewed_at",
  "review_reasons",
  "excluded",
  "transfer_group_id",
];

/**
 * Reverse a change, or every change in a batch, newest first. Takes a
 * `changes` id or a `batch_id`. A row that something else has changed since
 * is skipped and reported, never overwritten.
 */
export async function undo(deps: Deps, changeOrBatchId: string): Promise<UndoResult> {
  const { db } = deps;
  return db.transaction(async () => {
    const one = await first<{ batch_id: string | null }>(db, "SELECT batch_id FROM changes WHERE id = ?", [changeOrBatchId]);
    const rows = await db.all<ChangeRow>(
      `SELECT id, entity, entity_id, before, after, undone_at FROM changes
       WHERE ${one ? "id = ?" : "batch_id = ?"} ORDER BY rowid DESC`,
      [changeOrBatchId],
    );
    if (rows.length === 0) throw new NotFound(`No change or batch with id ${changeOrBatchId}`);
    const result: UndoResult = { undone: [], skipped: [] };
    const now = deps.now().toISOString();
    for (const row of rows) {
      const reason = row.undone_at ? "already undone" : await reverseChange(deps, row, now);
      if (reason) {
        result.skipped.push({ change_id: row.id, reason });
        continue;
      }
      await db.run("UPDATE changes SET undone_at = ? WHERE id = ?", [now, row.id]);
      result.undone.push(row.id);
    }
    await db.run(
      `DELETE FROM transfer_groups WHERE id NOT IN (
         SELECT transfer_group_id FROM transactions WHERE transfer_group_id IS NOT NULL)`,
    );
    if (result.undone.length) await settle(deps);
    return result;
  });
}

/** Put one entity back. Returns why not, or null when done. */
async function reverseChange(deps: Deps, row: ChangeRow, now: string): Promise<string | null> {
  const { db } = deps;
  const before = row.before ? JSON.parse(row.before) : null;
  const after = row.after ? JSON.parse(row.after) : null;
  switch (row.entity) {
    case "transaction": {
      const current = await snapshot(db, row.entity_id);
      if (!current || !before) return "the transaction no longer exists";
      for (const key of INTENT) {
        if (after && key in after && JSON.stringify(current[key]) !== JSON.stringify(after[key])) {
          return `${key} was changed again afterwards`;
        }
      }
      if (before.transfer_group_id) {
        await db.run("INSERT OR IGNORE INTO transfer_groups (id, kind) VALUES (?, ?)", [
          before.transfer_group_id,
          before.transfer_kind ?? "internal_transfer",
        ]);
      }
      const keys = RESTORABLE.filter((k) => k in before);
      const values = keys.map((k): SqlValue => (k === "review_reasons" ? (before[k] ? JSON.stringify(before[k]) : null) : before[k]));
      await db.run(`UPDATE transactions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [
        ...values,
        now,
        row.entity_id,
      ]);
      if ("tags" in before) await writeTags(deps, row.entity_id, before.tags as string[]);
      return null;
    }
    case "split": {
      const parent = await first<{ is_split_parent: number }>(db, "SELECT is_split_parent FROM transactions WHERE id = ?", [row.entity_id]);
      if (!parent) return "the transaction no longer exists";
      const children = await db.all<{ id: string }>("SELECT id FROM transactions WHERE parent_id = ?", [row.entity_id]);
      const expected = ((after?.children ?? []) as SplitChild[]).map((c) => c.id).sort();
      if (JSON.stringify(children.map((c) => c.id).sort()) !== JSON.stringify(expected)) return "the split was changed again afterwards";
      await removeChildren(db, row.entity_id);
      const restore = (before?.children ?? []) as SplitChild[];
      for (const child of restore) await insertChild(db, child);
      await db.run("UPDATE transactions SET is_split_parent = ?, updated_at = ? WHERE id = ?", [restore.length ? 1 : 0, now, row.entity_id]);
      return null;
    }
    case "merchant": {
      const current = await first<{ default_category_id: string | null }>(
        db,
        "SELECT default_category_id FROM merchants WHERE id = ?",
        [row.entity_id],
      );
      if (!current) return "the merchant no longer exists";
      if (current.default_category_id !== (after?.default_category_id ?? null)) return "the merchant's default was changed again afterwards";
      await db.run("UPDATE merchants SET default_category_id = ? WHERE id = ?", [before?.default_category_id ?? null, row.entity_id]);
      return null;
    }
    case "rule": {
      const current = await getRule(db, row.entity_id);
      if (before === null) {
        if (!current) return "the rule is already gone";
        await db.run("UPDATE transactions SET rule_id = NULL WHERE rule_id = ?", [row.entity_id]);
        await db.run("DELETE FROM rules WHERE id = ?", [row.entity_id]);
      } else if (current) {
        await db.run("UPDATE rules SET priority = ?, enabled = ?, match = ?, actions = ? WHERE id = ?", [
          before.priority,
          before.enabled ? 1 : 0,
          JSON.stringify(before.match),
          JSON.stringify(before.actions),
          row.entity_id,
        ]);
      } else {
        await insertRule(db, before as Rule);
      }
      return null;
    }
    default:
      return `changes to a ${row.entity} can't be undone`;
  }
}
