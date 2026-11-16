import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  completeLink,
  type CoreDeps,
  type PlaidTransaction,
  replayConnection,
  type SqlDriver,
  splitRuns,
  syncConnection,
} from "../src/index.ts";
import { FakePlaidFailure, fakePlaid, makeDeps, openWasmDb } from "./helpers.ts";

const recorded = JSON.parse(readFileSync(new URL("./fixtures/plaid-sandbox.json", import.meta.url), "utf8"));
const checking = recorded.accounts.accounts.find((a: any) => a.subtype === "checking").account_id as string;
const template = recorded.transactions_sync.added[0] as PlaidTransaction;

const tx = (id: string, overrides: Partial<PlaidTransaction> = {}): PlaidTransaction => ({
  ...template,
  transaction_id: id,
  account_id: checking,
  pending: false,
  pending_transaction_id: null,
  amount: 10,
  date: "2026-11-05",
  name: `Test ${id}`,
  original_description: null,
  ...overrides,
});

const page = (p: Record<string, unknown>) => ({
  added: [],
  modified: [],
  removed: [],
  next_cursor: "c",
  has_more: false,
  request_id: "r",
  ...p,
});

/** Per-account fingerprint: what the acceptance check compares. */
async function fingerprint(db: SqlDriver) {
  return db.all(
    `SELECT a.plaid_account_id,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.removed_at IS NULL) AS live,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions t WHERE t.account_id = a.id AND t.removed_at IS NULL) AS total,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.removed_at IS NOT NULL) AS removed,
       (SELECT COUNT(*) FROM balances b WHERE b.account_id = a.id) AS balances,
       (SELECT COALESCE(SUM(value_cents), 0) FROM holdings h WHERE h.account_id = a.id) AS holdings,
       (SELECT COUNT(*) FROM investment_transactions i WHERE i.account_id = a.id) AS inv,
       a.file_backfill_before
     FROM accounts a ORDER BY a.plaid_account_id`,
  );
}

describe("replaying the raw archive", () => {
  it("rebuilds the same data from the archive alone, through the live sync code", async () => {
    // Five syncs over five days: a pagination restart, pending to posted, a
    // modified and a removed row, a sign-in problem, and a run that failed
    // part way. The replay must land exactly where the live database did.
    let step = 0;
    let attempt = 0;
    const plaid = fakePlaid({
      "/item/public_token/exchange": () => ({ access_token: "access-sandbox-test", item_id: recorded.item.item.item_id }),
      "/item/get": () =>
        step === 2
          ? { item: { ...recorded.item.item, error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login" } } }
          : recorded.item,
      "/accounts/get": () => recorded.accounts,
      "/transactions/sync": (body) => {
        if (step === 0) {
          if (!body.cursor) {
            attempt++;
            return page({ added: [tx(`first-${attempt}`), tx("keep")], next_cursor: `mid-${attempt}`, has_more: true });
          }
          if (body.cursor === "mid-1") throw new FakePlaidFailure("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
          return page({ added: [tx("gone"), tx("edit", { amount: 5 })], next_cursor: "c1" });
        }
        if (step === 1) return page({ added: [tx("pend", { pending: true, amount: 20 })], next_cursor: "c2" });
        if (step === 3) {
          if (body.cursor === "c2") return page({ added: [tx("never")], next_cursor: "c2b", has_more: true });
          throw new FakePlaidFailure("INTERNAL_SERVER_ERROR", 500);
        }
        return page({
          added: [tx("post", { pending_transaction_id: "pend", amount: 21.5 })],
          modified: [tx("edit", { amount: 7.25 })],
          removed: [{ transaction_id: "pend" }, { transaction_id: "gone" }],
          next_cursor: "c3",
        });
      },
      "/investments/holdings/get": () => recorded.holdings,
      "/investments/transactions/get": () => recorded.investment_transactions,
    });

    const live = await makeDeps(plaid.fetch);
    let day = Date.parse("2026-11-10T15:00:00Z");
    live.deps.now = () => {
      day += 1000;
      return new Date(day);
    };
    const { connectionId } = await completeLink(live.deps, {
      publicToken: "p",
      institution: { id: "ins_109508", name: "First Platypus Bank" },
    });
    const statuses = ["ok"];
    for (step = 1; step <= 4; step++) {
      day += 86_400_000; // a day later
      statuses.push((await syncConnection(live.deps, connectionId)).status);
    }
    expect(statuses).toEqual(["ok", "ok", "login_required", "error", "ok"]);

    const entries = live.archive.entries;
    expect(splitRuns(entries)).toHaveLength(5);

    // Replay into an empty database with no network and no secrets.
    const db = await openWasmDb();
    const replay: CoreDeps = {
      ...live.deps,
      db,
      fetch: async () => {
        throw new Error("replay must not call Plaid");
      },
      secrets: { get: async () => null, set: async () => {}, delete: async () => {} } as any,
    };
    const summary = await replayConnection(replay, connectionId, entries, { institutionName: "First Platypus Bank" });
    expect(summary).toMatchObject({ runs: 5, applied: 3, skipped: 2 });

    expect(await fingerprint(db)).toEqual(await fingerprint(live.deps.db));
    const conn = async (d: SqlDriver) =>
      (await d.all<any>("SELECT id, institution_name, status, transactions_cursor, plaid_env FROM connections"))[0];
    expect(await conn(db)).toEqual(await conn(live.deps.db));
    const ids = async (d: SqlDriver) =>
      (await d.all<any>("SELECT external_id, amount_cents FROM transactions WHERE removed_at IS NULL ORDER BY external_id")).map(
        (r) => `${r.external_id}:${r.amount_cents}`,
      );
    expect(await ids(db)).toEqual(["edit:-725", "first-2:-1000", "keep:-1000", "post:-2150"]);
    // Balances land on the days they were fetched, not the day of the replay.
    const days = async (d: SqlDriver) => (await d.all<any>("SELECT DISTINCT as_of FROM balances ORDER BY as_of")).map((r) => r.as_of);
    expect(await days(db)).toEqual(await days(live.deps.db));
  });

  it("splits runs at each /item/get", () => {
    const e = (endpoint: string) => ({ provider: "plaid" as const, connectionId: "c", endpoint, fetchedAt: "", env: "sandbox", request: {}, response: {} });
    const runs = splitRuns([e("/item/get"), e("/accounts/get"), e("/item/get"), e("/transactions/sync")]);
    expect(runs.map((r) => r.map((x) => x.endpoint))).toEqual([["/item/get", "/accounts/get"], ["/item/get", "/transactions/sync"]]);
  });
});
