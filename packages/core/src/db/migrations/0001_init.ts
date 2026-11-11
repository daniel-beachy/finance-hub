/**
 * Initial schema. Conventions (see docs/PLAN.md section 4):
 * - Money is integer cents. For transactions, negative is money out of the
 *   account and positive is money in.
 * - Balances are signed by what the account is worth to its owner, so a
 *   credit card or loan balance is negative and net worth is a plain sum.
 * - Dates are YYYY-MM-DD text, timestamps ISO 8601 UTC text, IDs ULID text.
 * - Booleans are INTEGER 0/1. JSON is stored as TEXT.
 */
export const init = /* sql */ `
CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('plaid', 'file')),
  plaid_env TEXT CHECK (plaid_env IN ('sandbox', 'production')),
  institution_id TEXT,
  institution_name TEXT NOT NULL,
  plaid_item_id TEXT UNIQUE,
  days_requested INTEGER,
  transactions_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'login_required', 'pending_disconnect', 'error', 'removed')),
  consent_expires_at TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES connections(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  plaid_account_id TEXT UNIQUE,
  name TEXT NOT NULL,
  official_name TEXT,
  mask TEXT,
  type TEXT NOT NULL
    CHECK (type IN ('depository', 'credit', 'investment', 'loan', 'property', 'other')),
  subtype TEXT,
  tax_treatment TEXT NOT NULL DEFAULT 'none'
    CHECK (tax_treatment IN ('taxable', 'traditional', 'roth', 'hsa', 'fsa', 'espp', 'rsu', 'none')),
  currency TEXT NOT NULL DEFAULT 'USD',
  feed TEXT NOT NULL CHECK (feed IN ('plaid', 'file', 'manual')),
  file_backfill_before TEXT,
  include_in_net_worth INTEGER NOT NULL DEFAULT 1,
  closed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX accounts_connection ON accounts(connection_id);

CREATE TABLE balances (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of TEXT NOT NULL,
  current_cents INTEGER NOT NULL,
  available_cents INTEGER,
  limit_cents INTEGER,
  source TEXT NOT NULL CHECK (source IN ('plaid', 'file', 'manual')),
  PRIMARY KEY (account_id, as_of)
);

CREATE TABLE category_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES category_groups(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'investment')),
  hidden INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL
);

CREATE TABLE plaid_category_map (
  pfc_key TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id)
);

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_key TEXT NOT NULL UNIQUE,
  plaid_entity_id TEXT,
  default_category_id TEXT REFERENCES categories(id)
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  match TEXT NOT NULL,
  actions TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('seed', 'user', 'claude')),
  created_from_transaction_id TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX rules_priority ON rules(enabled, priority);

CREATE TABLE transfer_groups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('internal_transfer', 'card_payment', 'investment_contribution'))
);

CREATE TABLE import_files (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  parser TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  rows_total INTEGER NOT NULL,
  rows_added INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL CHECK (source IN ('plaid', 'file', 'manual')),
  external_id TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  pending_external_id TEXT,
  posted_date TEXT NOT NULL,
  authorized_date TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  description_raw TEXT NOT NULL,
  merchant_raw TEXT,
  merchant_id TEXT REFERENCES merchants(id),
  category_id TEXT REFERENCES categories(id),
  category_source TEXT
    CHECK (category_source IN ('transfer', 'rule', 'memory', 'plaid', 'claude', 'manual')),
  rule_id TEXT REFERENCES rules(id),
  needs_review INTEGER NOT NULL DEFAULT 0,
  plaid_pfc_primary TEXT,
  plaid_pfc_detailed TEXT,
  plaid_pfc_confidence TEXT,
  mcc TEXT,
  transfer_group_id TEXT REFERENCES transfer_groups(id),
  parent_id TEXT REFERENCES transactions(id),
  is_split_parent INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  import_file_id TEXT REFERENCES import_files(id),
  reviewed_at TEXT,
  review_reasons TEXT,
  flag TEXT CHECK (flag IN ('suspicious', 'disputed', 'resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (account_id, external_id)
);
CREATE INDEX transactions_date ON transactions(posted_date);
CREATE INDEX transactions_account_date ON transactions(account_id, posted_date);
CREATE INDEX transactions_category ON transactions(category_id, posted_date);
CREATE INDEX transactions_merchant ON transactions(merchant_id);
CREATE INDEX transactions_review ON transactions(needs_review) WHERE needs_review = 1;
CREATE INDEX transactions_parent ON transactions(parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE recurring_series (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  account_id TEXT REFERENCES accounts(id),
  cadence TEXT NOT NULL
    CHECK (cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
  typical_amount_cents INTEGER NOT NULL,
  last_date TEXT,
  next_expected_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'ignored')),
  is_subscription INTEGER NOT NULL DEFAULT 0,
  category_id TEXT REFERENCES categories(id)
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  month TEXT,
  amount_cents INTEGER NOT NULL,
  rollover INTEGER NOT NULL DEFAULT 0,
  UNIQUE (category_id, month)
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'duplicate', 'large', 'new_merchant', 'fee', 'price_increase',
    'new_subscription', 'missed_recurring', 'connection')),
  transaction_id TEXT REFERENCES transactions(id),
  series_id TEXT REFERENCES recurring_series(id),
  connection_id TEXT REFERENCES connections(id),
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL,
  dismissed_at TEXT
);
CREATE INDEX alerts_open ON alerts(dismissed_at) WHERE dismissed_at IS NULL;

CREATE TABLE securities (
  id TEXT PRIMARY KEY,
  plaid_security_id TEXT UNIQUE,
  ticker TEXT,
  name TEXT,
  type TEXT,
  asset_class TEXT NOT NULL DEFAULT 'other'
    CHECK (asset_class IN ('us_stock', 'intl_stock', 'bond', 'cash', 'real_estate', 'other'))
);

CREATE TABLE holdings (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  security_id TEXT NOT NULL REFERENCES securities(id),
  as_of TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL,
  value_cents INTEGER NOT NULL,
  cost_basis_cents INTEGER,
  PRIMARY KEY (account_id, security_id, as_of)
);

CREATE TABLE investment_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  external_id TEXT NOT NULL,
  date TEXT NOT NULL,
  security_id TEXT REFERENCES securities(id),
  type TEXT,
  subtype TEXT,
  quantity REAL,
  price REAL,
  amount_cents INTEGER NOT NULL,
  fees_cents INTEGER,
  description TEXT,
  UNIQUE (account_id, external_id)
);
CREATE INDEX investment_transactions_date ON investment_transactions(account_id, date);

CREATE TABLE equity_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL CHECK (kind IN ('rsu', 'espp')),
  ticker TEXT NOT NULL,
  grant_date TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE TABLE scenarios (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('retirement', 'house', 'tax')),
  name TEXT NOT NULL,
  params TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'mcp')),
  connection_id TEXT REFERENCES connections(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'login_required')),
  added INTEGER NOT NULL DEFAULT 0,
  modified INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX sync_runs_started ON sync_runs(started_at);

CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'claude', 'system')),
  tool TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before TEXT,
  after TEXT,
  undone_at TEXT
);
CREATE INDEX changes_entity ON changes(entity, entity_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
