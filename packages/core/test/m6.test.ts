import { beforeEach, describe, expect, it } from "vitest";
import {
  addMonths,
  budgetStatus,
  type Charge,
  type CoreDeps,
  createApp,
  createMcpServer,
  detectSeries,
  dismissAlerts,
  generateDemoData,
  listAlerts,
  listRecurring,
  setBudget,
  settle,
  shiftMonth,
  spendingSummary,
  undo,
  updateRecurring,
  weeklyDigest,
} from "../src/index.ts";
import { addDays } from "../src/util/money.ts";
import { makeDeps } from "./helpers.ts";

// --- detection, on hand-made charges ----------------------------------------

let n = 0;
const charge = (date: string, cents: number, merchant = "M1", account = "A1", category: string | null = "entertainment.streaming"): Charge => ({
  id: `t${String(++n).padStart(5, "0")}`,
  account_id: account,
  merchant,
  merchant_id: merchant,
  label: merchant,
  date,
  cents,
  category_id: category,
});
const monthly = (start: string, count: number, cents: number | ((i: number) => number), merchant = "M1") =>
  Array.from({ length: count }, (_, i) => charge(addMonths(start, i), typeof cents === "number" ? cents : cents(i), merchant));

describe("recurring detection", () => {
  it("finds a monthly subscription and when it's next due", () => {
    const [s] = detectSeries(monthly("2026-01-31", 5, -1099));
    expect(s).toMatchObject({ cadence: "monthly", amount_cents: -1099, first_date: "2026-01-31", last_date: "2026-05-31", next_expected_date: "2026-06-30" });
    expect(s!.charges).toHaveLength(5);
    expect(s!.previous_amount_cents).toBeNull();
  });

  it("finds weekly, biweekly, quarterly and yearly cadences", () => {
    const weekly = Array.from({ length: 4 }, (_, i) => charge(addDays("2026-03-02", i * 7), -500, "W"));
    const biweekly = Array.from({ length: 4 }, (_, i) => charge(addDays("2026-03-02", i * 14), -4000, "B"));
    const quarterly = Array.from({ length: 3 }, (_, i) => charge(addMonths("2025-11-15", i * 3), -6000, "Q"));
    const yearly = Array.from({ length: 3 }, (_, i) => charge(addMonths("2023-04-10", i * 12), -9900, "Y"));
    const found = Object.fromEntries(detectSeries([...weekly, ...biweekly, ...quarterly, ...yearly]).map((s) => [s.label, s.cadence]));
    expect(found).toEqual({ W: "weekly", B: "biweekly", Q: "quarterly", Y: "yearly" });
  });

  it("needs three charges", () => {
    expect(detectSeries(monthly("2026-01-05", 2, -1099))).toEqual([]);
  });

  it("follows a price step bigger than 15% and remembers the old price", () => {
    const [s] = detectSeries(monthly("2026-01-05", 6, (i) => (i < 4 ? -1000 : -1300)));
    expect(s).toMatchObject({ amount_cents: -1300, previous_amount_cents: -1000, price_changed_on: "2026-05-05" });
    expect(s!.charges).toHaveLength(6);
  });

  it("treats a bill that varies as one series when it's all the merchant charges", () => {
    const amounts = [-6100, -14200, -9000, -7300, -12500];
    expect(detectSeries(monthly("2026-01-18", 5, (i) => amounts[i]!))).toHaveLength(1);
    // Three fill-ups that happen to fall two weeks apart are chance, not a bill.
    const fuel = [["2026-09-06", -4120], ["2026-09-21", -3990], ["2026-10-05", -2210]] as const;
    expect(detectSeries(fuel.map(([d, c]) => charge(d, c, "FUEL")))).toEqual([]);
    // Nor are fill-ups that kept a steady gap once, among others that didn't.
    const more = [["2025-03-11", -5150], ["2025-06-24", -2870], ...fuel, ["2026-10-30", -3340]] as const;
    expect(detectSeries(more.map(([d, c]) => charge(d, c, "FUEL2")))).toEqual([]);
    // But not when the amounts spread more than three times.
    expect(detectSeries(monthly("2026-01-18", 4, (i) => [-1000, -5000, -1200, -900][i]!))).toEqual([]);
  });

  it("finds an exact-price membership at a store that sells other things, with a fourth charge", () => {
    const store = (cents: number[]) => [
      ...monthly("2026-01-03", cents.length, (i) => cents[i]!, "STORE"),
      ...["2026-01-09", "2026-01-20", "2026-02-11", "2026-03-14", "2026-03-15", "2026-04-22"].map((d, i) => charge(d, -(2300 + i * 517), "STORE")),
    ];
    expect(detectSeries(store([-1499, -1499, -1499, -1499]))).toMatchObject([{ cadence: "monthly", amount_cents: -1499 }]);
    // Three equal charges among other purchases could be chance.
    expect(detectSeries(store([-1499, -1499, -1499]))).toEqual([]);
  });

  it("ignores a frequent merchant with one price and the same price at uneven gaps", () => {
    const fares = Array.from({ length: 40 }, (_, i) => charge(addDays("2026-03-02", Math.floor(i / 2)), -275, "FARE"));
    const wash = ["2026-01-01", "2026-01-19", "2026-03-01"].map((d) => charge(d, -1200, "WASH"));
    expect(detectSeries([...fares, ...wash])).toEqual([]);
  });

  it("judges a restarted series on its latest run", () => {
    const old = monthly("2025-01-10", 4, -999);
    const fresh = monthly("2025-11-10", 3, -999);
    const [s] = detectSeries([...old, ...fresh]);
    expect(s).toMatchObject({ first_date: "2025-11-10", last_date: "2026-01-10" });
  });

  it("keeps charges on different accounts apart and leaves money in out", () => {
    const a = monthly("2026-01-05", 3, -1099);
    const b = monthly("2026-01-05", 3, -1099).map((c) => ({ ...c, account_id: "A2" }));
    const refunds = monthly("2026-01-05", 3, 1099, "R");
    expect(detectSeries([...a, ...b, ...refunds]).map((s) => s.account_id).sort()).toEqual(["A1", "A2"]);
  });
});

// --- on the demo household --------------------------------------------------

let deps: CoreDeps;
const TODAY = "2026-11-10";

async function demo() {
  ({ deps } = await makeDeps(undefined));
  await generateDemoData(deps.db);
}

const alertKinds = async () =>
  (await listAlerts(deps.db)).map((a) => `${a.kind}: ${a.message}`).sort();

describe("M6 on the demo household", () => {
  beforeEach(demo);

  it("detects every planted subscription and bill, and nothing that isn't one", async () => {
    const series = await listRecurring(deps.db, TODAY);
    const active = series.filter((s) => s.status === "active");
    const subscriptions = active.filter((s) => s.is_subscription).map((s) => s.label).sort();
    expect(subscriptions).toEqual(["CloudNest", "FitLoop", "Lumen AI", "Pixel Arcade", "Streamly", "The Daily Ledger", "Tunebox", "Wavelength Radio"]);
    const bills = active.filter((s) => !s.is_subscription).map((s) => s.label).sort();
    expect(bills).toEqual(["Brightgrid Energy", "City Water & Waste", "Clearwave Mobile", "Fiberline", "PetPal Insurance", "Willow Creek Apartments"]);
    for (const s of active) expect(s.cadence).toBe("monthly");
    // Look-alikes: a car wash at one price but uneven gaps, the daily fares.
    for (const label of ["Sparkwash", "Metroline Transit", "Kettle & Crow Coffee"]) expect(series.map((s) => s.label)).not.toContain(label);
    const streamly = series.find((s) => s.label === "Streamly")!;
    expect(streamly).toMatchObject({ amount_cents: -1799, previous_amount_cents: -1599, price_changed_on: "2026-10-05", yearly_cents: -1799 * 12 });
    expect(series.find((s) => s.label === "PetPal Insurance")!.late).toBe(true);
  });

  it("raises exactly the planted alerts, with no false duplicate", async () => {
    expect(await alertKinds()).toEqual([
      "duplicate: Blue Door Pizza charged $42.50 on 2026-10-29 and again on 2026-10-30, both on Harbor Rewards Card.",
      "fee: $12.00 on Everyday Checking: MONTHLY MAINTENANCE FEE.",
      "large: $1,899.00 at Volt Electronics, over 3 times its usual $52.13.",
      "missed_recurring: PetPal Insurance usually charges $24.50 a month and was due 2026-11-01, but nothing has arrived. Cancelled, or a card change?",
      "new_merchant: Qk Zrx Holdings charged $49.99 on 2026-11-02, the first charge from them.",
      "new_subscription: Wavelength Radio, $8.99 a month since 2026-08-28.",
      "price_increase: Streamly went up from $15.99 to $17.99 a month.",
    ]);
  });

  it("keeps a dismissed alert dismissed, and undo brings it back", async () => {
    const dup = (await listAlerts(deps.db)).find((a) => a.kind === "duplicate")!;
    const r = await dismissAlerts(deps, [dup.id]);
    expect(r.dismissed).toBe(1);
    await settle(deps);
    expect((await listAlerts(deps.db)).map((a) => a.id)).not.toContain(dup.id);
    expect((await listAlerts(deps.db, { includeDismissed: true })).find((a) => a.id === dup.id)!.dismissed_at).not.toBeNull();
    await undo(deps, r.batch_id);
    expect((await listAlerts(deps.db)).map((a) => a.id)).toContain(dup.id);
  });

  it("takes an open alert away when its reason goes", async () => {
    const dup = (await listAlerts(deps.db)).find((a) => a.kind === "duplicate")!;
    await deps.db.run("UPDATE transactions SET removed_at = ? WHERE id = ?", ["2026-11-10T00:00:00Z", dup.transaction_id]);
    await settle(deps);
    expect((await listAlerts(deps.db)).some((a) => a.kind === "duplicate")).toBe(false);
  });

  it("lets a person ignore a series, keeps it through detection, and undoes", async () => {
    const streamly = (await listRecurring(deps.db, TODAY)).find((s) => s.label === "Streamly")!;
    const r = await updateRecurring(deps, streamly.id, { status: "ignored" });
    expect((await listRecurring(deps.db, TODAY)).find((s) => s.id === streamly.id)!.status).toBe("ignored");
    expect((await listAlerts(deps.db)).some((a) => a.kind === "price_increase")).toBe(false);
    await settle(deps);
    expect((await listRecurring(deps.db, TODAY)).find((s) => s.id === streamly.id)).toMatchObject({ status: "ignored", status_set_by: "user" });

    const pet = (await listRecurring(deps.db, TODAY)).find((s) => s.label === "PetPal Insurance")!;
    await updateRecurring(deps, pet.id, { is_subscription: true });
    await settle(deps);
    expect((await listRecurring(deps.db, TODAY)).find((s) => s.id === pet.id)!.is_subscription).toBe(1);

    await undo(deps, r.batch_id);
    expect((await listRecurring(deps.db, TODAY)).find((s) => s.id === streamly.id)).toMatchObject({ status: "active", status_set_by: null });
  });

  it("keeps a series' id when detection runs again", async () => {
    const before = (await listRecurring(deps.db, TODAY)).map((s) => `${s.id} ${s.label}`).sort();
    await settle(deps);
    expect((await listRecurring(deps.db, TODAY)).map((s) => `${s.id} ${s.label}`).sort()).toEqual(before);
  });

  it("shows budget spending equal to spending_summary for the same month", async () => {
    for (const month of ["2026-11", "2026-10", "2026-07"]) {
      const status = await budgetStatus(deps.db, month, TODAY);
      const end = month === "2026-11" ? TODAY : addDays(`${shiftMonth(month, 1)}-01`, -1);
      const summary = await spendingSummary(deps.db, { from: `${month}-01`, to: end, groupBy: "category" });
      expect(status.totals.spent_cents).toBe(-summary.total_cents);
      const byCategory = Object.fromEntries(summary.rows.map((r) => [r.key, -r.total_cents]));
      for (const line of status.lines) expect(line.spent_cents).toBe(byCategory[line.category_id] ?? 0);
      expect(status.totals.budgeted_spent_cents + status.totals.unbudgeted_spent_cents).toBe(status.totals.spent_cents);
    }
  });

  it("carries rollover from the month the budget was set", async () => {
    // Shopping: $350 a month with rollover, set in 2026-05.
    const spent = async (month: string) => {
      const s = await spendingSummary(deps.db, { from: `${month}-01`, to: addDays(`${shiftMonth(month, 1)}-01`, -1), groupBy: "category" });
      return -(s.rows.find((r) => r.key === "shopping.general")?.total_cents ?? 0);
    };
    let carry = 0;
    for (const month of ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]) carry += 35_000 - (await spent(month));
    const line = (await budgetStatus(deps.db, "2026-11", TODAY)).lines.find((l) => l.category_id === "shopping.general")!;
    expect(line).toMatchObject({ rollover: true, carried_cents: carry, available_cents: 35_000 + carry, source: "default" });
    // The first month carries nothing in.
    expect((await budgetStatus(deps.db, "2026-05", TODAY)).lines.find((l) => l.category_id === "shopping.general")!.carried_cents).toBe(0);
    // Groceries has no rollover.
    expect((await budgetStatus(deps.db, "2026-11", TODAY)).lines.find((l) => l.category_id === "food.groceries")!.carried_cents).toBe(0);
  });

  it("sets, overrides, removes and undoes budgets", async () => {
    const coffee = async (month: string) => (await budgetStatus(deps.db, month, TODAY)).lines.find((l) => l.category_id === "food.coffee")!;
    const a = await setBudget(deps, { category_id: "food.coffee", month: "2026-11", amount_cents: 20_000 });
    expect(await coffee("2026-11")).toMatchObject({ budget_cents: 20_000, source: "month" });
    expect(await coffee("2026-10")).toMatchObject({ budget_cents: 14_000, source: "default" });
    const b = await setBudget(deps, { category_id: "food.coffee", month: null, amount_cents: null });
    expect(await coffee("2026-10")).toMatchObject({ budget_cents: null });
    await undo(deps, b.batch_id);
    expect(await coffee("2026-10")).toMatchObject({ budget_cents: 14_000 });
    await undo(deps, a.batch_id);
    expect(await coffee("2026-11")).toMatchObject({ budget_cents: 14_000, source: "default" });
    await expect(setBudget(deps, { category_id: "income.paycheck", month: null, amount_cents: 100 })).rejects.toThrow(/spending categories/);
    await expect(setBudget(deps, { category_id: "food.coffee", month: "2026-13", amount_cents: 100 })).rejects.toThrow(/month/);
    await expect(setBudget(deps, { category_id: "food.coffee", month: null, amount_cents: 1.5 })).rejects.toThrow(/whole number/);
  });

  it("builds the weekly digest from the same numbers as everything else", async () => {
    const d = await weeklyDigest(deps.db, TODAY);
    expect(d).toMatchObject({ from: "2026-11-04", to: TODAY });
    const week = await spendingSummary(deps.db, { from: d.from, to: d.to, groupBy: "group" });
    expect(d.spending_cents).toBe(-week.total_cents);
    const prior = await spendingSummary(deps.db, { from: addDays(d.from, -56), to: addDays(d.from, -1), groupBy: "group" });
    expect(Math.abs(d.average_weekly_cents - -prior.total_cents / 8)).toBeLessThanOrEqual(d.groups.length);
    expect(d.largest.map((c) => c.amount_cents)).toEqual([...d.largest.map((c) => c.amount_cents)].sort((x, y) => x - y));
    expect(d.new_merchants.map((m) => m.merchant)).toContain("MONTHLY MAINTENANCE FEE");
    expect(d.alerts).toHaveLength(7);
    expect(d.budget).not.toBeNull();
    for (const u of d.upcoming) expect(u.date >= TODAY && u.date <= addDays(TODAY, 14)).toBe(true);
    expect(d.upcoming.map((u) => u.label)).toContain("PetPal Insurance");
  });
});

describe("M6 through Claude and the API", () => {
  beforeEach(demo);

  async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const server = createMcpServer({ read: deps.db, deps });
    const r = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
    if (r.result.isError) throw new Error(r.result.content[0].text);
    return JSON.parse(r.result.content[0].text);
  }

  it("answers budget, recurring, alert and digest questions", async () => {
    const budget = await tool("budget_status", { month: "2026-10" });
    expect(budget.month).toBe("2026-10");
    expect(budget.elapsed).toBe(1);
    const recurring = await tool("recurring_list", { days: 14 });
    expect(recurring.series.find((s: any) => s.merchant === "Streamly")).toMatchObject({ previous_amount_cents: -1599, subscription: true });
    expect(recurring.yearly_total_cents).toBeLessThan(0);
    const charges = await tool("recurring_list", { series_id: recurring.series[0].id });
    expect(charges.charges.length).toBeGreaterThanOrEqual(3);
    expect((await tool("alerts_list")).alerts).toHaveLength(7);
    expect((await tool("weekly_digest")).from).toBe("2026-11-04");
    const overview = await tool("overview");
    expect(overview.open_alerts).toHaveLength(7);
    expect(overview.budget_this_month.available_cents).toBeGreaterThan(0);
  });

  it("sets a budget, ignores a series and dismisses an alert, each undoable", async () => {
    const set = await tool("set_budget", { category_id: "food.coffee", amount_cents: 9000 });
    expect(set.budget).toMatchObject({ amount_cents: 9000, month: null });
    const streamly = (await tool("recurring_list")).series.find((s: any) => s.merchant === "Streamly");
    const ignored = await tool("update_recurring", { id: streamly.id, status: "ignored" });
    const alert = (await tool("alerts_list")).alerts[0];
    const dismissed = await tool("dismiss_alert", { ids: [alert.id] });
    expect(dismissed.dismissed).toBe(1);
    const changes = await deps.db.all<{ actor: string; tool: string }>("SELECT actor, tool FROM changes ORDER BY rowid");
    expect(changes.map((c) => `${c.actor} ${c.tool}`)).toEqual(["claude set_budget", "claude update_recurring", "claude dismiss_alert"]);
    for (const b of [dismissed.batch_id, ignored.batch_id, set.batch_id]) expect((await tool("undo", { id: b })).undone.length).toBe(1);
    expect((await tool("budget_status")).lines.find((l: any) => l.category_id === "food.coffee").budget_cents).toBe(14_000);
    await expect(tool("set_budget", { category_id: "food.coffee" })).rejects.toThrow(/amount_cents/);
  });

  it("serves the M6 routes", async () => {
    const app = createApp(deps);
    const json = async (path: string, method = "GET", body?: unknown) => {
      const res = await app.request(path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { "content-type": "application/json" } : {} });
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await json("/api/budgets")).body.month).toBe("2026-11");
    expect((await json("/api/budgets?month=nope")).status).toBe(400);
    const saved = await json("/api/budgets", "POST", { category_id: "food.coffee", month: null, amount_cents: 15_000, rollover: true });
    expect(saved.body.budget).toMatchObject({ amount_cents: 15_000, rollover: 1 });
    const recurring = (await json("/api/recurring")).body;
    expect(recurring.upcoming.length).toBeGreaterThan(0);
    const id = recurring.series[0].id;
    expect((await json(`/api/recurring/${id}/charges`)).body.charges.length).toBeGreaterThanOrEqual(3);
    expect((await json(`/api/recurring/${id}`, "PATCH", { status: "ended" })).status).toBe(200);
    expect((await json(`/api/recurring/${id}`, "PATCH", { status: "paused" })).status).toBe(400);
    const alerts = (await json("/api/alerts")).body.alerts;
    expect((await json("/api/alerts/dismiss", "POST", { ids: [alerts[0].id] })).body.dismissed).toBe(1);
    expect((await json("/api/alerts")).body.alerts).toHaveLength(alerts.length - 1);
    expect((await json("/api/alerts?all=1")).body.alerts).toHaveLength(alerts.length);
    expect((await json("/api/digest")).body.to).toBe("2026-11-10");
  });
});
