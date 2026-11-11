import { beforeAll, describe, expect, it } from "vitest";
import {
  ALL_CATEGORY_IDS,
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
