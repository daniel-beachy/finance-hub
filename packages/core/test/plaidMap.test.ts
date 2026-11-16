import { describe, expect, it } from "vitest";
import { plaidCategoryMapFixes } from "../src/db/migrations/0004_plaid_category_map.ts";
import { PLAID_CATEGORY_MAP } from "../src/seed/plaidCategoryMap.ts";
import { openWasmDb } from "./helpers.ts";

describe("plaid_category_map", () => {
  it("points every key at a real category", async () => {
    const db = await openWasmDb();
    const ids = new Set((await db.all<{ id: string }>("SELECT id FROM categories")).map((r) => r.id));
    for (const [key, id] of Object.entries(PLAID_CATEGORY_MAP)) expect(ids.has(id), `${key} -> ${id}`).toBe(true);
  });

  it("knows Plaid's v2 names alongside the v1 ones", () => {
    expect(PLAID_CATEGORY_MAP.INCOME_SALARY).toBe("income.paycheck");
    expect(PLAID_CATEGORY_MAP.INCOME_WAGES).toBe("income.paycheck");
    expect(PLAID_CATEGORY_MAP.INCOME_CONTRACTOR).toBe("income.other");
    expect(PLAID_CATEGORY_MAP.LOAN_DISBURSEMENTS_PERSONAL).toBe("transfers.loan-principal");
    expect(PLAID_CATEGORY_MAP.BANK_FEES_LATE_FEES).toBe("financial.fees");
  });

  it("leaves app transfers, wires, crypto, withdrawals and OTHER for Review", () => {
    for (const key of [
      "TRANSFER_IN_TRANSFER_IN_FROM_APPS",
      "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",
      "TRANSFER_IN_WIRE",
      "TRANSFER_OUT_WIRE",
      "TRANSFER_OUT_CRYPTO",
      "TRANSFER_OUT_WITHDRAWAL",
      "OTHER",
      "OTHER_OTHER",
    ]) {
      expect(PLAID_CATEGORY_MAP[key], key).toBeUndefined();
    }
  });

  it("migration 0004 fixes a database seeded with the old map, and the seed then adds the new keys", async () => {
    const db = await openWasmDb();
    // Put back the rows as the first seed wrote them.
    await db.run("UPDATE plaid_category_map SET category_id = 'financial.taxes' WHERE pfc_key = 'GOVERNMENT_AND_NON_PROFIT'");
    await db.run("UPDATE plaid_category_map SET category_id = 'transfers.internal' WHERE pfc_key = 'TRANSFER_IN_CASH_ADVANCES_AND_LOANS'");
    await db.run("INSERT INTO plaid_category_map (pfc_key, category_id) VALUES ('TRANSFER_OUT_WITHDRAWAL', 'shopping.general')");
    await db.exec(plaidCategoryMapFixes);
    const map = new Map((await db.all<{ pfc_key: string; category_id: string }>("SELECT * FROM plaid_category_map")).map((r) => [r.pfc_key, r.category_id]));
    expect(map.get("GOVERNMENT_AND_NON_PROFIT")).toBe("financial.fees");
    expect(map.get("TRANSFER_IN_CASH_ADVANCES_AND_LOANS")).toBe("transfers.loan-principal");
    expect(map.has("TRANSFER_OUT_WITHDRAWAL")).toBe(false);
    expect(map.get("INCOME_SALARY")).toBe("income.paycheck");
    expect(map.size).toBe(Object.keys(PLAID_CATEGORY_MAP).length);
  });
});
