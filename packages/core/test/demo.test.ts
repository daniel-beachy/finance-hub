import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { createWasmDriver, generateDemoData, migrate } from "../src/index.ts";

async function build(seed: number): Promise<{ bytes: Uint8Array; transactions: number }> {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  const db = createWasmDriver(database);
  await migrate(db, () => new Date("2026-11-01T12:00:00Z"));
  const summary = await generateDemoData(db, { seed });
  return { bytes: database.export(), transactions: summary.transactions };
}

describe("synthetic data", () => {
  it("produces at least 5,000 transactions, byte-identical for the same seed", async () => {
    const a = await build(42);
    const b = await build(42);
    const c = await build(43);
    expect(a.transactions).toBeGreaterThanOrEqual(5000);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(c.bytes))).toBe(false);
  });

  it("keeps the household solvent and the transfers paired", async () => {
    const SQL = await initSqlJs();
    const db = createWasmDriver(new SQL.Database());
    await migrate(db);
    await generateDemoData(db);
    const low = await db.all<{ low: number }>(
      `SELECT MIN(b.current_cents) AS low FROM balances b JOIN accounts a ON a.id = b.account_id
       WHERE a.type = 'depository'`,
    );
    expect(low[0]!.low).toBeGreaterThan(0);
    const transfers = await db.all<{ total: number }>(
      `SELECT SUM(amount_cents) AS total FROM transactions
       WHERE category_id IN ('transfers.internal', 'transfers.card-payment')`,
    );
    expect(transfers[0]!.total).toBe(0);
    const real = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM connections WHERE source = 'plaid'",
    );
    expect(real[0]!.n).toBe(0);
  });
});
