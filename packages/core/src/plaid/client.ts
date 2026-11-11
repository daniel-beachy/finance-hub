import type { PlaidEnv } from "../secrets.ts";

/**
 * A thin fetch-based Plaid client: only the endpoints Finance Hub uses.
 * No SDK, so it runs unchanged in Node, the browser and a Worker.
 */

export interface PlaidCredentials {
  clientId: string;
  secret: string;
  env: PlaidEnv;
}

export class PlaidError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly errorCode: string;
  readonly requestId: string | null;
  readonly endpoint: string;

  constructor(endpoint: string, status: number, body: Partial<PlaidErrorBody>) {
    super(`Plaid ${endpoint} failed: ${body.error_code ?? status} ${body.error_message ?? ""}`.trim());
    this.name = "PlaidError";
    this.endpoint = endpoint;
    this.status = status;
    this.errorType = body.error_type ?? "UNKNOWN";
    this.errorCode = body.error_code ?? `HTTP_${status}`;
    this.requestId = body.request_id ?? null;
  }
}

interface PlaidErrorBody {
  error_type: string;
  error_code: string;
  error_message: string;
  request_id: string;
}

export interface PlaidItem {
  item_id: string;
  institution_id: string | null;
  institution_name?: string | null;
  products?: string[];
  billed_products?: string[];
  available_products?: string[];
  consent_expiration_time: string | null;
  error: { error_code: string; error_message: string } | null;
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Positive when money leaves the account. Finance Hub flips this on ingest. */
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  original_description?: string | null;
  merchant_name: string | null;
  merchant_entity_id?: string | null;
  merchant_category_code?: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  personal_finance_category?: {
    primary: string;
    detailed: string;
    confidence_level?: string | null;
  } | null;
}

export interface TransactionsSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  next_cursor: string;
  has_more: boolean;
  request_id: string;
}

export interface PlaidSecurity {
  security_id: string;
  ticker_symbol: string | null;
  name: string | null;
  type: string | null;
  is_cash_equivalent?: boolean | null;
}

export interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number | null;
  institution_value: number;
  cost_basis: number | null;
}

export interface HoldingsResponse {
  accounts: PlaidAccount[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
}

export interface PlaidInvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  security_id: string | null;
  date: string;
  name: string;
  quantity: number;
  /** Positive when cash leaves the account (a buy). Flipped on ingest. */
  amount: number;
  price: number;
  fees: number | null;
  type: string;
  subtype: string;
}

export interface InvestmentTransactionsResponse {
  investment_transactions: PlaidInvestmentTransaction[];
  securities: PlaidSecurity[];
  total_investment_transactions: number;
}

export type LinkKind = "bank" | "investment";

export interface LinkTokenOptions {
  userId: string;
  /** New link: which product must be supported. Ignored in update mode. */
  kind?: LinkKind;
  /** Update mode: re-authenticate this Item. Creates no new Item. */
  accessToken?: string;
  daysRequested?: number;
  hosted?: boolean;
}

export interface LinkTokenResponse {
  link_token: string;
  expiration: string;
  hosted_link_url?: string;
}

const BASE_URLS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

/** History depth is fixed when an Item is created, so always ask for the maximum. */
export const DAYS_REQUESTED = 730;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class PlaidClient {
  readonly env: PlaidEnv;
  #creds: PlaidCredentials;
  #fetch: FetchLike;

  constructor(creds: PlaidCredentials, fetchImpl: FetchLike = (i, init) => fetch(i, init)) {
    this.#creds = creds;
    this.env = creds.env;
    this.#fetch = fetchImpl;
  }

  async #post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.#fetch(`${BASE_URLS[this.env]}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.#creds.clientId, secret: this.#creds.secret, ...body }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PlaidError(endpoint, res.status, { error_message: "Response was not JSON" });
    }
    if (!res.ok) throw new PlaidError(endpoint, res.status, json as Partial<PlaidErrorBody>);
    return json as T;
  }

  linkTokenCreate(opts: LinkTokenOptions): Promise<LinkTokenResponse> {
    const body: Record<string, unknown> = {
      client_name: "Finance Hub",
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: opts.userId },
    };
    if (opts.accessToken) {
      body.access_token = opts.accessToken;
    } else {
      // An investment-only institution does not support Transactions, so the
      // required product depends on what is being linked. The other product
      // is added wherever the institution supports it.
      const investment = opts.kind === "investment";
      body.products = [investment ? "investments" : "transactions"];
      body.required_if_supported_products = [investment ? "transactions" : "investments"];
      body.transactions = { days_requested: opts.daysRequested ?? DAYS_REQUESTED };
    }
    if (opts.hosted) body.hosted_link = {};
    return this.#post("/link/token/create", body);
  }

  linkTokenGet(linkToken: string): Promise<{
    link_sessions?: {
      finished_at?: string | null;
      results?: { item_add_results?: { public_token: string; institution?: { institution_id: string; name: string } }[] };
    }[];
  }> {
    return this.#post("/link/token/get", { link_token: linkToken });
  }

  publicTokenExchange(publicToken: string): Promise<{ access_token: string; item_id: string }> {
    return this.#post("/item/public_token/exchange", { public_token: publicToken });
  }

  itemGet(accessToken: string): Promise<{ item: PlaidItem }> {
    return this.#post("/item/get", { access_token: accessToken });
  }

  accountsGet(accessToken: string): Promise<{ accounts: PlaidAccount[]; item: PlaidItem }> {
    return this.#post("/accounts/get", { access_token: accessToken });
  }

  transactionsSync(accessToken: string, cursor: string | null): Promise<TransactionsSyncResponse> {
    return this.#post("/transactions/sync", {
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
      count: 500,
      options: { include_original_description: true },
    });
  }

  investmentsHoldingsGet(accessToken: string): Promise<HoldingsResponse> {
    return this.#post("/investments/holdings/get", { access_token: accessToken });
  }

  investmentsTransactionsGet(
    accessToken: string,
    startDate: string,
    endDate: string,
    offset: number,
  ): Promise<InvestmentTransactionsResponse> {
    return this.#post("/investments/transactions/get", {
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500, offset },
    });
  }

  // Sandbox-only helpers, used for development and tests. They cannot touch
  // a real institution.

  sandboxPublicTokenCreate(
    institutionId: string,
    products: string[],
  ): Promise<{ public_token: string }> {
    this.#requireSandbox();
    return this.#post("/sandbox/public_token/create", {
      institution_id: institutionId,
      initial_products: products,
      options: { transactions: { days_requested: DAYS_REQUESTED } },
    });
  }

  sandboxItemResetLogin(accessToken: string): Promise<{ reset_login: boolean }> {
    this.#requireSandbox();
    return this.#post("/sandbox/item/reset_login", { access_token: accessToken });
  }

  #requireSandbox() {
    if (this.env !== "sandbox") throw new Error("Sandbox helpers are not available in production");
  }
}
