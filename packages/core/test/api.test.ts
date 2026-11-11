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
