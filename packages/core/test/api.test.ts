import { describe, expect, it } from "vitest";
import { createApp, generateDemoData } from "../src/index.ts";
import { FakePlaidFailure, fakePlaid, makeDeps } from "./helpers.ts";

const ORIGIN = "http://127.0.0.1:5202";

async function setup() {
  const plaid = fakePlaid({
    "/link/token/create": () => ({ link_token: "link-sandbox-abc", expiration: "2026-11-10T20:00:00Z" }),
    "/item/public_token/exchange": () => {
      throw new FakePlaidFailure("INVALID_PUBLIC_TOKEN");
    },
  });
  const { deps } = await makeDeps(plaid.fetch);
  const app = createApp(deps, { allowedOrigins: [ORIGIN, "http://localhost:5202"] });
  const call = (path: string, init: RequestInit & { host?: string; origin?: string } = {}) =>
    app.request(path, {
      ...init,
      headers: {
        host: init.host ?? "127.0.0.1:5202",
        ...(init.origin ? { origin: init.origin } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  return { deps, app, call, plaid };
}

describe("local API safety", () => {
  it("answers on the loopback host", async () => {
    const { call } = await setup();
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "local" });
    expect((await call("/api/health", { host: "localhost:5202", origin: "http://localhost:5202" })).status).toBe(200);
  });

  it("refuses a foreign Host (DNS rebinding)", async () => {
    const { call } = await setup();
    expect((await call("/api/health", { host: "evil.example:5202" })).status).toBe(403);
    expect((await call("/api/health", { host: "127.0.0.1:9999" })).status).toBe(403);
  });

  it("refuses a foreign Origin (another site's page)", async () => {
    const { call } = await setup();
    const res = await call("/api/sync", { method: "POST", origin: "https://evil.example", body: "{}" });
    expect(res.status).toBe(403);
    expect((await call("/api/sync", { method: "POST", origin: ORIGIN, body: "{}" })).status).toBe(200);
  });

  it("sends no CORS headers", async () => {
    const { call } = await setup();
    const res = await call("/api/health", { origin: ORIGIN });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("API routes", () => {
  it("reports status with the slot count", async () => {
    const { call } = await setup();
    expect(await (await call("/api/status")).json()).toMatchObject({
      plaid_env: "sandbox",
      slots_used: 0,
      slot_limit: 10,
    });
  });

  it("creates a link token that asks for the full history", async () => {
    const { call, plaid } = await setup();
    const res = await call("/api/connections/link-token", { method: "POST", body: JSON.stringify({ kind: "bank" }) });
    expect(await res.json()).toEqual({ link_token: "link-sandbox-abc", mode: "new", env: "sandbox" });
    const body = plaid.calls[0]!.body;
    expect(body).toMatchObject({
      products: ["transactions"],
      required_if_supported_products: ["investments"],
      transactions: { days_requested: 730 },
      country_codes: ["US"],
    });
    expect(body.redirect_uri).toBeUndefined();

    await call("/api/connections/link-token", { method: "POST", body: JSON.stringify({ kind: "investment" }) });
    expect(plaid.calls[1]!.body).toMatchObject({ products: ["investments"], required_if_supported_products: ["transactions"] });
  });

  it("returns Plaid errors without leaking secrets", async () => {
    const { call } = await setup();
    const res = await call("/api/connections/exchange", { method: "POST", body: JSON.stringify({ public_token: "bad" }) });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("INVALID_PUBLIC_TOKEN");
    expect(text).not.toContain("test-sandbox-secret");
  });

  it("serves accounts and transactions from the same app the demo uses", async () => {
    const { call, deps } = await setup();
    await generateDemoData(deps.db, { months: 2, asOf: "2026-06-30" });
    const accounts = await (await call("/api/accounts")).json();
    expect(accounts.accounts).toHaveLength(10);
    const txs = await (await call("/api/transactions?limit=5")).json();
    expect(txs.rows).toHaveLength(5);
    expect((await call("/api/nope")).status).toBe(404);
  });
});

describe("after-sync hook", () => {
  it("runs in the background after a dashboard sync, and its failure never fails the request", async () => {
    const { deps } = await makeDeps(fakePlaid({}).fetch);
    let calls = 0;
    const app = createApp(deps, {
      afterSync: async () => {
        calls++;
        throw new Error("backup broke");
      },
    });
    const res = await app.request("/api/sync", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(calls).toBe(1);
  });
});

describe("rule, transfer and undo routes", () => {
  async function seeded() {
    const s = await setup();
    await generateDemoData(s.deps.db, { months: 3, asOf: "2026-06-30" });
    const json = async (path: string, method = "GET", body?: unknown) => {
      const res = await s.call(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { ...s, json };
  }

  it("lists rules with their category names", async () => {
    const { json } = await seeded();
    const { body } = await json("/api/rules");
    expect(body.rules.length).toBeGreaterThanOrEqual(3);
    const store = body.rules.find((r: any) => r.match.merchant_key === "RIVERMART");
    expect(store.category_name).toBeTruthy();
  });

  it("dry-runs a rule without writing, then creates it, then undoes it", async () => {
    const { json } = await seeded();
    const before = (await json("/api/rules")).body.rules.length;
    const match = { merchant_key: "BLUE DOOR PIZZA" };
    const dry = await json("/api/rules", "POST", { match, category_id: "food.groceries", dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dry_run).toBe(true);
    expect(dry.body.changed).toBeGreaterThan(0);
    expect(dry.body.batch_id).toBeUndefined();
    expect((await json("/api/rules")).body.rules).toHaveLength(before);

    const made = await json("/api/rules", "POST", { match, category_id: "food.groceries" });
    expect(made.body.changed).toBe(dry.body.changed);
    expect(made.body.batch_id).toBeTruthy();
    const pizza = await json(`/api/transactions?merchant=${encodeURIComponent("Blue Door Pizza")}&limit=5`);
    expect(pizza.body.rows.every((r: any) => r.category_id === "food.groceries")).toBe(true);

    const undone = await json("/api/undo", "POST", { batch_id: made.body.batch_id });
    expect(undone.body.undone).toHaveLength(1);
    expect((await json("/api/rules")).body.rules).toHaveLength(before);
    const back = await json(`/api/transactions?merchant=${encodeURIComponent("Blue Door Pizza")}&limit=5`);
    expect(back.body.rows.every((r: any) => r.category_id === "food.restaurants")).toBe(true);
  });

  it("updates and deletes a rule, and rejects a bad one", async () => {
    const { json } = await seeded();
    const made = await json("/api/rules", "POST", { match: { merchant_key: "STREAMLY" }, category_id: "entertainment.streaming" });
    const id = made.body.rule.id;
    const off = await json(`/api/rules/${id}`, "PATCH", { enabled: false });
    expect(off.body.rule.enabled).toBe(false);
    const gone = await json(`/api/rules/${id}`, "DELETE");
    expect(gone.body.rule).toBeNull();
    expect((await json(`/api/rules/${id}`, "PATCH", { enabled: true })).status).toBe(404);
    expect((await json("/api/rules", "POST", { match: {}, category_id: "food.groceries" })).status).toBe(400);
    expect((await json("/api/rules", "POST", { match: { colour: "red" }, category_id: "food.groceries" })).status).toBe(400);
  });

  it("categorizes with create_rule and remember, and undoes the whole batch", async () => {
    const { json } = await seeded();
    const rows = (await json(`/api/transactions?q=${encodeURIComponent("COASTLINE KAYAK")}&limit=50`)).body.rows;
    expect(rows.length).toBeGreaterThan(0);
    const res = await json("/api/transactions/categorize", "POST", {
      ids: [rows[0].id],
      category_id: "entertainment.events",
      create_rule: true,
      remember: false,
    });
    expect(res.body.rules).toHaveLength(1);
    expect(res.body.rules[0].match).toEqual({ merchant_key: rows[0].merchant_key });
    const undone = await json("/api/undo", "POST", { batch_id: res.body.batch_id });
    expect(undone.body.skipped).toEqual([]);
    expect((await json("/api/rules")).body.rules.some((r: any) => r.id === res.body.rules[0].id)).toBe(false);
  });

  it("returns a batch id from a transaction edit that undo reverses", async () => {
    const { json } = await seeded();
    const row = (await json("/api/transactions?limit=1")).body.rows[0];
    const edit = await json(`/api/transactions/${row.id}`, "PATCH", { note: "hello" });
    expect(edit.body.transaction.note).toBe("hello");
    await json("/api/undo", "POST", { batch_id: edit.body.batch_id });
    expect((await json(`/api/transactions?q=hello`)).body.total).toBe(0);
    expect((await json("/api/undo", "POST", {})).status).toBe(400);
    expect((await json("/api/undo", "POST", { batch_id: "nope" })).status).toBe(404);
  });

  it("shows a transfer's other side, and unmarks and re-marks a pair", async () => {
    const { json } = await seeded();
    const out = (await json(`/api/transactions?q=${encodeURIComponent("TRANSFER TO SAVINGS")}&limit=1`)).body.rows[0];
    expect(out.transfer_peer_id).toBeTruthy();
    expect(out.transfer_peer_amount_cents).toBe(-out.amount_cents);
    expect(out.transfer_kind).toBe("internal_transfer");
    const peer = out.transfer_peer_id;

    const unmarked = await json("/api/transfers/unmark", "POST", { id: out.id });
    expect(unmarked.body.change_ids).toHaveLength(2);
    const after = (await json(`/api/transactions?q=${encodeURIComponent("TRANSFER TO SAVINGS")}&limit=1`)).body.rows[0];
    expect(after.transfer_peer_id).toBeNull();

    const marked = await json("/api/transfers/mark", "POST", { ids: [out.id, peer] });
    expect(marked.body.kind).toBe("internal_transfer");
    expect((await json("/api/transfers/mark", "POST", { ids: [out.id] })).status).toBe(400);
  });
});
