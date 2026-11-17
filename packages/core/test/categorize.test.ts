import { beforeEach, describe, expect, it } from "vitest";
import {
  cashFlowByMonth,
  categorizeTransactions,
  type CoreDeps,
  createIdFactory,
  createRule,
  deleteRule,
  generateDemoData,
  listRules,
  markTransfer,
  settle,
  type SqlDriver,
  undo,
  unmarkTransfer,
  updateRule,
  updateTransaction,
} from "../src/index.ts";
import { openWasmDb } from "./helpers.ts";

type Deps = Pick<CoreDeps, "db" | "now" | "newId">;
let db: SqlDriver;
let deps: Deps;
let n = 0;

beforeEach(async () => {
  db = await openWasmDb();
  let tick = Date.parse("2026-11-10T12:00:00Z");
  const now = () => {
    tick += 1000;
    return new Date(tick);
  };
  deps = { db, now, newId: createIdFactory(() => tick, Math.random) };
  n = 0;
  await db.run("INSERT INTO connections (id, source, institution_name, status, created_at) VALUES ('c', 'file', 'Bank', 'ok', '2026-01-01T00:00:00Z')");
  const accounts: [string, string][] = [["chk", "depository"], ["sav", "depository"], ["card", "credit"], ["inv", "investment"]];
  for (const [id, type] of accounts) {
    await db.run(
      `INSERT INTO accounts (id, connection_id, owner_id, name, type, tax_treatment, feed, created_at)
       VALUES (?, 'c', (SELECT id FROM owners LIMIT 1), ?, ?, 'none', 'file', '2026-01-01T00:00:00Z')`,
      [id, id, type],
    );
  }
});

interface TxInput {
  account?: string;
  date?: string;
  cents: number;
  description: string;
  merchant?: string | null;
  primary?: string | null;
  detailed?: string | null;
  confidence?: string | null;
  pending?: boolean;
}

async function tx(t: TxInput): Promise<string> {
  const id = `t${String(++n).padStart(3, "0")}`;
  await db.run(
    `INSERT INTO transactions (id, account_id, source, external_id, pending, posted_date, amount_cents, description_raw,
       merchant_raw, plaid_pfc_primary, plaid_pfc_detailed, plaid_pfc_confidence, created_at, updated_at)
     VALUES (?, ?, 'plaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'x', 'x')`,
    [id, t.account ?? "card", id, t.pending ? 1 : 0, t.date ?? "2026-11-05", t.cents, t.description, t.merchant ?? null,
      t.primary ?? null, t.detailed ?? null, t.confidence ?? null],
  );
  return id;
}

const get = async (id: string) =>
  (await db.all<any>("SELECT t.*, g.kind FROM transactions t LEFT JOIN transfer_groups g ON g.id = t.transfer_group_id WHERE t.id = ?", [id]))[0];
const cat = async (id: string) => {
  const r = await get(id);
  return `${r.category_id}/${r.category_source}`;
};
const fuel = (cents = -4000, date = "2026-11-05") =>
  tx({ cents, date, description: "SPACE AGE #24 KING CITY OR", merchant: "Space Age Fuel", primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS", confidence: "VERY_HIGH" });

describe("the pipeline, in order", () => {
  it("uses Plaid only when confident, and queues the rest", async () => {
    const sure = await fuel();
    const unsure = await tx({ cents: -1500, description: "SQ *CORNER STAND", primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT", confidence: "LOW" });
    const vague = await tx({ account: "chk", cents: 5000, description: "VENMO", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_NOT_IN_OUR_MAP", confidence: "VERY_HIGH" });
    const result = await settle(deps);
    expect(await cat(sure)).toBe("transport.fuel/plaid");
    expect(await cat(unsure)).toBe("uncategorized.uncategorized/null");
    // "Some kind of transfer" alone is not enough to hide money from spending.
    expect(await cat(vague)).toBe("uncategorized.uncategorized/null");
    expect((await get(unsure)).needs_review).toBe(1);
    expect(JSON.parse((await get(unsure)).review_reasons)).toContain("uncategorized");
    // Those two, plus the fuel stop: a first charge from a merchant, over $25.
    expect(result.queued).toBe(3);
    expect((await get(sure)).review_reasons).toBe('["unfamiliar"]');
    expect((await settle(deps)).changed).toBe(0);
  });

  it("puts rules before memory before Plaid, and never touches a hand-set category", async () => {
    const a = await fuel();
    const b = await fuel(-5200, "2026-11-06");
    const c = await fuel(-900, "2026-11-07");
    await settle(deps);

    // By hand: locks this one and teaches the merchant.
    await updateTransaction(deps, a, { category_id: "travel.activities" });
    expect(await cat(a)).toBe("travel.activities/manual");
    expect(await cat(b)).toBe("travel.activities/memory");

    // A rule outranks memory, for everything not locked.
    const made = await createRule(deps, { match: { merchant_key: "space age fuel", amount_max_cents: 1000 }, category_id: "food.coffee" });
    expect(made).toMatchObject({ dry_run: false, changed: 1 });
    expect(await cat(c)).toBe("food.coffee/rule");
    expect((await get(c)).rule_id).toBe(made.rule!.id);
    expect((await listRules(db))[0]!.hit_count).toBe(1);
    expect(await cat(a)).toBe("travel.activities/manual");

    // Widening the rule still leaves the locked one alone; a re-sync style settle changes nothing.
    await updateRule(deps, made.rule!.id, { match: { merchant_key: "SPACE AGE FUEL" } });
    expect([await cat(a), await cat(b), await cat(c)]).toEqual(["travel.activities/manual", "food.coffee/rule", "food.coffee/rule"]);
    expect((await settle(deps)).changed).toBe(0);

    await deleteRule(deps, made.rule!.id);
    expect(await cat(c)).toBe("travel.activities/memory");
  });

  it("a merchant that gets two different hand categories has no default", async () => {
    const a = await fuel();
    const b = await fuel(-5200);
    const c = await fuel(-900);
    await settle(deps);
    await updateTransaction(deps, a, { category_id: "travel.activities" });
    await updateTransaction(deps, b, { category_id: "food.groceries" });
    expect(await cat(c)).toBe("transport.fuel/plaid");
    // Payment apps and everything-stores never teach a default at all.
    const v1 = await tx({ account: "chk", cents: -2000, description: "VENMO" });
    const v2 = await tx({ account: "chk", cents: -3000, description: "VENMO" });
    await settle(deps);
    await updateTransaction(deps, v1, { category_id: "food.restaurants" });
    expect(await cat(v2)).toBe("uncategorized.uncategorized/null");
  });
});

describe("rules", () => {
  it("dry run reports what would change and writes nothing", async () => {
    await fuel();
    await fuel(-5200);
    await settle(deps);
    const dry = await createRule(deps, { match: { description_regex: "^space age" }, category_id: "travel.activities" }, { dryRun: true });
    expect(dry).toMatchObject({ dry_run: true, changed: 2 });
    expect(dry.sample[0]).toMatchObject({ from: "transport.fuel", to: "travel.activities" });
    expect(await listRules(db)).toHaveLength(0);
    expect(await db.all("SELECT 1 FROM changes")).toHaveLength(0);
  });

  it("matches on every field given, and tries lower priority numbers first", async () => {
    const big = await tx({ account: "chk", cents: -90_000, description: "ACH DEBIT LANDLORD LLC" });
    const small = await tx({ account: "chk", cents: -4000, description: "ACH DEBIT LANDLORD LLC" });
    const refund = await tx({ account: "chk", cents: 4000, description: "ACH CREDIT LANDLORD LLC" });
    await createRule(deps, { match: { description_contains: "landlord" }, category_id: "housing.maintenance", priority: 200 });
    await createRule(deps, { match: { description_contains: "LANDLORD", direction: "out", amount_min_cents: 50_000, account_id: "chk" }, category_id: "housing.rent", priority: 10 });
    expect([await cat(big), await cat(small), await cat(refund)]).toEqual([
      "housing.rent/rule",
      "housing.maintenance/rule",
      "housing.maintenance/rule",
    ]);
  });

  it("rejects rules it can't make sense of", async () => {
    const bad = (match: unknown, category_id = "food.coffee") => createRule(deps, { match, category_id });
    await expect(bad({})).rejects.toThrow(/at least one/);
    await expect(bad({ description_regex: "(" })).rejects.toThrow(/regular expression/);
    await expect(bad({ merchant: "x" })).rejects.toThrow(/Unknown match field/);
    await expect(bad({ direction: "sideways" })).rejects.toThrow(/in or out/);
    await expect(bad({ amount_min_cents: 5, amount_max_cents: 1 })).rejects.toThrow(/larger/);
    await expect(bad({ merchant_key: "X" }, "nope.nope")).rejects.toThrow(/No category/);
  });
});

describe("transfers", () => {
  const out = (cents: number, description: string, date = "2026-11-05", account = "chk", extra: Partial<TxInput> = {}) =>
    tx({ account, cents, description, date, primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", confidence: "LOW", ...extra });
  const into = (cents: number, description: string, date = "2026-11-05", account = "sav", extra: Partial<TxInput> = {}) =>
    tx({ account, cents, description, date, primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", confidence: "LOW", ...extra });

  it("pairs both sides and names the kind from the accounts", async () => {
    const a = await out(-60_000, "Withdrawal to Savings XXXX4382");
    const b = await into(60_000, "Deposit from Checking XXXX7603", "2026-11-06");
    const pay = await tx({ account: "chk", cents: -12_345, description: "CAPITAL ONE AUTOPAY PYMT", primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", confidence: "HIGH" });
    const got = await tx({ account: "card", cents: 12_345, description: "AUTOMATIC PAYMENT - THANK", date: "2026-11-07", primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", confidence: "HIGH" });
    const fund = await out(-50_000, "FIDELITY MONEYLINE", "2026-11-05", "chk");
    const recv = await tx({ account: "inv", cents: 50_000, description: "ELECTRONIC FUNDS TRANSFER RECEIVED", date: "2026-11-08" }); // file row, no Plaid category
    const result = await settle(deps);
    expect(result.pairs_made).toBe(3);
    expect([(await get(a)).kind, (await get(pay)).kind, (await get(fund)).kind]).toEqual(["internal_transfer", "card_payment", "investment_contribution"]);
    expect((await get(a)).transfer_group_id).toBe((await get(b)).transfer_group_id);
    expect([await cat(a), await cat(got), await cat(recv)]).toEqual(["transfers.internal/transfer", "transfers.card-payment/transfer", "transfers.investment/transfer"]);
    // Transfers are never queued for review, however large.
    expect((await get(a)).review_reasons).toBeNull();
  });

  it("never pairs a purchase with an unrelated credit of the same amount", async () => {
    const dinner = await tx({ cents: -2000, description: "SQ *NOODLE BAR", primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT", confidence: "LOW" });
    const venmo = await into(2000, "VENMO", "2026-11-05", "chk");
    const interest = await tx({ account: "sav", cents: 700, description: "INTEREST PAYMENT" });
    const fee = await tx({ account: "chk", cents: -700, description: "MONTHLY FEE PAYMENT" });
    expect((await settle(deps)).pairs_made).toBe(0);
    for (const id of [dinner, venmo, interest, fee]) expect((await get(id)).transfer_group_id).toBeNull();
  });

  it("prefers the closest dates, ignores pending and anything outside four days", async () => {
    const o1 = await out(-10_000, "TRANSFER TO SAVINGS", "2026-11-01");
    const o2 = await out(-10_000, "TRANSFER TO SAVINGS", "2026-11-10");
    const i1 = await into(10_000, "TRANSFER FROM CHECKING", "2026-11-11");
    const late = await into(10_000, "TRANSFER FROM CHECKING", "2026-11-06");
    const pend = await into(10_000, "TRANSFER FROM CHECKING", "2026-11-01", "sav", { pending: true });
    await settle(deps);
    expect((await get(o2)).transfer_group_id).toBe((await get(i1)).transfer_group_id);
    expect((await get(o1)).transfer_group_id).toBeNull(); // five days from `late`
    expect((await get(late)).transfer_group_id).toBeNull();
    expect((await get(pend)).transfer_group_id).toBeNull();
  });

  it("treats a lone card payment as one, but not a reward or refund on the card", async () => {
    const toUntracked = await tx({ account: "chk", cents: -30_000, description: "DISCOVER", primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", confidence: "LOW" });
    const received = await tx({ account: "card", cents: 45_000, description: "DIRECTPAY FULL BALANCE", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_OTHER_TRANSFER_IN", confidence: "LOW" });
    const reward = await tx({ account: "card", cents: 2500, description: "CREDIT-CASH BACK REWARD", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_OTHER_TRANSFER_IN", confidence: "LOW" });
    await settle(deps);
    expect([await cat(toUntracked), await cat(received)]).toEqual(["transfers.card-payment/transfer", "transfers.card-payment/transfer"]);
    expect(await cat(reward)).toBe("uncategorized.uncategorized/null");
  });

  it("drops an automatic pair when a side is removed, and re-pairs what is left", async () => {
    const a = await out(-8000, "TRANSFER TO SAVINGS");
    const b = await into(8000, "TRANSFER FROM CHECKING");
    await settle(deps);
    await db.run("UPDATE transactions SET removed_at = 'x' WHERE id = ?", [b]);
    const b2 = await into(8000, "TRANSFER FROM CHECKING", "2026-11-06");
    const result = await settle(deps);
    expect(result).toMatchObject({ pairs_dissolved: 1, pairs_made: 1 });
    expect((await get(a)).transfer_group_id).toBe((await get(b2)).transfer_group_id);
    expect(await db.all("SELECT 1 FROM transfer_groups")).toHaveLength(1);
  });

  it("pairs by hand, survives settling, and unpairs for good", async () => {
    const a = await tx({ account: "chk", cents: -5000, description: "CHECK 1042" });
    const b = await tx({ account: "sav", cents: 5000, description: "MOBILE DEPOSIT", date: "2026-11-20" });
    await settle(deps);
    const marked = await markTransfer(deps, [a, b]);
    expect(marked.kind).toBe("internal_transfer");
    expect(await cat(a)).toBe("transfers.internal/manual");
    await settle(deps);
    expect((await get(a)).transfer_group_id).toBe((await get(b)).transfer_group_id);

    await undo(deps, marked.batch_id);
    expect((await get(a)).transfer_group_id).toBeNull();
    expect(await cat(a)).toBe("uncategorized.uncategorized/null");
    expect(await db.all("SELECT 1 FROM transfer_groups")).toHaveLength(0);

    // An automatic pair, unpaired by hand, stays unpaired.
    const o = await tx({ account: "chk", cents: -900, description: "TRANSFER TO SAVINGS" });
    const i = await tx({ account: "sav", cents: 900, description: "TRANSFER FROM CHECKING" });
    await settle(deps);
    expect((await get(o)).transfer_group_id).not.toBeNull();
    await unmarkTransfer(deps, o);
    expect([(await get(o)).transfer_group_id, (await get(i)).transfer_group_id]).toEqual([null, null]);
    expect(await cat(i)).toBe("uncategorized.uncategorized/manual");
    await expect(unmarkTransfer(deps, o)).rejects.toThrow(/isn't part of a transfer/);
  });

  it("a hand-set category takes one side out of its pair", async () => {
    const o = await tx({ account: "chk", cents: -900, description: "TRANSFER TO SAVINGS" });
    const i = await tx({ account: "sav", cents: 900, description: "TRANSFER FROM CHECKING" });
    await settle(deps);
    const edit = await categorizeTransactions(deps, [o], "personal.charity");
    expect([(await get(o)).transfer_group_id, (await get(i)).transfer_group_id]).toEqual([null, null]);
    expect(await cat(i)).toBe("uncategorized.uncategorized/null");
    await undo(deps, edit.batch_id);
    expect((await get(o)).transfer_group_id).toBe((await get(i)).transfer_group_id);
    expect(await cat(o)).toBe("transfers.internal/transfer");
  });
});

describe("undo", () => {
  it("reverses a bulk recategorization with its rule and merchant memory", async () => {
    const ids = [await fuel(), await fuel(-5200), await fuel(-900)];
    const other = await fuel(-700, "2026-11-09");
    await settle(deps);
    const edit = await categorizeTransactions(deps, ids.slice(0, 2), "travel.activities", "claude", { createRule: true });
    expect(edit.rules).toHaveLength(1);
    expect(edit.rules[0]).toMatchObject({ match: { merchant_key: "SPACE AGE FUEL" }, origin: "claude" });
    expect([await cat(ids[0]!), await cat(ids[2]!), await cat(other)]).toEqual(["travel.activities/claude", "travel.activities/rule", "travel.activities/rule"]);

    const result = await undo(deps, edit.batch_id);
    expect(result.skipped).toEqual([]);
    expect(result.undone).toHaveLength(edit.change_ids.length);
    for (const id of [...ids, other]) expect(await cat(id)).toBe("transport.fuel/plaid");
    expect(await listRules(db)).toHaveLength(0);
    expect((await db.all<any>("SELECT default_category_id FROM merchants"))[0].default_category_id).toBeNull();
    expect((await undo(deps, edit.batch_id)).undone).toEqual([]);
  });

  it("skips what was changed again afterwards, and says so", async () => {
    const a = await fuel();
    const b = await fuel(-5200);
    await settle(deps);
    const first = await categorizeTransactions(deps, [a, b], "travel.activities", "user", { remember: false });
    await updateTransaction(deps, a, { category_id: "food.coffee" }, "user", { remember: false });
    const result = await undo(deps, first.batch_id);
    expect(result.undone).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/changed again/);
    expect([await cat(a), await cat(b)]).toEqual(["food.coffee/manual", "transport.fuel/plaid"]);
  });

  it("restores a deleted rule and a changed note, and can undo one change by its id", async () => {
    const a = await fuel();
    const made = await createRule(deps, { match: { merchant_key: "SPACE AGE FUEL" }, category_id: "food.coffee" });
    const gone = await deleteRule(deps, made.rule!.id);
    expect(await cat(a)).toBe("transport.fuel/plaid");
    await undo(deps, gone.change_ids![0]!);
    expect(await cat(a)).toBe("food.coffee/rule");
    expect((await listRules(db))[0]).toMatchObject({ id: made.rule!.id, hit_count: 1 });

    await updateTransaction(deps, a, { note: "first", excluded: true });
    const batch = (await db.all<any>("SELECT batch_id FROM changes ORDER BY rowid DESC LIMIT 1"))[0].batch_id;
    await undo(deps, batch);
    expect(await get(a)).toMatchObject({ note: null, excluded: 0 });
    await expect(undo(deps, "nope")).rejects.toThrow(/No change or batch/);
  });
});

describe("money in with no category yet", () => {
  it("is left out of spending and income until it's filed, and never makes spending negative", async () => {
    const pay = await tx({ account: "chk", cents: 400_000, description: "ACME CORP DIR DEP", primary: "INCOME", detailed: "INCOME_SALARY", confidence: "LOW" });
    await tx({ account: "chk", cents: -3000, description: "SQ *CORNER STAND", confidence: "LOW" }); // uncategorized money out still counts
    await fuel(-4000);
    await settle(deps);
    const month = async () => (await cashFlowByMonth(db, "2026-11", "2026-11"))[0]!;
    expect(await month()).toMatchObject({ spending_cents: 7000, income_cents: 0 });
    await updateTransaction(deps, pay, { category_id: "income.paycheck" });
    expect(await month()).toMatchObject({ spending_cents: 7000, income_cents: 400_000 });
  });
});

describe("the synthetic data (M4 acceptance)", () => {
  it("categorizes at least 90% without the queue and pairs every transfer and card payment", async () => {
    const summary = await generateDemoData(db);
    const one = async (sql: string) => (await db.all<{ n: number }>(sql))[0]!.n;
    const queued = await one("SELECT COUNT(*) AS n FROM transactions WHERE category_id = 'uncategorized.uncategorized'");
    expect(queued / summary.transactions).toBeLessThan(0.1);
    // Every card payment and internal transfer was found by the matcher, none by memory.
    expect(await one("SELECT COUNT(*) AS n FROM transactions WHERE category_id IN ('transfers.internal', 'transfers.card-payment') AND transfer_group_id IS NULL")).toBe(0);
    expect(await one("SELECT COUNT(*) AS n FROM transactions WHERE (description_raw LIKE '%PAYMENT%' AND description_raw NOT LIKE 'INTEREST%' OR description_raw LIKE 'TRANSFER %') AND transfer_group_id IS NULL")).toBe(0);
    expect(await one("SELECT COUNT(*) AS n FROM (SELECT transfer_group_id FROM transactions WHERE transfer_group_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) != 2 OR SUM(amount_cents) != 0)")).toBe(0);
    // A large purchase, a first-time merchant and an unusual amount are in Review; no transfer is.
    const reasons = (await db.all<{ review_reasons: string }>("SELECT review_reasons FROM transactions WHERE review_reasons IS NOT NULL")).map((r) => r.review_reasons).join();
    for (const reason of ["large", "unfamiliar", "unusual", "uncategorized"]) expect(reasons).toContain(reason);
    expect(await one("SELECT COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.kind IN ('transfer', 'investment') AND t.review_reasons IS NOT NULL")).toBe(0);
    expect((await settle(deps)).changed).toBe(0);
  });
});
