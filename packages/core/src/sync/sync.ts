import { first } from "../db/driver.ts";
import { type CoreDeps, localDate } from "../deps.ts";
import {
  type HoldingsResponse,
  type InvestmentTransactionsResponse,
  type PlaidAccount,
  PlaidClient,
  PlaidError,
  type PlaidItem,
  type PlaidSecurity,
  type PlaidTransaction,
  type TransactionsSyncResponse,
} from "../plaid/client.ts";
import { type PlaidEnv, SECRET_CLIENT_ID, secretNameForEnv, tokenNameForConnection } from "../secrets.ts";
import { addDays, toCents, toCentsOrNull } from "../util/money.ts";
import { DEFAULT_OWNER_ID } from "../db/seed.ts";

export type SyncTrigger = "schedule" | "manual" | "mcp";

export interface SyncResult {
  connectionId: string;
  institution: string;
  status: "ok" | "error" | "login_required" | "skipped";
  added: number;
  modified: number;
  removed: number;
  errorCode?: string;
  errorMessage?: string;
}

interface ConnectionRow {
  id: string;
  source: string;
  plaid_env: PlaidEnv | null;
  institution_name: string;
  transactions_cursor: string | null;
  status: string;
}

const MAX_MUTATION_RESTARTS = 5;
/** Investment errors that mean "nothing to fetch", not "the sync failed". */
const INVESTMENT_SKIP_CODES = new Set([
  "PRODUCTS_NOT_SUPPORTED",
  "PRODUCT_NOT_READY",
  "NO_INVESTMENT_ACCOUNTS",
  "NO_ACCOUNTS",
  "ADDITIONAL_CONSENT_REQUIRED",
  "INVALID_PRODUCT",
]);

export async function plaidClientFor(deps: CoreDeps, env: PlaidEnv): Promise<PlaidClient> {
  const clientId = await deps.secrets.get(SECRET_CLIENT_ID);
  const secret = await deps.secrets.get(secretNameForEnv(env));
  if (!clientId || !secret) {
    throw new Error(`Plaid ${env} keys are not in the secret store. Run "fh setup".`);
  }
  return new PlaidClient({ clientId, secret, env }, deps.fetch);
}

/** Sync every Plaid connection in turn. One failure does not stop the others. */
export async function syncAll(deps: CoreDeps, trigger: SyncTrigger = "manual"): Promise<SyncResult[]> {
  const rows = await deps.db.all<{ id: string }>(
    "SELECT id FROM connections WHERE source = 'plaid' AND status != 'removed' ORDER BY created_at",
  );
  const results: SyncResult[] = [];
  for (const row of rows) results.push(await syncConnection(deps, row.id, trigger));
  return results;
}

export async function syncConnection(
  deps: CoreDeps,
  connectionId: string,
  trigger: SyncTrigger = "manual",
): Promise<SyncResult> {
  const { db } = deps;
  const conn = await first<ConnectionRow>(db, "SELECT * FROM connections WHERE id = ?", [connectionId]);
  if (conn?.source !== "plaid" || !conn.plaid_env) {
    throw new Error(`No Plaid connection with id ${connectionId}`);
  }
  const result: SyncResult = {
    connectionId,
    institution: conn.institution_name,
    status: "ok",
    added: 0,
    modified: 0,
    removed: 0,
  };
  if (conn.status === "removed") return { ...result, status: "skipped" };

  const runId = deps.newId();
  await db.run(
    "INSERT INTO sync_runs (id, started_at, trigger, connection_id, status) VALUES (?, ?, ?, ?, 'running')",
    [runId, deps.now().toISOString(), trigger, connectionId],
  );

  try {
    const client = await plaidClientFor(deps, conn.plaid_env);
    const token = await deps.secrets.get(tokenNameForConnection(connectionId));
    if (!token) throw new Error("The access token for this connection is missing from the secret store");

    // Fetch, then archive, then return: nothing reaches the database unarchived.
    const fetched = async <T>(endpoint: string, request: Record<string, unknown>, call: () => Promise<T>) => {
      const response = await call();
      await deps.archive.write({
        provider: "plaid",
        connectionId,
        endpoint,
        fetchedAt: deps.now().toISOString(),
        env: client.env,
        request,
        response,
      });
      return response;
    };

    const { item } = await fetched("/item/get", {}, () => client.itemGet(token));
    if (item.error?.error_code === "ITEM_LOGIN_REQUIRED") {
      throw new PlaidError("/item/get", 400, {
        error_code: "ITEM_LOGIN_REQUIRED",
        error_message: item.error.error_message,
      });
    }

    const { accounts } = await fetched("/accounts/get", {}, () => client.accountsGet(token));

    const pages = hasProduct(item, "transactions", true)
      ? await fetchTransactionPages(client, token, conn.transactions_cursor, fetched)
      : null;

    const wantsInvestments = hasProduct(
      item,
      "investments",
      accounts.some((a) => normalizeAccountType(a.type) === "investment"),
    );
    const investments = wantsInvestments ? await fetchInvestments(deps, client, token, connectionId, fetched) : null;

    await db.transaction(async () => {
      const nowIso = deps.now().toISOString();
      const accountIds = await applyAccounts(deps, connectionId, accounts);
      if (pages) {
        for (const page of pages.pages) {
          for (const t of page.added) {
            const outcome = await upsertTransaction(deps, accountIds, t, nowIso);
            if (outcome === "inserted") result.added++;
            else if (outcome === "updated") result.modified++;
          }
          for (const t of page.modified) {
            const outcome = await upsertTransaction(deps, accountIds, t, nowIso);
            if (outcome) result.modified++;
          }
          for (const r of page.removed) {
            const res = await db.run(
              `UPDATE transactions SET removed_at = ?, updated_at = ?
               WHERE external_id = ? AND removed_at IS NULL
                 AND account_id IN (SELECT id FROM accounts WHERE connection_id = ?)`,
              [nowIso, nowIso, r.transaction_id, connectionId],
            );
            result.removed += res.changes;
          }
        }
        await setBackfillBoundary(deps, connectionId);
      }
      if (investments) await applyInvestments(deps, accountIds, investments);
      await db.run(
        `UPDATE connections SET status = 'ok', last_error = NULL, last_synced_at = ?,
           consent_expires_at = ?, transactions_cursor = COALESCE(?, transactions_cursor)
         WHERE id = ?`,
        [nowIso, item.consent_expiration_time ?? null, pages?.cursor ?? null, connectionId],
      );
      await db.run(
        "UPDATE alerts SET dismissed_at = ? WHERE kind = 'connection' AND connection_id = ? AND dismissed_at IS NULL",
        [nowIso, connectionId],
      );
    });
    await finishRun(deps, runId, result);
    return result;
  } catch (err) {
    const code = err instanceof PlaidError ? err.errorCode : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    result.errorCode = code;
    result.errorMessage = message;
    result.status = code === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error";
    result.added = result.modified = result.removed = 0;
    const nowIso = deps.now().toISOString();
    await db.run("UPDATE connections SET status = ?, last_error = ? WHERE id = ?", [
      result.status,
      message,
      connectionId,
    ]);
    if (result.status === "login_required") {
      const open = await first(
        db,
        "SELECT id FROM alerts WHERE kind = 'connection' AND connection_id = ? AND dismissed_at IS NULL",
        [connectionId],
      );
      if (!open) {
        await db.run(
          "INSERT INTO alerts (id, kind, connection_id, message, created_at) VALUES (?, 'connection', ?, ?, ?)",
          [deps.newId(), connectionId, `${conn.institution_name} needs you to sign in again.`, nowIso],
        );
      }
    }
    await finishRun(deps, runId, result);
    return result;
  }
}

async function finishRun(deps: CoreDeps, runId: string, r: SyncResult): Promise<void> {
  await deps.db.run(
    `UPDATE sync_runs SET finished_at = ?, status = ?, added = ?, modified = ?, removed = ?,
       error_code = ?, error_message = ? WHERE id = ?`,
    [
      deps.now().toISOString(),
      r.status === "skipped" ? "ok" : r.status,
      r.added,
      r.modified,
      r.removed,
      r.errorCode ?? null,
      r.errorMessage ?? null,
      runId,
    ],
  );
}

function hasProduct(item: PlaidItem, product: string, fallback: boolean): boolean {
  const listed = [...(item.products ?? []), ...(item.billed_products ?? [])];
  if (listed.length === 0) return fallback;
  return listed.includes(product);
}

type Fetched = <T>(endpoint: string, request: Record<string, unknown>, call: () => Promise<T>) => Promise<T>;

/**
 * Read every page after `startCursor`. If Plaid reports that data changed
 * mid-pagination, throw the pages away and start again from `startCursor`.
 * The cursor is only persisted by the caller once all pages are applied.
 */
async function fetchTransactionPages(
  client: PlaidClient,
  token: string,
  startCursor: string | null,
  fetched: Fetched,
): Promise<{ pages: TransactionsSyncResponse[]; cursor: string | null }> {
  for (let attempt = 0; ; attempt++) {
    const pages: TransactionsSyncResponse[] = [];
    let cursor = startCursor;
    try {
      for (;;) {
        const requestCursor = cursor;
        const page = await fetched("/transactions/sync", { cursor: requestCursor }, () =>
          client.transactionsSync(token, requestCursor),
        );
        pages.push(page);
        // An empty next_cursor means Plaid has no data yet; keep the old cursor.
        if (page.next_cursor) cursor = page.next_cursor;
        if (!page.has_more) return { pages, cursor };
      }
    } catch (err) {
      const restart =
        err instanceof PlaidError && err.errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
      if (!restart || attempt >= MAX_MUTATION_RESTARTS) throw err;
    }
  }
}

export function normalizeAccountType(type: string): "depository" | "credit" | "investment" | "loan" | "other" {
  if (type === "depository" || type === "credit" || type === "loan") return type;
  if (type === "investment" || type === "brokerage") return "investment";
  return "other";
}

export function taxTreatment(type: string, subtype: string | null): string {
  if (type !== "investment") return "none";
  const s = (subtype ?? "").toLowerCase();
  if (s.includes("roth")) return "roth";
  if (s === "hsa") return "hsa";
  if (["401k", "401a", "403b", "457b", "ira", "sep ira", "simple ira", "pension", "keogh"].includes(s)) {
    return "traditional";
  }
  return "taxable";
}

/** Upsert accounts and today's balances. Returns plaid_account_id -> our id. */
async function applyAccounts(
  deps: CoreDeps,
  connectionId: string,
  accounts: PlaidAccount[],
): Promise<Map<string, string>> {
  const { db } = deps;
  const ids = new Map<string, string>();
  const today = localDate(deps.now());
  for (const a of accounts) {
    const type = normalizeAccountType(a.type);
    const existing = await first<{ id: string }>(db, "SELECT id FROM accounts WHERE plaid_account_id = ?", [
      a.account_id,
    ]);
    let id = existing?.id;
    if (id) {
      await db.run("UPDATE accounts SET name = ?, official_name = ?, mask = ?, subtype = ? WHERE id = ?", [
        a.name,
        a.official_name,
        a.mask,
        a.subtype,
        id,
      ]);
    } else {
      id = deps.newId();
      await db.run(
        `INSERT INTO accounts (id, connection_id, owner_id, plaid_account_id, name, official_name, mask,
           type, subtype, tax_treatment, currency, feed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'plaid', ?)`,
        [
          id,
          connectionId,
          DEFAULT_OWNER_ID,
          a.account_id,
          a.name,
          a.official_name,
          a.mask,
          type,
          a.subtype,
          taxTreatment(type, a.subtype),
          a.balances.iso_currency_code ?? "USD",
          deps.now().toISOString(),
        ],
      );
    }
    ids.set(a.account_id, id);
    if (a.balances.current !== null) {
      // Plaid reports what is owed on credit and loan accounts as a positive
      // number. Balances here are signed by worth to the owner.
      const sign = type === "credit" || type === "loan" ? -1 : 1;
      await db.run(
        `INSERT INTO balances (account_id, as_of, current_cents, available_cents, limit_cents, source)
         VALUES (?, ?, ?, ?, ?, 'plaid')
         ON CONFLICT(account_id, as_of) DO UPDATE SET current_cents = excluded.current_cents,
           available_cents = excluded.available_cents, limit_cents = excluded.limit_cents, source = 'plaid'`,
        [
          id,
          today,
          sign * toCents(a.balances.current),
          toCentsOrNull(a.balances.available),
          toCentsOrNull(a.balances.limit),
        ],
      );
    }
  }
  return ids;
}

async function upsertTransaction(
  deps: CoreDeps,
  accountIds: Map<string, string>,
  t: PlaidTransaction,
  nowIso: string,
): Promise<"inserted" | "updated" | null> {
  const { db } = deps;
  const accountId = accountIds.get(t.account_id);
  if (!accountId) return null;
  const pfc = t.personal_finance_category ?? null;
  const shared = [
    t.pending ? 1 : 0,
    t.pending_transaction_id,
    t.date,
    t.authorized_date,
    -toCents(t.amount), // Plaid: positive is money out. Ours: negative is money out.
    t.iso_currency_code ?? "USD",
    t.original_description?.trim() || t.name,
    t.merchant_name,
    pfc?.primary ?? null,
    pfc?.detailed ?? null,
    pfc?.confidence_level ?? null,
    t.merchant_category_code ?? null,
  ];
  const existing = await first<{ id: string }>(
    db,
    "SELECT id FROM transactions WHERE account_id = ? AND external_id = ?",
    [accountId, t.transaction_id],
  );
  if (existing) {
    await db.run(
      `UPDATE transactions SET pending = ?, pending_external_id = ?, posted_date = ?, authorized_date = ?,
         amount_cents = ?, currency = ?, description_raw = ?, merchant_raw = ?, plaid_pfc_primary = ?,
         plaid_pfc_detailed = ?, plaid_pfc_confidence = ?, mcc = ?, updated_at = ?, removed_at = NULL
       WHERE id = ?`,
      [...shared, nowIso, existing.id],
    );
    return "updated";
  }
  const id = deps.newId();
  await db.run(
    `INSERT INTO transactions (id, account_id, source, external_id, pending, pending_external_id, posted_date,
       authorized_date, amount_cents, currency, description_raw, merchant_raw, plaid_pfc_primary,
       plaid_pfc_detailed, plaid_pfc_confidence, mcc, created_at, updated_at)
     VALUES (?, ?, 'plaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, accountId, t.transaction_id, ...shared, nowIso, nowIso],
  );
  if (t.pending_transaction_id) {
    await carryOverFromPending(deps, accountId, t.pending_transaction_id, id, nowIso);
  }
  return "inserted";
}

/**
 * A posted transaction replaces its pending version. Anything a person (or
 * Claude) did to the pending row moves to the posted one, then the pending
 * row is soft-deleted. Works whether or not Plaid already sent the pending
 * row in `removed`, because removal is a soft delete.
 */
async function carryOverFromPending(
  deps: CoreDeps,
  accountId: string,
  pendingExternalId: string,
  postedId: string,
  nowIso: string,
): Promise<void> {
  const { db } = deps;
  const pending = await first<{
    id: string;
    category_id: string | null;
    category_source: string | null;
    note: string | null;
    excluded: number;
    reviewed_at: string | null;
    flag: string | null;
    is_split_parent: number;
  }>(db, "SELECT * FROM transactions WHERE account_id = ? AND external_id = ?", [accountId, pendingExternalId]);
  if (!pending) return;
  const locked = pending.category_source === "manual" || pending.category_source === "claude";
  await db.run(
    `UPDATE transactions SET category_id = COALESCE(?, category_id), category_source = COALESCE(?, category_source),
       note = ?, excluded = ?, reviewed_at = ?, flag = ?, is_split_parent = ? WHERE id = ?`,
    [
      locked ? pending.category_id : null,
      locked ? pending.category_source : null,
      pending.note,
      pending.excluded,
      pending.reviewed_at,
      pending.flag,
      pending.is_split_parent,
      postedId,
    ],
  );
  await db.run("UPDATE transaction_tags SET transaction_id = ? WHERE transaction_id = ?", [postedId, pending.id]);
  await db.run("UPDATE transactions SET parent_id = ? WHERE parent_id = ?", [postedId, pending.id]);
  await db.run(
    "UPDATE transactions SET removed_at = COALESCE(removed_at, ?), is_split_parent = 0, updated_at = ? WHERE id = ?",
    [nowIso, nowIso, pending.id],
  );
}

/** File imports for a Plaid-fed account are only accepted before this date. */
async function setBackfillBoundary(deps: CoreDeps, connectionId: string): Promise<void> {
  await deps.db.run(
    `UPDATE accounts SET file_backfill_before = (
       SELECT MIN(d) FROM (
         SELECT MIN(posted_date) AS d FROM transactions t
         WHERE t.account_id = accounts.id AND t.source = 'plaid' AND t.removed_at IS NULL
         UNION ALL
         SELECT MIN(date) FROM investment_transactions i
         WHERE i.account_id = accounts.id AND i.source = 'plaid'))
     WHERE connection_id = ? AND file_backfill_before IS NULL`,
    [connectionId],
  );
}

interface InvestmentData {
  holdings: HoldingsResponse | null;
  transactions: InvestmentTransactionsResponse["investment_transactions"];
  securities: PlaidSecurity[];
}

async function fetchInvestments(
  deps: CoreDeps,
  client: PlaidClient,
  token: string,
  connectionId: string,
  fetched: Fetched,
): Promise<InvestmentData | null> {
  try {
    const holdings = await fetched("/investments/holdings/get", {}, () => client.investmentsHoldingsGet(token));
    const seen = await first<{ n: number }>(
      deps.db,
      `SELECT COUNT(*) AS n FROM investment_transactions
       WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = ?)`,
      [connectionId],
    );
    const end = localDate(deps.now());
    const start = addDays(end, seen && seen.n > 0 ? -30 : -730);
    const transactions: InvestmentData["transactions"] = [];
    const securities = [...holdings.securities];
    for (;;) {
      const offset = transactions.length;
      const page = await fetched("/investments/transactions/get", { start_date: start, end_date: end, offset }, () =>
        client.investmentsTransactionsGet(token, start, end, offset),
      );
      transactions.push(...page.investment_transactions);
      securities.push(...page.securities);
      if (page.investment_transactions.length === 0 || transactions.length >= page.total_investment_transactions) {
        break;
      }
    }
    return { holdings, transactions, securities };
  } catch (err) {
    if (err instanceof PlaidError && INVESTMENT_SKIP_CODES.has(err.errorCode)) return null;
    throw err;
  }
}

function assetClass(s: PlaidSecurity): string {
  const type = (s.type ?? "").toLowerCase();
  if (s.is_cash_equivalent || type === "cash") return "cash";
  if (type === "fixed income") return "bond";
  if (type === "equity" || type === "etf") return "us_stock";
  return "other";
}

async function applyInvestments(
  deps: CoreDeps,
  accountIds: Map<string, string>,
  data: InvestmentData,
): Promise<void> {
  const { db } = deps;
  const securityIds = new Map<string, string>();
  for (const s of data.securities) {
    if (securityIds.has(s.security_id)) continue;
    const existing = await first<{ id: string }>(db, "SELECT id FROM securities WHERE plaid_security_id = ?", [
      s.security_id,
    ]);
    const id = existing?.id ?? deps.newId();
    if (!existing) {
      await db.run(
        "INSERT INTO securities (id, plaid_security_id, ticker, name, type, asset_class) VALUES (?, ?, ?, ?, ?, ?)",
        [id, s.security_id, s.ticker_symbol, s.name, s.type, assetClass(s)],
      );
    }
    securityIds.set(s.security_id, id);
  }
  const today = localDate(deps.now());
  for (const h of data.holdings?.holdings ?? []) {
    const accountId = accountIds.get(h.account_id);
    const securityId = securityIds.get(h.security_id);
    if (!accountId || !securityId) continue;
    await db.run(
      `INSERT INTO holdings (account_id, security_id, as_of, quantity, price, value_cents, cost_basis_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, security_id, as_of) DO UPDATE SET quantity = excluded.quantity,
         price = excluded.price, value_cents = excluded.value_cents, cost_basis_cents = excluded.cost_basis_cents`,
      [
        accountId,
        securityId,
        today,
        h.quantity,
        h.institution_price,
        toCents(h.institution_value),
        toCentsOrNull(h.cost_basis),
      ],
    );
  }
  for (const t of data.transactions) {
    const accountId = accountIds.get(t.account_id);
    if (!accountId) continue;
    await db.run(
      `INSERT INTO investment_transactions (id, account_id, external_id, date, security_id, type, subtype,
         quantity, price, amount_cents, fees_cents, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, external_id) DO UPDATE SET date = excluded.date, type = excluded.type,
         subtype = excluded.subtype, quantity = excluded.quantity, price = excluded.price,
         amount_cents = excluded.amount_cents, fees_cents = excluded.fees_cents, description = excluded.description`,
      [
        deps.newId(),
        accountId,
        t.investment_transaction_id,
        t.date,
        t.security_id ? (securityIds.get(t.security_id) ?? null) : null,
        t.type,
        t.subtype,
        t.quantity,
        t.price,
        -toCents(t.amount),
        toCentsOrNull(t.fees),
        t.name,
      ],
    );
  }
}
