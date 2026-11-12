import { beforeAll, describe, expect, it } from "vitest";
import {
  ALL_CATEGORY_IDS,
  cashFlowByMonth,
  categorizeTransactions,
  createIdFactory,
  merchantHistory,
  netWorthHistory,
  overview,
  refreshReviewQueue,
  reviewCounts,
  spendingBreakdown,
  updateTransaction,
  generateDemoData,
  listAccounts,
  listCategories,
  listTransactions,
  migrate,
  netWorth,
  type SqlDriver,
  spendingByCategory,
} from "../src/index.ts";

/**
 * One suite, run against every SqlDriver, so the Node database and the
 * in-browser database are held to identical behaviour.
 */
export function defineQuerySuite(name: string, open: () => Promise<SqlDriver>) {
  describe(`queries on the ${name} driver`, () => {
    let db: SqlDriver;
    beforeAll(async () => {
      db = await open();
      await migrate(db);
      await generateDemoData(db, { seed: 5, asOf: "2026-06-30", months: 3 });
    });

    it("migrates once and seeds every category", async () => {
      expect(await migrate(db)).toEqual([]);
      const categories = await listCategories(db);
      expect(categories.map((c) => c.id).sort()).toEqual([...ALL_CATEGORY_IDS].sort());
      const map = await db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM plaid_category_map m LEFT JOIN categories c ON c.id = m.category_id WHERE c.id IS NULL",
      );
      expect(map[0]?.n).toBe(0);
    });

    it("lists accounts with their latest balance", async () => {
      const accounts = await listAccounts(db);
      expect(accounts).toHaveLength(10);
      const checking = accounts.find((a) => a.name === "Everyday Checking");
      expect(checking?.balance_as_of).toBe("2026-06-30");
      expect(checking?.transaction_count).toBeGreaterThan(10);
    });

    it("pages transactions newest first", async () => {
      const first = await listTransactions(db, { limit: 20 });
      const second = await listTransactions(db, { limit: 20, offset: 20 });
      expect(first.rows).toHaveLength(20);
      expect(first.total).toBeGreaterThan(400);
      expect(first.rows[0]!.posted_date >= first.rows[19]!.posted_date).toBe(true);
      expect(first.rows[19]!.posted_date >= second.rows[0]!.posted_date).toBe(true);
      expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(40);
    });

    it("leaves transfers out of spending", async () => {
      const spending = await spendingByCategory(db, "2026-05-01", "2026-05-31");
      expect(spending.length).toBeGreaterThan(8);
      expect(spending.some((s) => s.kind === "transfer")).toBe(false);
      const rent = spending.find((s) => s.category_id === "housing.rent");
      expect(rent?.total_cents).toBe(-215_000);
    });

    it("sums net worth from signed balances", async () => {
      const worth = await netWorth(db);
      expect(worth.liabilities_cents).toBeLessThan(0);
      expect(worth.net_cents).toBe(worth.assets_cents + worth.liabilities_cents);
      const check = await db.all<{ total: number }>(
        `SELECT SUM(current_cents) AS total FROM balances b
         WHERE as_of = (SELECT MAX(as_of) FROM balances WHERE account_id = b.account_id)`,
      );
      expect(worth.net_cents).toBe(check[0]?.total);
    });

    it("filters and searches transactions", async () => {
      const coffee = await listTransactions(db, { categoryId: "food.coffee", from: "2026-05-01", to: "2026-05-31" });
      expect(coffee.total).toBeGreaterThan(5);
      expect(coffee.rows.every((r) => r.category_id === "food.coffee" && r.posted_date.startsWith("2026-05"))).toBe(true);
      expect(coffee.sum_cents).toBeLessThan(0);
      const search = await listTransactions(db, { q: "noodle" });
      expect(search.total).toBeGreaterThan(0);
      expect(search.rows.every((r) => r.label === "Lantern Noodle House")).toBe(true);
      expect((await listTransactions(db, { q: "100%_nothing" })).total).toBe(0);
      const food = await listTransactions(db, { groupId: "food", limit: 5 });
      expect(food.rows.every((r) => r.group_name === "Food")).toBe(true);
    });

    it("breaks spending down and matches the cash flow for the same month", async () => {
      const may = await spendingBreakdown(db, "2026-05-01", "2026-05-31");
      const flow = await cashFlowByMonth(db, "2026-04", "2026-06");
      expect(flow.map((m) => m.month)).toEqual(["2026-04", "2026-05", "2026-06"]);
      expect(flow[1]!.spending_cents).toBe(may.spending_cents);
      expect(flow[1]!.income_cents).toBe(may.income_cents);
      expect(may.spending_cents).toBeGreaterThan(215_000);
      expect(may.previous_spending_cents).toBeGreaterThan(0);
      expect(may.categories.some((c) => c.kind === "transfer")).toBe(false);
      expect(may.merchants[0]!.merchant).toBe("Willow Creek Apartments");
      const listed = await listTransactions(db, { categoryId: "housing.rent", from: may.from, to: may.to });
      expect(listed.sum_cents).toBe(may.categories.find((c) => c.category_id === "housing.rent")!.total_cents);
    });

    it("builds a net worth history that ends at the current figure", async () => {
      const history = await netWorthHistory(db, "2026-06-30", 12);
      expect(history.length).toBeGreaterThanOrEqual(3);
      expect(history[history.length - 1]!.net_cents).toBe((await netWorth(db)).net_cents);
      expect(history.map((h) => h.date)).toEqual([...history.map((h) => h.date)].sort());
    });

    it("summarizes the month for the home page", async () => {
      const home = await overview(db, "2026-06-30");
      expect(home.cash_flow).toHaveLength(6);
      expect(home.month.month).toBe("2026-06");
      expect(home.month.spending_cents).toBeGreaterThan(0);
      expect(home.month.typical_month_cents).toBeGreaterThan(0);
      expect(home.recent).toHaveLength(8);
      expect(home.top_categories[0]!.category_id).toBe("housing.rent");
    });

    it("queues charges for review and clears them as they are handled", async () => {
      const deps = { db, now: () => new Date("2026-07-01T12:00:00Z"), newId: createIdFactory(() => 1, Math.random) };
      const before = await reviewCounts(db);
      expect(before.large).toBeGreaterThan(0);
      expect(before.uncategorized).toBeGreaterThan(0);
      expect(before.unfamiliar).toBeGreaterThan(0);

      const queue = await listTransactions(db, { review: "uncategorized", limit: 200 });
      expect(queue.total).toBe(before.uncategorized);
      const target = queue.rows.find((r) => r.review_reasons.length === 1)!;
      const history = await merchantHistory(db, target);
      expect(history.merchant).toBe(target.label);

      const updated = await updateTransaction(deps, target.id, { category_id: "shopping.general", note: "  Gift for Sam " });
      expect(updated.category_source).toBe("manual");
      expect(updated.note).toBe("Gift for Sam");
      expect(updated.review_reasons).toEqual([]);
      expect((await reviewCounts(db)).uncategorized).toBe(before.uncategorized - 1);
      expect((await listTransactions(db, { q: "gift for sam" })).rows[0]!.id).toBe(target.id);

      const large = (await listTransactions(db, { review: "large" })).rows[0]!;
      await updateTransaction(deps, large.id, { reviewed: true, flag: "suspicious" });
      const after = await reviewCounts(db);
      expect(after.flagged).toBe(1);
      expect((await listTransactions(db, { review: "flagged" })).rows[0]!.id).toBe(large.id);
      await updateTransaction(deps, large.id, { flag: "resolved" });
      expect((await reviewCounts(db)).flagged).toBe(0);

      // A refresh must not re-queue what was already reviewed or categorized by hand.
      await refreshReviewQueue(db, "2026-05-16");
      expect((await reviewCounts(db)).uncategorized).toBe(before.uncategorized - 1);
      expect((await listTransactions(db, { review: "all", limit: 500 })).rows.some((r) => r.id === large.id)).toBe(false);

      const changes = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM changes WHERE entity = 'transaction'");
      expect(changes[0]!.n).toBe(3);
      await expect(updateTransaction(deps, target.id, { category_id: "nope.nope" })).rejects.toThrow(/No category/);
      await expect(updateTransaction(deps, "missing", { note: "x" })).rejects.toThrow(/No transaction/);
      expect(await categorizeTransactions(deps, [target.id], "food.groceries")).toBe(1);
    });

    it("rolls back a failed transaction", async () => {
      const before = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM tags");
      await expect(
        db.transaction(async () => {
          await db.run("INSERT INTO tags (id, name) VALUES ('t1', 'one')");
          await db.run("INSERT INTO tags (id, name) VALUES ('t2', 'one')"); // violates UNIQUE
        }),
      ).rejects.toThrow();
      expect(await db.all("SELECT COUNT(*) AS n FROM tags")).toEqual(before);
    });

    it("reports changed row counts", async () => {
      await db.run("INSERT INTO tags (id, name) VALUES ('a', 'a'), ('b', 'b')");
      expect((await db.run("UPDATE tags SET name = name || '!' WHERE id IN ('a', 'b')")).changes).toBe(2);
      expect((await db.run("DELETE FROM tags WHERE id = 'nope'")).changes).toBe(0);
      await db.run("DELETE FROM tags");
    });

    it("enforces foreign keys", async () => {
      await expect(
        db.run("INSERT INTO balances (account_id, as_of, current_cents, source) VALUES ('missing', '2026-01-01', 1, 'manual')"),
      ).rejects.toThrow();
    });
  });
}
