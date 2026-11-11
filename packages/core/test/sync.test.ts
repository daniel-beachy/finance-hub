import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  completeLink,
  disconnect,
  type PlaidTransaction,
  setSetting,
  SlotConfirmationRequired,
  slotsUsed,
  syncAll,
  syncConnection,
} from "../src/index.ts";
import { FakePlaidFailure, fakePlaid, makeDeps } from "./helpers.ts";

/** Responses recorded from the Plaid Sandbox, trimmed. */
const recorded = JSON.parse(readFileSync(new URL("./fixtures/plaid-sandbox.json", import.meta.url), "utf8"));
const checking = recorded.accounts.accounts.find((a: any) => a.subtype === "checking").account_id as string;
const template = recorded.transactions_sync.added[0] as PlaidTransaction;

function tx(id: string, overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    ...template,
    transaction_id: id,
    account_id: checking,
    pending: false,
    pending_transaction_id: null,
    amount: 12.34,
    date: "2026-11-05",
    name: `Test ${id}`,
    original_description: null,
    ...overrides,
  };
}

const page = (p: Partial<{ added: any[]; modified: any[]; removed: any[]; next_cursor: string; has_more: boolean }>) => ({
  added: [],
  modified: [],
  removed: [],
  next_cursor: "c1",
  has_more: false,
  request_id: "r",
  ...p,
});

const noInvestments = {
  "/investments/holdings/get": () => {
    throw new FakePlaidFailure("PRODUCTS_NOT_SUPPORTED");
  },
};

/** Handlers for a healthy Item, with the transaction pages supplied by the test. */
function healthy(sync: (body: Record<string, any>, n: number) => unknown) {
  return {
    "/item/public_token/exchange": () => ({ access_token: "access-sandbox-test", item_id: recorded.item.item.item_id }),
    "/item/get": () => recorded.item,
    "/accounts/get": () => recorded.accounts,
    "/transactions/sync": sync,
    ...noInvestments,
  };
}

async function linked(handlers: Record<string, any>) {
  const plaid = fakePlaid(handlers);
  const ctx = await makeDeps(plaid.fetch);
  const { connectionId, sync } = await completeLink(ctx.deps, {
    publicToken: "public-sandbox-test",
    institution: { id: "ins_109508", name: "First Platypus Bank" },
  });
  return { ...ctx, plaid, connectionId, firstSync: sync };
}

const count = async (db: any, where = "1=1") =>
  (await db.all(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`))[0].n as number;

describe("syncing against recorded Sandbox responses", () => {
  it("loads accounts, transactions, holdings and investment activity", async () => {
    const { deps, firstSync, connectionId } = await linked({
      ...healthy(() => recorded.transactions_sync),
      "/investments/holdings/get": () => recorded.holdings,
      "/investments/transactions/get": () => recorded.investment_transactions,
    });
    expect(firstSync).toMatchObject({ status: "ok", added: recorded.transactions_sync.added.length });

    const accounts = await deps.db.all<any>("SELECT * FROM accounts");
    expect(accounts).toHaveLength(recorded.accounts.accounts.length);
    expect(accounts.every((a) => a.feed === "plaid" && a.connection_id === connectionId)).toBe(true);

    // Plaid: positive is money out. Ours: negative is money out.
    const first = recorded.transactions_sync.added[0];
    const row = (await deps.db.all<any>("SELECT * FROM transactions WHERE external_id = ?", [first.transaction_id]))[0];
    expect(row.amount_cents).toBe(-Math.round(first.amount * 100));
    expect(row.plaid_pfc_detailed).toBe(first.personal_finance_category.detailed);

    // What is owed on a credit card is a negative balance.
    const card = recorded.accounts.accounts.find((a: any) => a.type === "credit");
    const balance = await deps.db.all<any>(
      "SELECT b.current_cents FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.plaid_account_id = ?",
      [card.account_id],
    );
    expect(balance[0].current_cents).toBe(-Math.round(card.balances.current * 100));

    expect((await deps.db.all<any>("SELECT COUNT(*) AS n FROM holdings"))[0].n).toBe(recorded.holdings.holdings.length);
    const inv = await deps.db.all<any>("SELECT * FROM investment_transactions");
    expect(inv).toHaveLength(recorded.investment_transactions.investment_transactions.length);
    const conn = (await deps.db.all<any>("SELECT * FROM connections"))[0];
    expect(conn).toMatchObject({ status: "ok", transactions_cursor: recorded.transactions_sync.next_cursor, days_requested: 730 });
  });

  it("adds nothing on a second run", async () => {
    const { deps, connectionId, plaid } = await linked(
      healthy((body) => (body.cursor ? page({ next_cursor: body.cursor }) : recorded.transactions_sync)),
    );
    const before = await count(deps.db);
    const again = await syncConnection(deps, connectionId);
    expect(again).toMatchObject({ status: "ok", added: 0, modified: 0, removed: 0 });
    expect(await count(deps.db)).toBe(before);
    const cursors = plaid.calls.filter((c) => c.endpoint === "/transactions/sync").map((c) => c.body.cursor);
    expect(cursors).toEqual([undefined, recorded.transactions_sync.next_cursor]);
  });

  it("archives every response before it reaches the database", async () => {
    const plaid = fakePlaid(healthy(() => page({ added: [tx("a1")] })));
    const ctx = await makeDeps(plaid.fetch);
    const seenAtArchiveTime: number[] = [];
    const inner = ctx.deps.archive;
    ctx.deps.archive = {
      write: async (entry) => {
        if (entry.endpoint === "/transactions/sync") seenAtArchiveTime.push(await count(ctx.deps.db));
        await inner.write(entry);
      },
    };
    await completeLink(ctx.deps, { publicToken: "p", institution: { name: "Bank" } });
    expect(seenAtArchiveTime).toEqual([0]);
    expect(await count(ctx.deps.db)).toBe(1);
    expect(ctx.archive.entries.map((e) => e.endpoint)).toEqual(["/item/get", "/accounts/get", "/transactions/sync"]);
    // Request metadata is kept for replay, but never the keys or the token.
    const text = JSON.stringify(ctx.archive.entries);
    expect(text).not.toContain("access-sandbox-test");
    expect(text).not.toContain("test-sandbox-secret");
  });

  it("stores the access token before writing the connection row", async () => {
    const plaid = fakePlaid(healthy(() => page({})));
    const ctx = await makeDeps(plaid.fetch);
    const order: string[] = [];
    const set = ctx.deps.secrets.set;
    ctx.deps.secrets.set = async (name, value) => {
      order.push(`secret:${(await ctx.deps.db.all<any>("SELECT COUNT(*) AS n FROM connections"))[0].n}`);
      await set(name, value);
    };
    const { connectionId } = await completeLink(ctx.deps, { publicToken: "p", institution: { name: "Bank" } });
    expect(order).toEqual(["secret:0"]);
    expect(await ctx.secrets.get(`plaid-token-${connectionId}`)).toBe("access-sandbox-test");
    expect(JSON.stringify(await ctx.deps.db.all("SELECT * FROM connections"))).not.toContain("access-sandbox-test");
  });

  it("carries manual work from a pending transaction to its posted version", async () => {
    const { deps, connectionId } = await linked(
      healthy((_body, n) =>
        n === 0
          ? page({ added: [tx("pend-1", { pending: true, amount: 20 })], next_cursor: "c1" })
          : page({
              added: [tx("post-1", { pending_transaction_id: "pend-1", amount: 23.5 })],
              removed: [{ transaction_id: "pend-1" }],
              next_cursor: "c2",
            }),
      ),
    );
    const pending = (await deps.db.all<any>("SELECT id FROM transactions WHERE external_id = 'pend-1'"))[0];
    await deps.db.run(
      "UPDATE transactions SET category_id = 'food.coffee', category_source = 'manual', note = 'team coffee', reviewed_at = 'x', flag = 'suspicious' WHERE id = ?",
      [pending.id],
    );
    await deps.db.run("INSERT INTO tags (id, name) VALUES ('tag1', 'work')");
    await deps.db.run("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, 'tag1')", [pending.id]);

    const result = await syncConnection(deps, connectionId);
    expect(result).toMatchObject({ status: "ok", added: 1 });

    const posted = (await deps.db.all<any>("SELECT * FROM transactions WHERE external_id = 'post-1'"))[0];
    expect(posted).toMatchObject({
      category_id: "food.coffee",
      category_source: "manual",
      note: "team coffee",
      flag: "suspicious",
      amount_cents: -2350,
      pending: 0,
      removed_at: null,
    });
    expect(await deps.db.all("SELECT transaction_id FROM transaction_tags")).toEqual([{ transaction_id: posted.id }]);
    expect(await count(deps.db, "removed_at IS NULL")).toBe(1);
    expect(await count(deps.db, "external_id = 'pend-1' AND removed_at IS NOT NULL")).toBe(1);
  });

  it("applies modified and removed, and never overwrites a manual category", async () => {
    const { deps, connectionId } = await linked(
      healthy((_body, n) =>
        n === 0
          ? page({ added: [tx("m1", { amount: 10 }), tx("m2"), tx("m3")] })
          : page({ modified: [tx("m1", { amount: 11, name: "Renamed" })], removed: [{ transaction_id: "m2" }], next_cursor: "c2" }),
      ),
    );
    await deps.db.run("UPDATE transactions SET category_id = 'food.groceries', category_source = 'manual' WHERE external_id = 'm1'");
    const result = await syncConnection(deps, connectionId);
    expect(result).toMatchObject({ added: 0, modified: 1, removed: 1 });
    const m1 = (await deps.db.all<any>("SELECT * FROM transactions WHERE external_id = 'm1'"))[0];
    expect(m1).toMatchObject({ amount_cents: -1100, description_raw: "Renamed", category_id: "food.groceries", category_source: "manual" });
    expect(await count(deps.db, "external_id = 'm2' AND removed_at IS NOT NULL")).toBe(1);
    expect(await count(deps.db, "removed_at IS NULL")).toBe(2);
  });

  it("restarts from the original cursor when data changes mid-pagination", async () => {
    let attempt = 0;
    const { deps, plaid, firstSync } = await linked(
      healthy((body) => {
        if (!body.cursor) {
          attempt++;
          return page({ added: [tx(`p1-try${attempt}`)], next_cursor: `mid-${attempt}`, has_more: true });
        }
        if (body.cursor === "mid-1") throw new FakePlaidFailure("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
        return page({ added: [tx("p2")], next_cursor: "final" });
      }),
    );
    expect(firstSync).toMatchObject({ status: "ok", added: 2 });
    const cursors = plaid.calls.filter((c) => c.endpoint === "/transactions/sync").map((c) => c.body.cursor);
    expect(cursors).toEqual([undefined, "mid-1", undefined, "mid-2"]);
    // Pages from the abandoned attempt are discarded.
    const ids = (await deps.db.all<any>("SELECT external_id FROM transactions ORDER BY external_id")).map((r) => r.external_id);
    expect(ids).toEqual(["p1-try2", "p2"]);
    expect((await deps.db.all<any>("SELECT transactions_cursor FROM connections"))[0].transactions_cursor).toBe("final");
  });

  it("keeps the old cursor and writes nothing when a later page fails", async () => {
    let fail = false;
    const { deps, connectionId } = await linked(
      healthy((body) => {
        if (!fail) return page({ added: [tx("ok-1")], next_cursor: "c1" });
        if (body.cursor === "c1") return page({ added: [tx("lost-1")], next_cursor: "c2", has_more: true });
        throw new FakePlaidFailure("INTERNAL_SERVER_ERROR", 500);
      }),
    );
    fail = true;
    const result = await syncConnection(deps, connectionId);
    expect(result).toMatchObject({ status: "error", errorCode: "INTERNAL_SERVER_ERROR", added: 0 });
    expect(await count(deps.db)).toBe(1);
    const conn = (await deps.db.all<any>("SELECT * FROM connections"))[0];
    expect(conn).toMatchObject({ transactions_cursor: "c1", status: "error" });
    const runs = await deps.db.all<any>("SELECT status, error_code FROM sync_runs ORDER BY started_at");
    expect(runs).toEqual([
      { status: "ok", error_code: null },
      { status: "error", error_code: "INTERNAL_SERVER_ERROR" },
    ]);
  });

  it("marks a connection login_required, alerts once, and recovers with the same connection", async () => {
    let broken = false;
    const { deps, connectionId } = await linked({
      ...healthy(() => page({})),
      "/item/get": () =>
        broken
          ? { item: { ...recorded.item.item, error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login" } } }
          : recorded.item,
    });
    broken = true;
    expect((await syncConnection(deps, connectionId)).status).toBe("login_required");
    expect((await syncConnection(deps, connectionId)).status).toBe("login_required");
    expect((await deps.db.all<any>("SELECT status FROM connections"))[0].status).toBe("login_required");
    const open = () => deps.db.all<any>("SELECT * FROM alerts WHERE kind = 'connection' AND dismissed_at IS NULL");
    expect(await open()).toHaveLength(1);

    broken = false; // the user re-authenticated in update mode: same Item, same token
    expect((await syncConnection(deps, connectionId)).status).toBe("ok");
    expect(await deps.db.all("SELECT id, status FROM connections")).toEqual([{ id: connectionId, status: "ok" }]);
    expect(await open()).toHaveLength(0);
  });

  it("keeps syncing other connections when one fails", async () => {
    const plaid = fakePlaid({
      ...healthy(() => page({})),
      "/item/public_token/exchange": (_b: any, n: number) => ({ access_token: `access-${n}`, item_id: `item-${n}` }),
      "/item/get": (body: any) => {
        if (body.access_token === "access-0") throw new FakePlaidFailure("INTERNAL_SERVER_ERROR", 500);
        return recorded.item;
      },
      "/accounts/get": (body: any) =>
        body.access_token === "access-1" ? recorded.accounts : { accounts: [], item: recorded.item.item },
    });
    const { deps } = await makeDeps(plaid.fetch);
    await completeLink(deps, { publicToken: "a", institution: { name: "A" } });
    await completeLink(deps, { publicToken: "b", institution: { name: "B" } });
    const results = await syncAll(deps);
    expect(results.map((r) => r.status)).toEqual(["error", "ok"]);
  });
});

describe("protecting Plaid's lifetime connection limit", () => {
  it("requires confirmation in production and counts every slot, even disconnected ones", async () => {
    const plaid = fakePlaid({
      ...healthy(() => page({})),
      "/item/public_token/exchange": (_b: any, n: number) => ({ access_token: `access-${n}`, item_id: `item-${n}` }),
    });
    const { deps } = await makeDeps(plaid.fetch);
    await completeLink(deps, { publicToken: "sandbox", institution: { name: "Sandbox Bank" } });
    expect(await slotsUsed(deps)).toBe(0);

    await setSetting(deps.db, "plaid_env", "production");
    await expect(completeLink(deps, { publicToken: "p", institution: { name: "Real Bank" } })).rejects.toBeInstanceOf(
      SlotConfirmationRequired,
    );
    expect(plaid.endpoints().filter((e) => e === "/item/public_token/exchange")).toHaveLength(1);

    const { connectionId } = await completeLink(deps, { publicToken: "p", institution: { name: "Real Bank" }, confirmSlot: true });
    expect(await slotsUsed(deps)).toBe(1);
    await disconnect(deps, connectionId);
    expect(await slotsUsed(deps)).toBe(1);
    expect((await syncConnection(deps, connectionId)).status).toBe("skipped");
    expect(plaid.endpoints()).not.toContain("/item/remove");
  });

  it("uses each environment's own secret", async () => {
    const plaid = fakePlaid(healthy(() => page({})));
    const { deps } = await makeDeps(plaid.fetch);
    await completeLink(deps, { publicToken: "s", institution: { name: "S" } });
    expect(new Set(plaid.calls.map((c) => c.body.secret))).toEqual(new Set(["test-sandbox-secret"]));
  });
});
