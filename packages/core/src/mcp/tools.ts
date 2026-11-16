import { listRules } from "../categorize/rules.ts";
import type { TransferKind } from "../categorize/settle.ts";
import type { SqlDriver } from "../db/driver.ts";
import { type CoreDeps, localDate } from "../deps.ts";
import { InvalidInput } from "../errors.ts";
import { cashFlowByMonth, monthOf, netWorthHistory, overview, shiftMonth } from "../insights.ts";
import {
  categorizeTransactions,
  cleanTags,
  createRule,
  deleteRule,
  markTransfer,
  patchTransactions,
  type SplitPart,
  splitTransaction,
  type TransactionPatch,
  undo,
  unmarkTransfer,
  updateRule,
} from "../mutations.ts";
import { listAccounts, listCategories, listConnections, listTransactions, type ReviewTab } from "../queries.ts";
import { holdingsReport, recordReviewRun, reviewQueue, type SummaryGroup, type SummaryKind, spendingSummary, syncStatus } from "./reports.ts";
import { checkSelect, SQL_ROW_LIMIT } from "./sql.ts";

/** What the tools run against. */
export interface McpContext {
  /** A read-only connection. Every read tool uses this one. */
  read: SqlDriver;
  /** The writable connection and the rest of core's host, for write tools. */
  deps: CoreDeps;
  /**
   * Run one already-checked SELECT on a read-only connection, stopping after
   * `maxRows` rows and giving up after the time limit. The host supplies this
   * so it can enforce the timeout (Node runs it in a worker it can stop).
   */
  runSql?: (sql: string, maxRows: number) => Promise<{ rows: Record<string, unknown>[]; truncated: boolean }>;
  /** Run a full sync now. Absent where there's nothing to sync (tests). */
  syncNow?: () => Promise<unknown>;
}

type Args = Record<string, unknown>;
type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True for tools that change nothing. */
  readOnly: boolean;
  run(ctx: McpContext, args: Args): Promise<unknown>;
}

// --- argument helpers ------------------------------------------------------

const str = (args: Args, key: string, required = false): string | undefined => {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new InvalidInput(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new InvalidInput(`${key} must be text`);
  return v;
};
const int = (args: Args, key: string): number | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new InvalidInput(`${key} must be a whole number`);
  return v;
};
const bool = (args: Args, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new InvalidInput(`${key} must be true or false`);
  return v;
};
const ids = (args: Args, key: string): string[] => {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string")) {
    throw new InvalidInput(`${key} must be a non-empty list of transaction ids`);
  }
  return v as string[];
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (args: Args, key: string, required = false): string | undefined => {
  const v = str(args, key, required);
  if (v !== undefined && !DATE.test(v)) throw new InvalidInput(`${key} must be a date like 2026-11-15`);
  return v;
};

const today = (ctx: McpContext) => localDate(ctx.deps.now());

// --- schemas ---------------------------------------------------------------

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const S = {
  date: (description: string) => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description }),
  text: (description: string) => ({ type: "string", description }),
  int: (description: string) => ({ type: "integer", description }),
  bool: (description: string) => ({ type: "boolean", description }),
  ids: (description: string) => ({ type: "array", items: { type: "string" }, minItems: 1, description }),
};
const MATCH_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Conditions that must all hold. merchant_key is the normalized merchant (from review_queue or query_transactions). Amount bounds compare the size of the amount in cents, ignoring sign; use direction for the sign.",
  properties: {
    merchant_key: S.text("Normalized merchant key, e.g. BLUE DOOR PIZZA"),
    description_contains: S.text("Case-insensitive text anywhere in the bank's description"),
    description_regex: S.text("Case-insensitive regular expression on the bank's description"),
    account_id: S.text("Only this account"),
    amount_min_cents: S.int("Smallest size of amount, in cents"),
    amount_max_cents: S.int("Largest size of amount, in cents"),
    direction: { type: "string", enum: ["in", "out"], description: "in is money arriving, out is money leaving" },
    plaid_pfc_detailed: S.text("Plaid's detailed category, e.g. FOOD_AND_DRINK_RESTAURANT"),
  },
  additionalProperties: false,
};

/** Transactions as Claude sees them: the useful columns, nothing else. */
function compact(rows: Awaited<ReturnType<typeof listTransactions>>["rows"]) {
  return rows.map((t) => ({
    id: t.id,
    date: t.posted_date,
    amount_cents: t.amount_cents,
    merchant: t.label,
    description: t.description_raw,
    merchant_key: t.merchant_key,
    account: t.account_mask ? `${t.account_name} ••${t.account_mask}` : t.account_name,
    category_id: t.category_id,
    category: t.category_name,
    set_by: t.category_source,
    ...(t.note ? { note: t.note } : {}),
    ...(t.tags.length ? { tags: t.tags } : {}),
    ...(t.flag ? { flag: t.flag } : {}),
    ...(t.review_reasons.length && !t.reviewed_at ? { review_reasons: t.review_reasons } : {}),
    ...(t.pending ? { pending: true } : {}),
    ...(t.excluded ? { excluded: true } : {}),
    ...(t.transfer_peer_id ? { transfer: { kind: t.transfer_kind, other_side: t.transfer_peer_id, other_account: t.transfer_peer_account } } : {}),
  }));
}

// --- the tools -------------------------------------------------------------

const READ: ToolDef[] = [
  {
    name: "overview",
    description:
      "Start here. Net worth, this month's spending against the typical month, the review queue size by reason, connection health and open alerts. Money is integer cents; negative is money out.",
    inputSchema: object({}),
    readOnly: true,
    async run(ctx) {
      const o = await overview(ctx.read, today(ctx));
      const connections = await listConnections(ctx.read);
      const alerts = await ctx.read.all<{ kind: string; message: string; created_at: string }>(
        "SELECT kind, message, created_at FROM alerts WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT 20",
      );
      return {
        today: o.today,
        net_worth: o.net_worth,
        this_month: o.month,
        last_6_months: o.cash_flow,
        top_spending_categories_this_month: o.top_categories.map((c) => ({ id: c.category_id, name: c.name, total_cents: c.total_cents })),
        review_queue: o.review,
        connections: connections.map((c) => ({ institution: c.institution_name, status: c.status, last_synced_at: c.last_synced_at })),
        open_alerts: alerts,
      };
    },
  },
  {
    name: "list_accounts",
    description: "Every open account with its latest balance (cents; credit cards and loans are negative), type and tax treatment.",
    inputSchema: object({}),
    readOnly: true,
    run: async (ctx) => ({ accounts: await listAccounts(ctx.read) }),
  },
  {
    name: "query_transactions",
    description:
      "Find transactions. All filters are optional and combine. Returns up to `limit` rows (default 50, at most 200), newest first, plus the total count and net sum of everything that matched. Amounts are cents; negative is money out. Split originals are hidden; their parts are shown.",
    inputSchema: object({
      from: S.date("First date, inclusive"),
      to: S.date("Last date, inclusive"),
      account_id: S.text("One account"),
      category_id: S.text("One category id (see list_categories)"),
      group_id: S.text("One category group id"),
      kind: { type: "string", enum: ["income", "expense", "transfer", "investment"], description: "Category kind" },
      merchant: S.text("Case-insensitive text in the merchant name, merchant key or description"),
      text: S.text("Case-insensitive text in the description, merchant, note or category name"),
      min_amount_cents: S.int("Smallest size of amount in cents, ignoring sign"),
      max_amount_cents: S.int("Largest size of amount in cents, ignoring sign"),
      direction: { type: "string", enum: ["in", "out"] },
      needs_review: S.bool("Only what is waiting in Review"),
      limit: S.int("Rows to return, 1 to 200 (default 50)"),
      offset: S.int("Rows to skip, for paging"),
    }),
    readOnly: true,
    async run(ctx, a) {
      const limit = Math.min(Math.max(int(a, "limit") ?? 50, 1), 200);
      const direction = str(a, "direction");
      if (direction !== undefined && direction !== "in" && direction !== "out") throw new InvalidInput("direction must be in or out");
      const res = await listTransactions(ctx.read, {
        limit,
        offset: Math.max(int(a, "offset") ?? 0, 0),
        from: date(a, "from"),
        to: date(a, "to"),
        accountId: str(a, "account_id"),
        categoryId: str(a, "category_id"),
        groupId: str(a, "group_id"),
        kind: str(a, "kind"),
        merchantLike: str(a, "merchant"),
        q: str(a, "text"),
        minCents: int(a, "min_amount_cents"),
        maxCents: int(a, "max_amount_cents"),
        direction,
        review: bool(a, "needs_review") ? ("all" satisfies ReviewTab) : undefined,
      });
      return { total: res.total, sum_cents: res.sum_cents, returned: res.rows.length, transactions: compact(res.rows) };
    },
  },
  {
    name: "spending_summary",
    description:
      "Totals for a date range grouped by category, category group, merchant or month. kind is expense (default), income or all. Totals are signed cents: spending is negative, refunds reduce it. Transfers, card payments, investment moves, pending and excluded rows are left out.",
    inputSchema: object(
      {
        from: S.date("First date, inclusive"),
        to: S.date("Last date, inclusive"),
        group_by: { type: "string", enum: ["category", "group", "merchant", "month"] },
        kind: { type: "string", enum: ["expense", "income", "all"] },
        limit: S.int("Most groups to return (default 100)"),
      },
      ["from", "to"],
    ),
    readOnly: true,
    run: async (ctx, a) =>
      spendingSummary(ctx.read, {
        from: date(a, "from", true)!,
        to: date(a, "to", true)!,
        groupBy: str(a, "group_by") as SummaryGroup | undefined,
        kind: str(a, "kind") as SummaryKind | undefined,
        limit: int(a, "limit"),
      }),
  },
  {
    name: "cash_flow",
    description: "Income, spending and savings rate for each month, oldest first. Spending is shown positive here.",
    inputSchema: object({ months: S.int("How many months, 1 to 60 (default 12)"), to_month: S.text("Last month, YYYY-MM (default this month)") }),
    readOnly: true,
    async run(ctx, a) {
      const months = Math.min(Math.max(int(a, "months") ?? 12, 1), 60);
      const end = str(a, "to_month") ?? monthOf(today(ctx));
      if (!/^\d{4}-\d{2}$/.test(end)) throw new InvalidInput("to_month must look like 2026-11");
      const rows = await cashFlowByMonth(ctx.read, shiftMonth(end, -(months - 1)), end);
      return {
        months: rows.map((m) => ({
          ...m,
          saved_cents: m.income_cents - m.spending_cents,
          savings_rate: m.income_cents > 0 ? Math.round(((m.income_cents - m.spending_cents) / m.income_cents) * 1000) / 1000 : null,
        })),
      };
    },
  },
  {
    name: "net_worth_history",
    description: "Assets, liabilities and net worth at each month end, plus today. Cents.",
    inputSchema: object({ months: S.int("How many months back, 1 to 240 (default 24)") }),
    readOnly: true,
    run: async (ctx, a) => ({ points: await netWorthHistory(ctx.read, today(ctx), Math.min(Math.max(int(a, "months") ?? 24, 1), 240)) }),
  },
  {
    name: "holdings",
    description: "Latest investment positions per account, with allocation by asset class and by tax treatment. Values in cents.",
    inputSchema: object({}),
    readOnly: true,
    run: async (ctx) => holdingsReport(ctx.read),
  },
  {
    name: "review_queue",
    description:
      "What is waiting in Review, grouped by merchant, biggest groups first. Each group carries the merchant key, Plaid's category and confidence, how this merchant was categorized before, a suggested category when its history agrees, any rule already on it, and `varies` (true for merchants like Amazon or Venmo whose charges mean different things). Enough to decide a group without more calls.",
    inputSchema: object({
      reason: { type: "string", enum: ["uncategorized", "large", "unfamiliar", "unusual", "flagged"], description: "Only this reason" },
      limit: S.int("Most merchant groups, 1 to 100 (default 30)"),
      per_merchant: S.int("Most transactions listed per group (default 8)"),
    }),
    readOnly: true,
    run: async (ctx, a) => reviewQueue(ctx.read, { reason: str(a, "reason"), limit: int(a, "limit"), perMerchant: int(a, "per_merchant") }),
  },
  {
    name: "list_categories",
    description: "Every category with its id, group and kind (income, expense, transfer, investment). Use the ids in other tools.",
    inputSchema: object({}),
    readOnly: true,
    run: async (ctx) => ({
      categories: (await listCategories(ctx.read)).filter((c) => !c.hidden).map((c) => ({ id: c.id, name: c.name, group: c.group_name, kind: c.kind })),
    }),
  },
  {
    name: "list_rules",
    description: "Every categorizing rule in the order they are tried (lowest priority first), with how many transactions each currently decides.",
    inputSchema: object({}),
    readOnly: true,
    run: async (ctx) => ({ rules: await listRules(ctx.read) }),
  },
  {
    name: "sync_status",
    description: "Each connection's status, last sync and Plaid consent expiry, the latest sync runs, and how many of the Plaid connection slots are used.",
    inputSchema: object({}),
    readOnly: true,
    run: async (ctx) => syncStatus(ctx.read),
  },
  {
    name: "run_sql",
    description: `Run one read-only SELECT (or WITH ... SELECT) against the database, for questions no other tool answers. At most ${SQL_ROW_LIMIT} rows; stopped after 5 seconds. Main tables: transactions (amount_cents, posted_date, category_id, merchant_id, account_id, removed_at, is_split_parent, excluded, pending, note), categories, category_groups, merchants (normalized_key), accounts, balances (account_id, as_of, current_cents), holdings, securities, rules, changes. Leave out rows with removed_at set and split originals (is_split_parent = 1).`,
    inputSchema: object({ sql: S.text("One SELECT statement") }, ["sql"]),
    readOnly: true,
    async run(ctx, a) {
      const sql = checkSelect(a.sql);
      if (ctx.runSql) return ctx.runSql(sql, SQL_ROW_LIMIT);
      const rows = await ctx.read.all(`SELECT * FROM (${sql}) LIMIT ${SQL_ROW_LIMIT + 1}`);
      return { rows: rows.slice(0, SQL_ROW_LIMIT), truncated: rows.length > SQL_ROW_LIMIT };
    },
  },
];

const WRITE: ToolDef[] = [
  {
    name: "categorize_transactions",
    description:
      "Set one category on one or more transactions, locking them so nothing automatic changes them again. They leave the uncategorized part of Review. With create_rule, each merchant among them gets a rule sending its future charges to this category: use it only when the merchant is unambiguous. For merchants that vary (Amazon, Costco, Venmo, PayPal, checks), set remember to false and make no rule. Returns batch_id for undo.",
    inputSchema: object(
      {
        ids: S.ids("Transaction ids"),
        category_id: S.text("Category id (see list_categories)"),
        create_rule: S.bool("Also make a merchant rule for each merchant (default false)"),
        remember: S.bool("Let this become the merchant's default category (default true). Turn off for merchants that vary."),
      },
      ["ids", "category_id"],
    ),
    readOnly: false,
    run: async (ctx, a) => {
      const r = await categorizeTransactions(ctx.deps, ids(a, "ids"), str(a, "category_id", true)!, "claude", {
        createRule: bool(a, "create_rule") ?? false,
        remember: bool(a, "remember"),
      });
      return { batch_id: r.batch_id, change_ids: r.change_ids, updated: r.updated, rules: r.rules.map((x) => ({ id: x.id, match: x.match, category_id: x.actions.category_id })) };
    },
  },
  {
    name: "create_rule",
    description:
      "Create a categorizing rule. It applies to future transactions and to existing ones that no person or Claude categorized by hand. Call with dry_run true first whenever it might change more than 20 transactions, and tell the user the count. Returns how many existing transactions changed (or would) and a sample.",
    inputSchema: object(
      {
        match: MATCH_SCHEMA,
        category_id: S.text("Category id to set"),
        priority: S.int("Lower runs first (default 100)"),
        enabled: S.bool("Default true"),
        dry_run: S.bool("Report what would change and save nothing"),
      },
      ["match", "category_id"],
    ),
    readOnly: false,
    run: async (ctx, a) =>
      createRule(
        ctx.deps,
        { match: a.match, category_id: str(a, "category_id", true)!, priority: int(a, "priority"), enabled: bool(a, "enabled") },
        { actor: "claude", dryRun: bool(a, "dry_run") ?? false },
      ),
  },
  {
    name: "update_rule",
    description:
      "Change a rule's match, category, priority or enabled. Call with dry_run true first whenever it might change more than 20 transactions. Returns how many existing transactions changed (or would).",
    inputSchema: object(
      {
        id: S.text("Rule id"),
        match: MATCH_SCHEMA,
        category_id: S.text("New category id"),
        priority: S.int("Lower runs first"),
        enabled: S.bool("Turn the rule on or off"),
        dry_run: S.bool("Report what would change and save nothing"),
      },
      ["id"],
    ),
    readOnly: false,
    run: async (ctx, a) =>
      updateRule(
        ctx.deps,
        str(a, "id", true)!,
        { match: a.match, category_id: str(a, "category_id"), priority: int(a, "priority"), enabled: bool(a, "enabled") },
        { actor: "claude", dryRun: bool(a, "dry_run") ?? false },
      ),
  },
  {
    name: "delete_rule",
    description: "Delete a rule. Its transactions go back through merchant memory and Plaid's category. Accepts dry_run.",
    inputSchema: object({ id: S.text("Rule id"), dry_run: S.bool("Report what would change and save nothing") }, ["id"]),
    readOnly: false,
    run: async (ctx, a) => deleteRule(ctx.deps, str(a, "id", true)!, { actor: "claude", dryRun: bool(a, "dry_run") ?? false }),
  },
  {
    name: "split_transaction",
    description:
      "Split one transaction into parts with their own categories, e.g. one store receipt that was part groceries and part household. Part amounts are cents with the same sign as the original and must add up to it exactly. An empty parts list removes an existing split.",
    inputSchema: object(
      {
        id: S.text("Transaction id"),
        parts: {
          type: "array",
          items: object({ amount_cents: S.int("Signed cents, same sign as the original"), category_id: S.text("Category id"), note: S.text("Optional note") }, ["amount_cents", "category_id"]),
        },
      },
      ["id", "parts"],
    ),
    readOnly: false,
    async run(ctx, a) {
      if (!Array.isArray(a.parts)) throw new InvalidInput("parts must be a list");
      const parts: SplitPart[] = a.parts.map((p) => {
        const part = (p ?? {}) as Args;
        return { amount_cents: int(part, "amount_cents") ?? Number.NaN, category_id: str(part, "category_id", true)!, note: str(part, "note") ?? null };
      });
      return splitTransaction(ctx.deps, str(a, "id", true)!, parts, "claude");
    },
  },
  {
    name: "annotate_transaction",
    description:
      "Set a transaction's note, its tags (the full list, replacing what is there; [] clears them) or excluded (true leaves it out of every total). Only the fields given change.",
    inputSchema: object(
      {
        id: S.text("Transaction id"),
        note: { type: ["string", "null"], description: "Note text; null or empty clears it" },
        tags: { type: "array", items: { type: "string" }, description: "Full list of tag names" },
        excluded: S.bool("Leave out of totals"),
      },
      ["id"],
    ),
    readOnly: false,
    async run(ctx, a) {
      const patch: TransactionPatch = {};
      if (a.note !== undefined) {
        if (a.note !== null && typeof a.note !== "string") throw new InvalidInput("note must be text or null");
        patch.note = a.note as string | null;
      }
      if (a.tags !== undefined) patch.tags = cleanTags(a.tags);
      const excluded = bool(a, "excluded");
      if (excluded !== undefined) patch.excluded = excluded;
      if (Object.keys(patch).length === 0) throw new InvalidInput("Give note, tags or excluded");
      const r = await patchTransactions(ctx.deps, [str(a, "id", true)!], patch, "claude", { tool: "annotate_transaction" });
      return { batch_id: r.change_ids.length ? r.batch_id : null, change_ids: r.change_ids };
    },
  },
  {
    name: "review_transactions",
    description:
      "Mark transactions reviewed, taking them out of Review. Optionally set a category on all of them, a note saying what the charge was, or a flag: suspicious keeps it on the Flagged tab for the user, resolved clears a flag. Setting a category here never makes a rule; use categorize_transactions with create_rule for that.",
    inputSchema: object(
      {
        ids: S.ids("Transaction ids"),
        category_id: S.text("Optional category id for all of them"),
        note: S.text("Optional note for all of them"),
        flag: { type: "string", enum: ["suspicious", "disputed", "resolved"] },
        remember: S.bool("With category_id: let it become the merchant's default (default true)"),
      },
      ["ids"],
    ),
    readOnly: false,
    async run(ctx, a) {
      const patch: TransactionPatch = { reviewed: true };
      const category = str(a, "category_id");
      if (category) patch.category_id = category;
      const note = str(a, "note");
      if (note !== undefined) patch.note = note;
      const flag = str(a, "flag");
      if (flag !== undefined) patch.flag = flag as TransactionPatch["flag"];
      const r = await patchTransactions(ctx.deps, ids(a, "ids"), patch, "claude", { tool: "review_transactions", remember: bool(a, "remember") });
      return { batch_id: r.change_ids.length ? r.batch_id : null, change_ids: r.change_ids, updated: r.updated };
    },
  },
  {
    name: "mark_transfer",
    description:
      "Pair two transactions as one movement between the user's own accounts (ids, two of them), or undo a pairing (unpair_id). The kind is worked out from the account types unless given. Unpairing leaves both sides uncategorized in Review.",
    inputSchema: object({
      ids: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2, description: "The two sides" },
      kind: { type: "string", enum: ["internal_transfer", "card_payment", "investment_contribution"] },
      unpair_id: S.text("Either side of a pair to split up"),
    }),
    readOnly: false,
    async run(ctx, a) {
      const unpair = str(a, "unpair_id");
      if (unpair) return unmarkTransfer(ctx.deps, unpair, { actor: "claude" });
      const pair = ids(a, "ids");
      if (pair.length !== 2) throw new InvalidInput("ids must be exactly two transaction ids");
      return markTransfer(ctx.deps, [pair[0]!, pair[1]!], { actor: "claude", kind: str(a, "kind") as TransferKind | undefined });
    },
  },
  {
    name: "sync_now",
    description: "Fetch new transactions, balances and holdings from every connection now, then categorize. Takes a few seconds per institution.",
    inputSchema: object({}),
    readOnly: false,
    async run(ctx) {
      if (!ctx.syncNow) throw new InvalidInput("Syncing isn't available here");
      return ctx.syncNow();
    },
  },
  {
    name: "record_review_run",
    description:
      "At the end of a categorizing run (the weekly automatic run, or a clear-review-queue session), record it. Give started_at (the ISO time you began, taken from your first tool call's moment or earlier), queue_before (total_transactions from your first review_queue call) and a short summary of what you left in Review and why. The counts of what you categorized, reviewed, flagged and the rules you made are worked out from the change log.",
    inputSchema: object(
      {
        started_at: S.text("ISO timestamp from before your first change, e.g. 2026-11-15T07:30:00Z"),
        queue_before: S.int("Transactions waiting in Review when you started"),
        trigger: { type: "string", enum: ["schedule", "manual"], description: "schedule for the weekly run (default), manual otherwise" },
        summary: S.text("What you did and what you left, in a few sentences"),
      },
      ["started_at"],
    ),
    readOnly: false,
    run: async (ctx, a) =>
      recordReviewRun(ctx.deps, {
        startedAt: str(a, "started_at", true)!,
        queueBefore: int(a, "queue_before"),
        trigger: str(a, "trigger") === "manual" ? "manual" : "schedule",
        summary: str(a, "summary"),
      }),
  },
  {
    name: "undo",
    description:
      "Reverse an earlier change: give the batch_id a write tool returned (reverses that whole action) or one change id. Anything changed again since is skipped and reported, never overwritten.",
    inputSchema: object({ id: S.text("A batch_id or change id") }, ["id"]),
    readOnly: false,
    run: async (ctx, a) => undo(ctx.deps, str(a, "id", true)!),
  },
];

export const TOOLS: ToolDef[] = [...READ, ...WRITE];
