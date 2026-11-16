import { beforeEach, describe, expect, it } from "vitest";
import {
  checkSelect,
  type CoreDeps,
  createMcpServer,
  generateDemoData,
  listTransactions,
  type McpServer,
  splitTransaction,
  spendingSummary,
  undo,
} from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

let deps: CoreDeps;
let server: McpServer;
let seq = 0;

beforeEach(async () => {
  ({ deps } = await makeDeps(undefined));
  await generateDemoData(deps.db, { months: 4, asOf: "2026-06-30" });
  server = createMcpServer({ read: deps.db, deps });
});

async function rpc(method: string, params?: Record<string, unknown>) {
  const res = (await server.handle({ jsonrpc: "2.0", id: ++seq, method, params })) as any;
  if (res.error) throw new Error(`${res.error.code} ${res.error.message}`);
  return res.result;
}

/** Call a tool; returns the parsed result, or throws with the tool's error text. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

describe("MCP protocol", () => {
  it("introduces itself as finance-hub with tools and prompts", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.serverInfo.name).toBe("finance-hub");
    expect(init.protocolVersion).toBe("2025-06-18");
    expect(init.capabilities).toHaveProperty("tools");
    expect(init.capabilities).toHaveProperty("prompts");
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await rpc("ping")).toEqual({});
  });

  it("lists the M4 tools and leaves out what M6 to M8 will add", async () => {
    const { tools } = await rpc("tools/list");
    const names = tools.map((t: any) => t.name).sort();
    for (const name of [
      "overview",
      "list_accounts",
      "query_transactions",
      "spending_summary",
      "cash_flow",
      "net_worth_history",
      "holdings",
      "review_queue",
      "list_categories",
      "list_rules",
      "sync_status",
      "run_sql",
      "categorize_transactions",
      "create_rule",
      "update_rule",
      "delete_rule",
      "split_transaction",
      "annotate_transaction",
      "review_transactions",
      "mark_transfer",
      "sync_now",
      "undo",
    ]) {
      expect(names).toContain(name);
    }
    for (const later of ["weekly_digest", "budget_status", "run_projection", "set_budget"]) expect(names).not.toContain(later);
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
    expect(byName.run_sql.annotations.readOnlyHint).toBe(true);
    expect(byName.categorize_transactions.annotations.readOnlyHint).toBe(false);
    expect(byName.categorize_transactions.description).toMatch(/remember to false/);
    expect(byName.create_rule.description).toMatch(/more than 20/);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  it("serves the three prompts", async () => {
    const { prompts } = await rpc("prompts/list");
    expect(prompts.map((p: any) => p.name).sort()).toEqual(["clear-review-queue", "month-close", "weekly-review"]);
    const got = await rpc("prompts/get", { name: "month-close", arguments: { month: "2026-05" } });
    expect(got.messages[0].content.text).toContain("2026-05");
    expect(got.messages[0].content.text).toContain("spending_summary");
  });

  it("answers unknown methods and tools with errors, not crashes", async () => {
    const res = (await server.handle({ jsonrpc: "2.0", id: 1, method: "resources/list" })) as any;
    expect(res.error.code).toBe(-32601);
    const bad = await rpc("tools/call", { name: "nope", arguments: {} });
    expect(bad.isError).toBe(true);
    await expect(tool("query_transactions", { from: "June 1" })).rejects.toThrow(/date like/);
    await expect(tool("categorize_transactions", { ids: [], category_id: "food.groceries" })).rejects.toThrow(/non-empty/);
  });
});

describe("run_sql", () => {
  it("runs a single SELECT and caps rows at 500", async () => {
    const r = await tool("run_sql", { sql: "SELECT id, amount_cents FROM transactions WHERE removed_at IS NULL" });
    expect(r.rows).toHaveLength(500);
    expect(r.truncated).toBe(true);
    const small = await tool("run_sql", { sql: "SELECT COUNT(*) AS n FROM accounts;" });
    expect(small.rows[0].n).toBe(10);
    const cte = await tool("run_sql", { sql: "WITH x AS (SELECT 2 AS v) SELECT v * 3 AS w FROM x" });
    expect(cte.rows).toEqual([{ w: 6 }]);
    const quoted = await tool("run_sql", { sql: "SELECT 'a; DELETE FROM accounts' AS s, replace('x', 'x', 'y') AS r" });
    expect(quoted.rows[0].r).toBe("y");
  });

  it("rejects anything that isn't exactly one SELECT", async () => {
    const refused = [
      "DELETE FROM transactions",
      "UPDATE accounts SET name = 'x'",
      "INSERT INTO tags (id, name) VALUES ('a', 'b')",
      "DROP TABLE rules",
      "PRAGMA table_info(accounts)",
      "ATTACH DATABASE 'x.db' AS x",
      "SELECT 1; DELETE FROM accounts",
      "SELECT 1; SELECT 2",
      "SELECT 1 /* hide */ ; DROP TABLE rules",
      "WITH x AS (SELECT 1) DELETE FROM accounts",
      "WITH x AS (SELECT 1) REPLACE INTO tags SELECT 'a', 'b'",
      "VACUUM",
      "BEGIN; DELETE FROM accounts; COMMIT",
      "select * from accounts where name = 'unclosed",
      "",
    ];
    for (const sql of refused) {
      await expect(tool("run_sql", { sql }), sql).rejects.toThrow();
    }
    expect(() => checkSelect(42)).toThrow();
    const n = await deps.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM accounts");
    expect(n[0]!.n).toBe(10);
  });
});

describe("read tools", () => {
  it("answers 'how much did I spend on restaurants last month'", async () => {
    const r = await tool("spending_summary", { from: "2026-05-01", to: "2026-05-31", group_by: "category" });
    const restaurants = r.rows.find((x: any) => x.key === "food.restaurants");
    expect(restaurants.total_cents).toBeLessThan(0);
    const check = await deps.db.all<{ s: number }>(
      `SELECT SUM(amount_cents) AS s FROM transactions WHERE category_id = 'food.restaurants' AND posted_date BETWEEN '2026-05-01' AND '2026-05-31'
       AND removed_at IS NULL AND is_split_parent = 0 AND excluded = 0 AND pending = 0`,
    );
    expect(restaurants.total_cents).toBe(check[0]!.s);
    const months = await tool("spending_summary", { from: "2026-03-01", to: "2026-06-30", group_by: "month" });
    expect(months.rows.map((x: any) => x.key)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]);
  });

  it("queries transactions with filters and a 200-row cap", async () => {
    const all = await tool("query_transactions", { limit: 1000 });
    expect(all.returned).toBe(200);
    expect(all.total).toBeGreaterThan(200);
    const pizza = await tool("query_transactions", { merchant: "blue door", limit: 5 });
    expect(pizza.transactions.length).toBeGreaterThan(0);
    expect(pizza.transactions.every((t: any) => t.merchant_key === "BLUE DOOR PIZZA")).toBe(true);
    const big = await tool("query_transactions", { min_amount_cents: 100_000, direction: "out" });
    expect(big.transactions.every((t: any) => t.amount_cents <= -100_000)).toBe(true);
  });

  it("gives an overview, accounts, cash flow, net worth, categories and sync status", async () => {
    const o = await tool("overview");
    expect(o.review_queue.all).toBeGreaterThan(0);
    expect((await tool("list_accounts")).accounts).toHaveLength(10);
    expect((await tool("cash_flow", { months: 3 })).months).toHaveLength(3);
    expect((await tool("net_worth_history", { months: 3 })).points.length).toBeGreaterThan(0);
    expect((await tool("list_categories")).categories.some((c: any) => c.id === "food.groceries")).toBe(true);
    expect((await tool("list_rules")).rules.length).toBeGreaterThan(0);
    expect((await tool("sync_status")).plaid_connection_limit).toBe(10);
    expect((await tool("holdings")).total_cents).toBeGreaterThanOrEqual(0);
  });

  it("groups the review queue by merchant with enough context to decide", async () => {
    const q = await tool("review_queue");
    expect(q.total_transactions).toBeGreaterThan(0);
    const counted = q.merchants.reduce((n: number, m: any) => n + m.count, 0);
    expect(counted).toBeLessThanOrEqual(q.total_transactions);
    for (const m of q.merchants) {
      expect(m).toHaveProperty("merchant_key");
      expect(m).toHaveProperty("plaid_categories");
      expect(m).toHaveProperty("past_charges");
      expect(m).toHaveProperty("varies");
      expect(m.transactions.length).toBeGreaterThan(0);
    }
    // The planted large purchase is there for the right reason.
    const volt = q.merchants.find((m: any) => m.merchant_key === "VOLT ELECTRONICS");
    expect(volt.reasons).toContain("large");
    // "POS PURCHASE 123456" rows are generic: they vary and get no suggestion.
    const pos = q.merchants.find((m: any) => m.merchant_key?.startsWith("POS PURCHASE"));
    if (pos) {
      expect(pos.varies).toBe(true);
      expect(pos.suggested_category_id).toBeNull();
    }
    const onlyLarge = await tool("review_queue", { reason: "large" });
    expect(onlyLarge.merchants.every((m: any) => m.reasons.includes("large") || m.reasons.includes("unusual"))).toBe(true);
  });
});

describe("write tools", () => {
  it("recategorizes as Claude with a rule, returns batch and change ids, and undoes the batch", async () => {
    const found = await tool("query_transactions", { merchant: "coastline kayak" });
    const target = found.transactions[0];
    const r = await tool("categorize_transactions", { ids: [target.id], category_id: "entertainment.events", create_rule: true });
    expect(r.batch_id).toBeTruthy();
    expect(r.change_ids.length).toBeGreaterThan(1);
    expect(r.rules[0].match).toEqual({ merchant_key: target.merchant_key });
    const after = await tool("query_transactions", { merchant: "coastline kayak" });
    expect(after.transactions.every((t: any) => t.category_id === "entertainment.events")).toBe(true);
    expect(after.transactions.find((t: any) => t.id === target.id).set_by).toBe("claude");
    const changes = await deps.db.all<{ actor: string }>("SELECT DISTINCT actor FROM changes WHERE batch_id = ?", [r.batch_id]);
    expect(changes).toEqual([{ actor: "claude" }]);

    const u = await tool("undo", { id: r.batch_id });
    expect(u.skipped).toEqual([]);
    const back = await tool("query_transactions", { merchant: "coastline kayak" });
    expect(back.transactions.every((t: any) => t.category_id === "travel.activities")).toBe(true);
  });

  it("dry-runs a rule, then creates, updates and deletes it", async () => {
    const dry = await tool("create_rule", { match: { merchant_key: "STREAMLY" }, category_id: "software.subscriptions", dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.changed).toBeGreaterThan(0);
    expect((await tool("list_rules")).rules.some((x: any) => x.match.merchant_key === "STREAMLY")).toBe(false);
    const made = await tool("create_rule", { match: { merchant_key: "STREAMLY" }, category_id: "software.subscriptions" });
    expect(made.rule.origin).toBe("claude");
    expect(made.batch_id).toBeTruthy();
    const off = await tool("update_rule", { id: made.rule.id, enabled: false });
    expect(off.rule.enabled).toBe(false);
    await tool("delete_rule", { id: made.rule.id });
    expect((await tool("list_rules")).rules.some((x: any) => x.id === made.rule.id)).toBe(false);
    await expect(tool("create_rule", { match: { nonsense: 1 }, category_id: "food.groceries" })).rejects.toThrow(/Unknown match field/);
  });

  it("annotates with a note, tags and excluded, and undo puts the tags back", async () => {
    const t = (await tool("query_transactions", { merchant: "volt electronics" })).transactions[0];
    const r = await tool("annotate_transaction", { id: t.id, note: "new laptop", tags: ["work", "Gear ", "gear"], excluded: true });
    expect(r.batch_id).toBeTruthy();
    let now = (await tool("query_transactions", { merchant: "volt electronics" })).transactions[0];
    expect(now.note).toBe("new laptop");
    expect(now.tags).toEqual(["Gear", "work"]);
    expect(now.excluded).toBe(true);
    const cleared = await tool("annotate_transaction", { id: t.id, tags: [] });
    now = (await tool("query_transactions", { merchant: "volt electronics" })).transactions[0];
    expect(now.tags).toBeUndefined();
    await tool("undo", { id: cleared.batch_id });
    now = (await tool("query_transactions", { merchant: "volt electronics" })).transactions[0];
    expect(now.tags).toEqual(["Gear", "work"]);
    await tool("undo", { id: r.batch_id });
    now = (await tool("query_transactions", { merchant: "volt electronics" })).transactions[0];
    expect(now.tags).toBeUndefined();
    expect(now.note).toBeUndefined();
    expect(now.excluded).toBeUndefined();
    const left = await deps.db.all("SELECT * FROM tags");
    expect(left).toEqual([]);
  });

  it("marks transactions reviewed with a note and a flag", async () => {
    const q = await tool("review_queue", { reason: "large" });
    const id = q.merchants[0].transactions[0].id;
    const r = await tool("review_transactions", { ids: [id], note: "expected", flag: "suspicious" });
    expect(r.change_ids).toHaveLength(1);
    const flagged = await tool("review_queue", { reason: "flagged" });
    expect(flagged.merchants.some((m: any) => m.transactions.some((t: any) => t.id === id && t.note === "expected"))).toBe(true);
    await tool("review_transactions", { ids: [id], flag: "resolved" });
    const after = await tool("review_queue");
    expect(after.merchants.some((m: any) => m.transactions.some((t: any) => t.id === id))).toBe(false);
  });

  it("unpairs and re-pairs a transfer", async () => {
    const out = (await tool("query_transactions", { text: "TRANSFER TO SAVINGS", limit: 1 })).transactions[0];
    expect(out.transfer.other_side).toBeTruthy();
    const peer = out.transfer.other_side;
    const un = await tool("mark_transfer", { unpair_id: out.id });
    expect(un.change_ids).toHaveLength(2);
    const re = await tool("mark_transfer", { ids: [out.id, peer] });
    expect(re.kind).toBe("internal_transfer");
    await expect(tool("mark_transfer", { ids: [out.id] })).rejects.toThrow();
  });

  it("says plainly when syncing isn't available", async () => {
    await expect(tool("sync_now")).rejects.toThrow(/isn't available/);
  });
});

describe("split_transaction", () => {
  async function aGroceryRun() {
    const { rows } = await listTransactions(deps.db, { merchantLike: "RIVERMART", limit: 1 });
    return rows[0]!;
  }

  it("splits into parts that sum to the original, keeps totals, and undoes", async () => {
    const t = await aGroceryRun();
    const month = t.posted_date.slice(0, 7);
    const range = { from: `${month}-01`, to: `${month}-31` };
    const before = await spendingSummary(deps.db, range);
    const third = Math.trunc(t.amount_cents / 3);
    const parts = [
      { amount_cents: third, category_id: "food.groceries", note: "food" },
      { amount_cents: t.amount_cents - third, category_id: "shopping.home" },
    ];
    const r = await tool("split_transaction", { id: t.id, parts });
    expect(r.children).toHaveLength(2);
    expect(r.batch_id).toBeTruthy();

    const shown = await listTransactions(deps.db, { merchantLike: "RIVERMART", limit: 500 });
    expect(shown.rows.some((x) => x.id === t.id)).toBe(false);
    const kids = shown.rows.filter((x) => r.children.includes(x.id));
    expect(kids.map((k) => k.category_id).sort()).toEqual(["food.groceries", "shopping.home"]);
    expect(kids.every((k) => k.category_source === "claude" && k.review_reasons.length === 0)).toBe(true);
    const after = await spendingSummary(deps.db, range);
    expect(after.total_cents).toBe(before.total_cents);

    await undo(deps, r.batch_id);
    const restored = await listTransactions(deps.db, { merchantLike: "RIVERMART", limit: 500 });
    expect(restored.rows.some((x) => x.id === t.id)).toBe(true);
    expect(restored.rows.some((x) => r.children.includes(x.id))).toBe(false);
  });

  it("refuses parts that don't add up, a single part, or the wrong sign", async () => {
    const t = await aGroceryRun();
    await expect(
      tool("split_transaction", { id: t.id, parts: [{ amount_cents: t.amount_cents, category_id: "food.groceries" }, { amount_cents: -1, category_id: "shopping.home" }] }),
    ).rejects.toThrow(/add up/);
    await expect(tool("split_transaction", { id: t.id, parts: [{ amount_cents: t.amount_cents, category_id: "food.groceries" }] })).rejects.toThrow(/two parts/);
    await expect(
      tool("split_transaction", { id: t.id, parts: [{ amount_cents: -t.amount_cents, category_id: "food.groceries" }, { amount_cents: 2 * t.amount_cents, category_id: "shopping.home" }] }),
    ).rejects.toThrow(/same sign/);
    await expect(tool("split_transaction", { id: t.id, parts: [] })).rejects.toThrow(/isn't split/);
  });

  it("re-splits and removes a split, each undoable", async () => {
    const t = await aGroceryRun();
    const half = Math.trunc(t.amount_cents / 2);
    const first = await splitTransaction(deps, t.id, [
      { amount_cents: half, category_id: "food.groceries" },
      { amount_cents: t.amount_cents - half, category_id: "shopping.home" },
    ]);
    const removed = await splitTransaction(deps, t.id, []);
    expect(removed.children).toEqual([]);
    let shown = await listTransactions(deps.db, { merchantLike: "RIVERMART", limit: 500 });
    expect(shown.rows.some((x) => x.id === t.id)).toBe(true);
    await undo(deps, removed.batch_id);
    shown = await listTransactions(deps.db, { merchantLike: "RIVERMART", limit: 500 });
    expect(shown.rows.filter((x) => first.children.includes(x.id))).toHaveLength(2);
    await expect(splitTransaction(deps, first.children[0]!, [])).rejects.toThrow(/one part of a split/);
  });
});
