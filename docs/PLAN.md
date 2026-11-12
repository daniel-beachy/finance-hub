# Finance Hub build plan

Written 2026-11-10 in a planning session with Dan. This is the spec and build plan. A later session builds from it without re-deciding anything here. If something in this plan turns out to be wrong or impossible, follow the rule in [When the plan is wrong](#when-the-plan-is-wrong).

## 1. What we're building

A personal finance system that runs on Dan's Mac. It pulls every transaction and balance from his accounts, categorizes them, shows them in a local dashboard, and exposes them to Claude so he can ask questions, fix categories, and run retirement, house and tax scenarios. A demo on GitHub Pages runs the same app on synthetic data.

### Agreed with Dan

| Topic | Decision |
|---|---|
| Cost | Free only. No subscriptions, no API keys that bill per use. |
| Data source | Plaid's free Trial plan for the automatic feed. CSV/QFX file import for anything Plaid can't reach. |
| Where data lives | On the Mac only (playbook tier 5). Keep a private hosted version possible later. |
| Claude | Claude acts inside the system on Dan's Pro plan, through an MCP server. |
| Scope order | Transactions first, if the feed proves out at the gate (M2). Otherwise fall back to net worth plus retirement and house advice. |
| Day-to-day features | In the style of Monarch Money or Copilot Money: budgets, subscriptions and bills, anomaly alerts, weekly review with Claude. |
| LLM categorizing | Manual for now: a review queue Claude clears when Dan asks. Automatic runs are deferred until reliability and cost are measured. |
| House advice | Buying first, then owner questions once there's a mortgage. |
| Household | Dan only, with an owner on every account so a partner can be added later. |
| Review | A Review section where Dan goes through large purchases and unfamiliar charges, says what they are, and flags fraud or mistakes. (Added 2026-11-10.) |
| Backups | Everything fetched is kept: raw Plaid responses are archived, and the database and archive are copied to iCloud Drive's `Backups` folder. (Added 2026-11-10.) |
| Repo | Public, `daniel-beachy/finance-hub`, with a demo mode for the portfolio. |

### Accounts in scope

- Capital One: checking, savings, credit cards.
- Chase: credit card.
- Citi: credit card.
- Fidelity: IRA, 401k, taxable brokerage, HSA, FSA, RSU, ESPP.

### Out of scope

- Moving money, paying bills, trading. The system is read-only toward institutions.
- A mobile app, multi-user login, credit score, receipt scanning.
- A chat box inside the dashboard (needs a paid API key).
- Tax filing. Tax output is an estimate for planning.

## 2. Research findings the design depends on

Checked 2026-11-10 against Plaid's docs. Re-check anything marked unverified before relying on it.

- **Trial plan:** free real data for new teams (US/Canada) created on or after 2026-04-15. Products include Transactions, Investments, Liabilities and Balance.
- **10 Items for life:** "Removing Items created on a Trial plan will not allow you to create more Items." Every production access token counts. One Item is one institution login.
- **Do not apply for production access.** A third-party report says applying moves the team off Trial with no way back. Dan signs up choosing "Personal use" and stops there.
- **OAuth banks:** since 2026-05-20, Trial teams get immediate access to all OAuth institutions. Chase, Capital One and Citi are OAuth.
- **Fidelity:** unverified on Trial. Paid plans must request Fidelity access on the Dashboard's OAuth institutions page. NetBenefits (401k, RSU, ESPP) coverage is unverified. Fidelity's OFX direct download appears shut off since late 2025.
- **Link on desktop web needs no redirect URI.** OAuth opens in a popup. Production redirect URIs must be HTTPS, so we avoid needing one.
- **Hosted Link** is the fallback: `/link/token/create` with `hosted_link: {}` returns a `hosted_link_url`, and `/link/token/get` returns the public token for six hours after the session ends. No webhook needed.
- **History depth is fixed at link time.** `transactions.days_requested` defaults to 90, maximum 730, and can't be changed once Transactions is on the Item.
- **`/transactions/sync`** returns `added`, `modified`, `removed` and a cursor. Plaid `amount` is positive when money leaves the account. Plaid refreshes one to four times a day.
- **Update mode** re-authenticates an Item with the same access token, so it creates no new Item. Whether it touches the Trial limit is not stated; the same token implies not.
- **Consent expiry:** Chase users choose 6 months, 1 year or "always". `consent_expiration_time` is on `/item/get`. `PENDING_DISCONNECT` arrives seven days before expiry.
- **Investments** are polled: `/investments/holdings/get` and `/investments/transactions/get` (date range, up to 24 months, count/offset paging).
- **SimpleFIN** costs $15/year, so it's out.

## 3. Architecture

```text
            Plaid API                      CSV / QFX exports
                |                                  |
        +-------v----------------------------------v-------+
        |  core (pure TypeScript, no Node APIs)            |
        |  plaid client · importers · categorizer ·        |
        |  queries · detectors · projections · Hono API    |
        +---^-----------------^-----------------^----------+
            |                 |                 |
     SqlDriver: node    SqlDriver: wasm    SqlDriver: D1
            |                 |              (future)
   +--------+--------+   +----+------+
   | server (Node)   |   | web demo  |
   | fh CLI          |   | on Pages  |
   | local HTTP API  |   | synthetic |
   | MCP server      |   +-----------+
   | launchd sync    |
   +-----------------+
        |        |
   dashboard   Claude Code / Claude desktop
   (browser)   (MCP over stdio)
```

### Stack

| Piece | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere, Node 26 | One language for core, server, web and a future Worker. Node 26 is installed. |
| Layout | npm workspaces: `packages/core`, `packages/server`, `packages/web` | Core must be importable by the browser demo and a future Worker. |
| Database | SQLite, file on disk | Single user, zero setup, and D1 is SQLite, so the hosted option reuses the schema. |
| Node driver | `node:sqlite` (built in) | No native build step. If it lacks something needed, use `better-sqlite3` behind the same `SqlDriver`. |
| Browser driver | `sql.js` | The demo loads a prebuilt synthetic database into memory. |
| HTTP API | Hono | Runs in Node, in the browser and on Workers with the same code. |
| Plaid client | A thin `fetch` wrapper in core, about eight endpoints | The official SDK depends on axios and Node. A fetch client ports to Workers. |
| Dashboard | React, Vite, React Router (hash routes), TanStack Query, Tailwind v4, Recharts | Matches Dan's other projects. Hash routes work on Pages. |
| MCP | `@modelcontextprotocol/sdk`, stdio transport | Works with Claude Code and Claude desktop on the Pro plan. |
| Tests | Vitest, plus Playwright for a few dashboard flows | |
| Schedule | launchd user agent | Native to macOS, and runs a missed job on wake. |
| Secrets | macOS Keychain through the `security` command | No secret ever sits in a file. |

### The `SqlDriver` seam

Core never imports a database library. It takes a driver:

```ts
interface SqlDriver {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
```

It's async because D1 is async. Three implementations: `node` (server), `wasm` (demo), and `d1` (future, not built now).

### One API, three callers

`createApp(deps)` in core returns the Hono app. `deps` holds the `SqlDriver`, a `SecretStore`, a clock and a `fetch`.

- **Local dashboard:** the server serves the app at `http://127.0.0.1:5202`. The web client calls it over HTTP.
- **Demo:** the web client calls `app.fetch(request)` in the browser, with the wasm driver. No network, same routes, and writes work in memory until reload.
- **MCP server:** tools call the same core functions the routes call. Routes and tools are both thin wrappers; logic lives in core functions.

The web client picks its transport from `import.meta.env.VITE_MODE` (`local` or `demo`).

### Where things live on disk

| What | Where |
|---|---|
| Repo | `~/AI_PROJECTS/finance-hub` (public, no personal data) |
| Data directory | `~/Library/Application Support/finance-hub/`, overridable with `FH_DATA_DIR` |
| Database | `<data>/finance.db` (WAL mode) |
| Import inbox | `<data>/inbox/`, processed files move to `<data>/imported/` |
| Raw archive | `<data>/raw/plaid/<connection id>/<UTC timestamp>-<endpoint>.json.gz`, append-only, never pruned |
| Local backups | `<data>/backups/finance-YYYY-MM-DD.db`, 14 kept |
| iCloud backups | `~/Library/Mobile Documents/com~apple~CloudDocs/Backups/finance-hub/` (`settings.backup_dir`): the same dated database copies, 30 daily plus the first of every month kept forever, and a mirror of `raw/` and `imported/` |
| Logs | `<data>/logs/sync.log` |
| Plaid credentials and access tokens | Keychain, service `finance-hub`. Accounts: `plaid-client-id`, `plaid-secret-sandbox`, `plaid-secret-production`, and `plaid-token-<connection id>` per connection |
| Dev ports | Vite on 5201, API on 5202 (add to `~/AI_PROJECTS/.claude/launch.json`) |

The live data directory is deliberately outside iCloud and outside the repo, because iCloud can corrupt a SQLite file that's being written. Only finished, closed files are copied into the iCloud backup folder. Disk encryption is FileVault's job; the database is not separately encrypted. The iCloud copy means Dan's financial history is stored in his iCloud account, which he asked for.

### Raw archive and backups

Plaid gives history once, at link time, and a lost connection can't be re-linked without spending a slot. So nothing fetched is ever thrown away.

- **Raw archive.** Every Plaid response that carries data (`/accounts/get`, each `/transactions/sync` page, `/investments/holdings/get`, `/investments/transactions/get`, `/item/get`) is written gzipped and unmodified to the raw archive **before** it's applied to the database. Files are append-only.
- **Replay.** `fh replay` rebuilds accounts, balances, transactions, holdings and investment transactions in an empty database from the raw archive alone, applying files in timestamp order through the same code path as a live sync. Manual work (categories, rules, notes, budgets) is not in the archive; that's what the database backups are for.
- **Imported files** are kept in `<data>/imported/` exactly as received.
- **After every successful sync:** `VACUUM INTO` a dated local backup, then copy it and any new raw and imported files to the iCloud backup folder. A failed copy raises a `connection`-kind alert but doesn't fail the sync.
- **`fh restore <file>`** replaces the database with a backup after confirming, and keeps the replaced file as `finance.db.before-restore`.
- **`fh backup`** runs the backup step on demand.
- Access tokens are not in any backup. They exist only in the Keychain, so a new Mac needs the Keychain items moved by hand. Say this in the README.

### Privacy rules for a public repo

- Real data never enters the repo: no exports, no database, no screenshots of real data, no real merchant rules.
- Test fixtures are synthetic only. When a parser needs a real file's shape, copy the header row and invent the data rows.
- User-created rules and categories live in the database. The repo ships only generic seed data.
- `.gitignore` covers `*.db`, `*.sqlite` (except `packages/web/public/demo.sqlite`), `*.csv`, `*.qfx`, `*.ofx`, `.env*`. Fixtures live under `**/fixtures/` and are force-added.
- A pre-commit hook rejects those file types outside `fixtures/`.
- When Claude uses the MCP tools, the rows it reads go to Anthropic as part of the conversation. Dan accepted this. Tools return aggregates by default and cap row counts.

### Local server safety

- Binds `127.0.0.1` only.
- Rejects requests whose `Host` isn't `127.0.0.1:5202` or `localhost:5202` (blocks DNS rebinding).
- Sends no CORS headers and rejects any request with an `Origin` other than its own.

### Keeping the hosted option open

These are the only things done now for the future hosted version. Nothing else is built for it.

- Core uses no Node APIs.
- The driver is async and the SQL stays inside what D1 supports (no extensions, no `ATTACH`).
- `SecretStore` is an interface (`get`, `set`, `delete`). Keychain is the only implementation.
- `syncAll(deps)` is a plain function a cron trigger could call.

A hosted version would also need login (Cloudflare Access) and a decision about keeping financial history in Cloudflare. Both are deferred.

## 4. Data model

Conventions:

- Money is integer cents in `*_cents` columns. **Negative is money out of the account, positive is money in.** Plaid's sign is the opposite, so flip it on ingest.
- Dates are `YYYY-MM-DD` text. Timestamps are ISO 8601 UTC text.
- IDs are ULIDs as text unless noted.
- Share quantities and prices are `REAL`.
- Migrations are numbered SQL files in `packages/core/migrations/`, applied in order and recorded in `schema_migrations`.

### Tables

**`owners`** `id`, `name`. Seeded with one row. Every account points at an owner.

**`connections`** One per institution login.

- `id`, `source` (`plaid`, `file`), `institution_id`, `institution_name`
- `plaid_item_id`, `days_requested`, `transactions_cursor`
- `status` (`ok`, `login_required`, `pending_disconnect`, `error`, `removed`)
- `consent_expires_at`, `last_synced_at`, `last_error`, `created_at`
- The access token is in the Keychain under `plaid-token-<connection id>`, never in the database.

**`accounts`**

- `id`, `connection_id` (null for manual), `owner_id`, `plaid_account_id`
- `name`, `official_name`, `mask`
- `type` (`depository`, `credit`, `investment`, `loan`, `property`, `other`), `subtype`
- `tax_treatment` (`taxable`, `traditional`, `roth`, `hsa`, `fsa`, `espp`, `rsu`, `none`)
- `feed` (`plaid`, `file`, `manual`): the single source of truth for this account's transactions
- `file_backfill_before` (date, nullable): file imports are accepted only for dates before this
- `include_in_net_worth`, `closed_at`

**`balances`** Daily snapshot. PK (`account_id`, `as_of`). `current_cents`, `available_cents`, `limit_cents`, `source` (`plaid`, `file`, `manual`). Manual assets such as a house are an account of type `property` whose value is a manual balance.

**`transactions`**

- `id`, `account_id`, `source` (`plaid`, `file`, `manual`)
- `external_id`: Plaid `transaction_id`, or the file fingerprint. Unique with `account_id`.
- `pending`, `pending_external_id`
- `posted_date`, `authorized_date`, `amount_cents`, `currency`
- `description_raw`, `merchant_raw`, `merchant_id`
- `category_id`, `category_source` (`transfer`, `rule`, `memory`, `plaid`, `claude`, `manual`), `rule_id`, `needs_review`
- `plaid_pfc_primary`, `plaid_pfc_detailed`, `plaid_pfc_confidence`, `mcc`
- `transfer_group_id`
- `parent_id`, `is_split_parent` (splits: children carry the categories, the parent is excluded from sums)
- `excluded`, `note`, `import_file_id`
- `reviewed_at` (null until Dan or Claude has looked at it in Review), `review_reasons` JSON (why it was put in Review), `flag` (null, `suspicious`, `disputed`, `resolved`)
- `created_at`, `updated_at`, `removed_at` (soft delete when Plaid sends `removed`)

**`merchants`** `id`, `name`, `normalized_key` (unique), `plaid_entity_id`, `default_category_id`.

**`category_groups`** `id` (slug), `name`, `sort`.

**`categories`** `id` (slug), `group_id`, `name`, `kind` (`income`, `expense`, `transfer`, `investment`), `hidden`, `sort`.

**`plaid_category_map`** `pfc_detailed`, `category_id`. Seed data mapping every Plaid detailed category to ours.

**`rules`**

- `id`, `priority` (lower runs first), `enabled`
- `match` JSON: any of `merchant_key`, `description_contains`, `description_regex`, `account_id`, `amount_min_cents`, `amount_max_cents`, `direction` (`in`, `out`), `plaid_pfc_detailed`. All given fields must match.
- `actions` JSON: any of `category_id`, `merchant_id`, `add_tags`, `exclude`
- `origin` (`seed`, `user`, `claude`), `created_from_transaction_id`, `hit_count`, `created_at`

**`tags`**, **`transaction_tags`** Free-form labels.

**`transfer_groups`** `id`, `kind` (`internal_transfer`, `card_payment`, `investment_contribution`). Links the two sides of a transfer.

**`recurring_series`** `id`, `merchant_id`, `account_id`, `cadence` (`weekly`, `biweekly`, `monthly`, `quarterly`, `yearly`), `typical_amount_cents`, `last_date`, `next_expected_date`, `status` (`active`, `ended`, `ignored`), `is_subscription`, `category_id`.

**`budgets`** `id`, `category_id`, `month` (`YYYY-MM`, or null for the default that applies to every month without its own row), `amount_cents`, `rollover`.

**`alerts`** `id`, `kind` (`duplicate`, `large`, `new_merchant`, `fee`, `price_increase`, `new_subscription`, `missed_recurring`, `connection`), `transaction_id`, `series_id`, `connection_id`, `message`, `data` JSON, `created_at`, `dismissed_at`.

**`securities`** `id`, `plaid_security_id`, `ticker`, `name`, `type`, `asset_class` (`us_stock`, `intl_stock`, `bond`, `cash`, `real_estate`, `other`).

**`holdings`** Daily snapshot. PK (`account_id`, `security_id`, `as_of`). `quantity`, `price`, `value_cents`, `cost_basis_cents`.

**`investment_transactions`** `id`, `account_id`, `external_id`, `date`, `security_id`, `type`, `subtype`, `quantity`, `price`, `amount_cents`, `fees_cents`, `description`.

**`equity_grants`** Manual entry for RSU and ESPP. `id`, `owner_id`, `kind` (`rsu`, `espp`), `ticker`, `grant_date`, `details` JSON (vest schedule or offering period, discount, purchase price).

**`scenarios`** `id`, `kind` (`retirement`, `house`, `tax`), `name`, `params` JSON, `result` JSON, `created_at`, `updated_at`.

**`import_files`** `id`, `sha256` (unique), `filename`, `parser`, `account_id`, `rows_total`, `rows_added`, `imported_at`.

**`sync_runs`** `id`, `started_at`, `finished_at`, `trigger` (`schedule`, `manual`, `mcp`), `connection_id`, `status`, `added`, `modified`, `removed`, `error_code`, `error_message`. This is the reliability record for the later decision on automation.

**`changes`** Audit log and undo. `id`, `at`, `actor` (`user`, `claude`, `system`), `tool`, `entity`, `entity_id`, `before` JSON, `after` JSON, `undone_at`. Every write from the dashboard or MCP records one row per changed entity.

**`settings`** `key`, `value` JSON.

### Category taxonomy (seed)

Two levels. Dan can rename, hide and add categories; IDs are stable slugs.

| Group | Categories |
|---|---|
| Income | Paycheck, Bonus, Equity compensation, Interest, Dividends, Refunds and reimbursements, Other income |
| Housing | Rent, Mortgage, Property tax, Home insurance, HOA, Maintenance and repairs, Furnishings |
| Utilities | Electric and gas, Water and trash, Internet, Mobile phone |
| Food | Groceries, Restaurants, Coffee, Delivery, Alcohol and bars |
| Transport | Fuel, Car payment, Car insurance, Maintenance, Parking and tolls, Rideshare and transit |
| Shopping | General merchandise, Clothing, Electronics, Home goods, Gifts |
| Health | Medical, Dental and vision, Pharmacy, Fitness, Health insurance |
| Entertainment | Streaming, Games, Events, Hobbies, Books and media |
| Travel | Flights, Lodging, Rental cars, Travel activities |
| Personal | Personal care, Education, Pets, Childcare, Charity |
| Financial | Fees, Interest paid, Taxes paid, Financial services |
| Software | Subscriptions and apps, Cloud and AI services |
| Transfers | Internal transfer, Credit card payment, Investment contribution, Loan principal |
| Uncategorized | Uncategorized |

Transfers have kind `transfer` and never count as spending or income.

## 5. Ingestion

### Plaid

Client endpoints: `/link/token/create`, `/link/token/get`, `/item/public_token/exchange`, `/item/get`, `/accounts/get`, `/transactions/sync`, `/investments/holdings/get`, `/investments/transactions/get`.

**Environments.** `settings.plaid_env` is `sandbox` or `production`. All development and all automated tests use Sandbox. Production calls happen only with Dan's real keys in the Keychain.

**Linking.** The dashboard's Accounts page runs Link.

1. `POST /api/connections/link-token` creates a link token with products `transactions`, optional products `investments`, `transactions.days_requested: 730`, country `US`, no `redirect_uri`.
2. The page opens Link from Plaid's web SDK. OAuth banks open a popup.
3. On success the page posts the public token to `/api/connections/exchange`.
4. The server exchanges it and **writes the access token to the Keychain before doing anything else**, then creates the `connections` and `accounts` rows.

If embedded Link fails in production on `http://localhost`, switch to Hosted Link: create the token with `hosted_link: {}`, open `hosted_link_url` in a new tab, and poll `/link/token/get` every 3 seconds until the session finishes. Try embedded first; record which one worked in the README.

**Slot protection.** The Trial plan's 10 Items are never refunded.

- The Accounts page shows "Plaid connections used: n of 10".
- Linking a new institution in production shows a confirmation naming the slot it will use.
- Nothing in the code calls `/item/remove`. Disconnecting marks the connection `removed` locally and keeps the token.
- Re-authentication always uses update mode (a link token created with the existing access token).
- `fh link` in production refuses to run non-interactively.

**Sync (`syncConnection`).**

1. `/item/get`: store `consent_expires_at`. On `ITEM_LOGIN_REQUIRED` set status `login_required`, raise a `connection` alert and stop.
2. `/accounts/get`: upsert accounts and write today's `balances` row.
3. `/transactions/sync` loop from the stored cursor until `has_more` is false. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, restart from the cursor the loop began with. Apply `added` and `modified` as upserts on (`account_id`, `external_id`), and `removed` as a soft delete. Save the cursor only after the whole loop commits.
4. Pending handling: when a posted transaction arrives with `pending_transaction_id`, copy the pending row's manual fields (category if `category_source` is `manual` or `claude`, note, tags, splits) onto it, then soft-delete the pending row.
5. For investment accounts: `/investments/holdings/get` into today's `holdings`, and `/investments/transactions/get` for the last 30 days (24 months on first sync), upserted by `external_id`.
6. Run the categorizer over new and modified rows, then the detectors (M6).
7. Write a `sync_runs` row either way.

`syncAll` runs every connection in turn; one failure doesn't stop the others.

**Schedule.** `fh install` writes `~/Library/LaunchAgents/com.finance-hub.sync.plist` to run `fh sync` daily at 06:30. After a successful run it backs up the database with `VACUUM INTO` and prunes backups past 14. On a `login_required` or `pending_disconnect` status it posts a macOS notification through `osascript`. `fh uninstall` removes the agent.

### File import

For Fidelity accounts Plaid can't reach, and for history older than Plaid's 24 months.

- Drop files into `<data>/inbox/`, or use the dashboard's upload button. `fh import` processes the inbox and runs as part of `fh sync`.
- A file's SHA-256 is checked against `import_files`; a repeat is skipped.
- Each parser declares a `detect(headerRow)` function and returns normalized rows. The first parser whose `detect` matches wins. An unmatched file stays in the inbox and raises an alert.
- The account is matched by the account number or name inside the file. If it can't be matched, the import stops and the dashboard asks Dan to pick the account once; the choice is remembered in `settings`.
- **Fingerprint:** `sha256(account_id | posted_date | amount_cents | normalized description | n)`, where `n` counts identical rows within the same file, so two identical coffee purchases on one day both survive and a re-export of the same period adds nothing.
- **One feed per account.** A `plaid` account accepts file rows only for dates before `file_backfill_before`, which is set to the earliest Plaid transaction date at first sync. A `file` account accepts everything. This rule is what prevents double counting; don't replace it with fuzzy matching.

Parsers to build, in this order:

1. Generic OFX/QFX (covers Capital One, Chase and Citi downloads for backfill).
2. Fidelity brokerage activity CSV (`History_for_Account_*.csv`).
3. Fidelity positions CSV (`Portfolio_Positions_*.csv`), which writes `holdings` and `balances`.
4. Fidelity NetBenefits activity CSV.
5. Capital One, Chase and Citi CSV, only if their QFX downloads prove unusable.

Parsers 2 to 4 need the real header rows. See [What the builder needs from Dan](#9-what-the-builder-needs-from-dan).

## 6. Categorization

Deterministic first. An LLM only ever sees what the steps below leave behind.

For each new or modified transaction, in order, stopping at the first that assigns a category:

1. **Locked.** If `category_source` is `manual` or `claude`, do nothing. Nothing automatic ever overwrites these.
2. **Transfers.** Match pairs across Dan's accounts: equal and opposite amounts, dates within 4 days, both unpaired. A pair with one side on a credit account is a `card_payment`; one side on an investment account is an `investment_contribution`; otherwise `internal_transfer`. Ties go to the closest dates. A credit-card payment whose other side isn't a tracked account is still categorized as a card payment from Plaid's `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` category.
3. **Rules.** Enabled rules in priority order. First match applies its actions and increments `hit_count`.
4. **Merchant memory.** If the merchant has a `default_category_id`, use it. The default is set whenever Dan or Claude categorizes a transaction of that merchant by hand.
5. **Plaid category.** If `plaid_pfc_confidence` is `VERY_HIGH` or `HIGH`, use `plaid_category_map`.
6. **Review queue.** Otherwise set the category to Uncategorized and `needs_review = 1`.

**What lands in Review.** After categorizing, a transaction is put in Review, with `review_reasons` set, if any of these hold. Thresholds are in `settings`.

- `uncategorized`: step 6 above.
- `large`: an outflow of at least `review_large_cents` (default $200).
- `unfamiliar`: the first transaction ever from this merchant, at least `review_new_merchant_cents` (default $25).
- `unusual`: more than 3 times the merchant's median amount.
- `alert`: any M6 alert attached to it (duplicate, fee, price increase).
- `flagged`: Dan or Claude flagged it by hand.

Card payments and internal transfers are never put in Review. Only transactions dated after the first sync are queued for `large` and `unfamiliar`; history is not, or the first sync would queue thousands. `fh review backfill --since <date>` queues older ones on request.

**Merchant normalization.** `normalized_key` comes from Plaid's `merchant_name` when present, otherwise from the description: uppercase, strip store numbers, city and state suffixes, payment-processor prefixes (`SQ *`, `TST*`, `PAYPAL *`, `AMZN MKTP`), trailing reference numbers, and collapse whitespace. Keep the normalizer a pure function with a table-driven test file.

**Clearing the queue with Claude.** Claude calls `review_queue`, proposes categories, and calls `categorize_transactions` with `create_rule: true` where the merchant is unambiguous. That sets `category_source = claude`, updates the merchant's default and creates a `merchant_key` rule, so the same merchant never reaches the queue again. For merchants that vary (Amazon, Venmo, Costco), Claude categorizes the single transaction and creates no rule.

**Deferred: automatic categorizing.** Not built. `sync_runs` and the queue give the numbers the decision needs: queue arrivals per week, share resolved by each step, and connection failures. Revisit after eight weeks of real use.

## 7. Claude integration (MCP)

`fh mcp` starts a stdio MCP server named `finance-hub`. `fh install` registers it with Claude Code (`claude mcp add --scope user`) and prints the JSON block for Claude desktop's config with the path to paste it into.

It opens the same database file. Read tools use a read-only connection.

### Read tools

| Tool | Returns |
|---|---|
| `overview` | Net worth, month-to-date spending vs budget, queue size, open alerts, connection health |
| `list_accounts` | Accounts with latest balances |
| `query_transactions` | Filtered transactions (date range, account, category, merchant, text, amount range, needs_review). Default 50 rows, maximum 200, with a total count |
| `spending_summary` | Totals grouped by category, group, merchant or month for a date range |
| `cash_flow` | Income, spending and savings rate by month |
| `net_worth_history` | Assets, liabilities and net worth by month |
| `holdings` | Positions, allocation by asset class and by tax treatment |
| `review_queue` | Transactions in Review, filterable by reason, grouped by merchant |
| `list_categories`, `list_rules` | Reference data |
| `recurring_list` | Recurring series and upcoming charges |
| `budget_status` | Budget, spent and remaining by category for a month |
| `alerts_list` | Open alerts |
| `sync_status` | Last runs per connection, consent expiry |
| `weekly_digest` | The computed facts for a weekly review (see M6) |
| `run_sql` | A single `SELECT` on the read-only connection, maximum 500 rows, 5 second timeout. For questions no other tool answers |
| `list_scenarios`, `get_scenario` | Saved scenarios |

### Write tools

| Tool | Effect |
|---|---|
| `categorize_transactions` | Set category on IDs; optional `create_rule` |
| `create_rule`, `update_rule`, `delete_rule` | Manage rules. `create_rule` and `update_rule` accept `dry_run` and return how many existing transactions would change, and apply to existing unlocked transactions when not a dry run |
| `split_transaction` | Split into child amounts and categories that sum to the parent |
| `annotate_transaction` | Set note, tags, `excluded` |
| `review_transactions` | Mark IDs reviewed, optionally with a category, a note saying what the charge was, and a `flag` |
| `mark_transfer` | Pair two transactions as a transfer, or unpair |
| `set_budget` | Set a category budget for a month or as the default |
| `update_recurring` | Mark a series ignored, ended, or a subscription |
| `dismiss_alert` | Dismiss |
| `upsert_manual_account` | Create or revalue a manual asset or liability |
| `run_projection` | Run the retirement, house or tax engine with params; returns the result without saving |
| `save_scenario` | Save params and result under a name |
| `sync_now` | Run `syncAll` |
| `undo` | Reverse a `changes` entry |

Every write tool returns the `changes` IDs it created. Tool descriptions tell Claude to use `dry_run` before creating a rule that touches more than 20 transactions.

### Deliberately not exposed

Linking or removing connections, reading secrets, deleting transactions, editing `settings.plaid_env`, and arbitrary write SQL.

### Prompts

The server also registers three MCP prompts: `weekly-review`, `clear-review-queue` and `month-close`. Each is a short instruction telling Claude which tools to call and what to report.

## 8. Dashboard

### Look and feel

Calm and dense, like a well-kept ledger: dark-first with a light mode, one accent color, tabular numerals for every amount, small type that still reads at phone width. Charts are quiet (thin lines, muted fills) and every number on a chart can be clicked through to the transactions behind it. Spending is not painted red; red is reserved for alerts and over-budget.

### Pages

| Route | Contents |
|---|---|
| `/` Home | Net worth with change, this month's spending against budget, cash flow for the last 6 months, upcoming recurring charges, open alerts, review-queue count |
| `/transactions` | Searchable, filterable table. Inline category edit, split, note, tags, "make this a rule". Bulk select and categorize |
| `/review` | Dan's inbox for money worth a look. Tabs: Large purchases, Unfamiliar or confusing, Needs a category, Flagged. Each card shows the charge, the reason it's here, the merchant's history and similar past charges. Actions: confirm (marks reviewed), set category, say what it was (saved as the note, and offered as a rule), flag as suspicious. One keystroke per action. Flagged charges stay on the Flagged tab until marked disputed or resolved |
| `/spending` | By category and merchant, month and year views, and a Sankey of income to categories |
| `/budget` | Budget by category for a month, with remaining and rollover |
| `/recurring` | Subscriptions and bills, a calendar of upcoming charges, price changes |
| `/net-worth` | History chart, accounts grouped by type, manual assets |
| `/investments` | Holdings, allocation by asset class and tax treatment, contributions, equity grants |
| `/plan` | Retirement, house and tax scenarios: inputs on the left, result on the right, save and compare |
| `/accounts` | Connections, link and re-authenticate, slot count, sync history, file upload |
| `/rules` | Rules and categories editor |

Demo mode shows a banner, "Demo data. Nothing here is real.", with a link to the repo and the portfolio.

### Synthetic data

`packages/core/src/demo/generate.ts` builds a complete fake household from a fixed seed: the same account lineup as Dan's by type (not by real institution name; use invented names such as "Harbor Bank"), 26 months of transactions with realistic merchants, paychecks, recurring bills, a few anomalies, RSU vests, holdings and price history. It's used for the demo database, for tests and for every screenshot. The same generator must exercise every feature, so each milestone extends it.

## 9. What the builder needs from Dan

Ask for these at the milestone that needs them, not before.

| When | What |
|---|---|
| Done 2026-11-10 | Dan created a Plaid team for personal use. He must **not** click "Get production access". |
| Before M1 | Store the Plaid client ID, Sandbox secret and Production secret in the Keychain himself (service `finance-hub`, accounts `plaid-client-id`, `plaid-secret-sandbox`, `plaid-secret-production`) with `security add-generic-password -U -s finance-hub -a <account> -w`, which prompts for the value. Keys are never pasted into chat or files. |
| M2 | Check the Plaid Dashboard's OAuth institutions page for Fidelity's status and request access if it's offered. |
| M2 | Link each institution himself in the dashboard. The agent never types bank credentials. |
| M3 | Download one activity CSV and one positions CSV from Fidelity, and one activity export from NetBenefits, into the inbox. The builder reads the header rows locally and never copies data rows into the repo. |
| M8 | State of residence, filing status, and current-year pay details for the tax model. Entered in the dashboard and stored in `settings`, never in the repo. |

## 10. Milestones

Each ends at a checkpoint where Dan tries it. Verify by using the app at phone and desktop widths, in light and dark mode, as the playbook requires.

### M0: Foundation

Build: workspaces, TypeScript config, lint, Vitest, CI. Schema and migrations. `SqlDriver` with node and wasm implementations. Seed categories and the Plaid category map. The synthetic generator (transactions and balances only for now). `fh` CLI skeleton with `fh init` and `fh demo-db`. Repo `CLAUDE.md`, README, `.gitignore`, pre-commit hook. Push to `daniel-beachy/finance-hub`.

Accepted when:

- `npm test` passes in CI on a fresh clone.
- `fh init` creates the data directory and an empty migrated database.
- `fh demo-db` writes a database with at least 5,000 synthetic transactions, and the same seed gives a byte-identical file.
- The same query test suite passes against both drivers.
- The pre-commit hook rejects a stray `.csv`.

### M1: Plaid in Sandbox

Build: the fetch Plaid client, `SecretStore` on Keychain, `fh setup`, the local server with the safety checks, a bare Accounts page with Link, `syncConnection` and `syncAll` (transactions, balances, holdings), `fh sync`, `sync_runs`.

Accepted when:

- With Sandbox keys, linking a Sandbox institution in the browser creates a connection and accounts.
- `fh sync` loads Sandbox transactions; a second run adds zero rows.
- A test fires Sandbox's `ITEM_LOGIN_REQUIRED` and the connection shows `login_required`; update mode repairs it with the same connection ID.
- Every Sandbox response is written to the raw archive before it's applied.
- Tests cover pending-to-posted carry-over, `removed`, and the pagination-mutation restart, against recorded Sandbox responses.
- A request with a wrong `Host` or foreign `Origin` gets a 403.
- No secret appears in any file under the data directory or the repo (`grep` check in the acceptance run).

### M2: Real data, and the gate

Build: production linking with slot protection, the raw archive, `fh replay`, `fh backup`, `fh restore`, the iCloud backup copy, `fh install` for the launchd job, notifications. `fh setup` reads Plaid keys already in the Keychain and only prompts for missing ones. The raw archive must be working before the first production link, so the one-time history fetch is captured. Then Dan links accounts in this order: Capital One, Chase, Citi, Fidelity.

Accepted when:

- Each linked institution shows its accounts and balances, and Dan confirms a spot-check of 10 recent transactions per institution against the bank's website.
- Transaction history reaches back as far as each institution provides (up to 24 months).
- The launchd job has run unattended on three consecutive mornings with successful `sync_runs`.
- The slot counter matches the Plaid Dashboard's Item count.
- `fh replay` into an empty database reproduces the same transaction count and the same sum per account as the live database.
- Dated database copies and the raw archive appear in iCloud Drive's `Backups/finance-hub` folder after a scheduled sync.
- `fh restore` from yesterday's backup works on a copy of the data directory.

**The gate.** Decide the scope from what connected:

| Result | Path |
|---|---|
| Capital One, Chase and Citi all sync transactions | **Path A, transactions-first.** Continue with M3 to M9 as written. Fidelity comes from Plaid if it linked, otherwise from file import in M3. |
| One of the three fails | Try Hosted Link, then QFX file import for that institution. If monthly file drops for it are acceptable to Dan, stay on Path A. |
| Two or more fail and Dan doesn't want manual file drops | **Path B, net worth and advice.** Skip M4's review workflow, M6, and the spending, budget and recurring pages. Build M3 (positions and balances by file), M5 reduced to Home, Net worth, Investments, Plan and Accounts, then M7 to M9. Balances are entered or imported monthly. |

Record the outcome under Decisions in the project note.

### M3: File import

Build: the inbox, parsers 1 to 4, the fingerprint and feed rules, upload in the dashboard, account matching.

Accepted when:

- Importing the same file twice adds nothing the second time.
- A synthetic fixture for each parser round-trips to the expected rows.
- Dan's real Fidelity files import, and the resulting balances match Fidelity's site to the cent.
- An overlapping export on a `plaid` account adds only rows before `file_backfill_before`.
- An unknown file stays in the inbox and raises an alert.

### M4: Categorization and the MCP server

Build: merchant normalizer, transfer matcher, rules engine, the pipeline, the `changes` log and undo, `fh mcp` with every tool in section 7 that doesn't depend on M6 to M8, the three prompts, `fh install` registration.

Accepted when:

- On the synthetic data, at least 90% of transactions are categorized without the queue, and every card payment and internal transfer is paired.
- A manual category survives a re-sync and a rule change.
- In Claude Code, Dan asks "how much did I spend on restaurants last month", "recategorize the X charge as Y and always do that", and "clear my review queue", and each works through the tools.
- `undo` restores the previous state of a bulk recategorization.
- Review reasons are assigned as specified: the synthetic data's planted large purchase, first-time merchant and unusual amount each land in Review with the right reason, and a card payment of any size does not.
- `run_sql` rejects anything that isn't a single `SELECT`.
- Dan reports the real-data queue size after the first clear; record it in the README as the baseline.

### M5: Dashboard and the public demo

Build: Home, Transactions, Review, Spending, Net worth (balances only), Accounts and Rules pages. Demo mode with the in-browser API. The Pages deploy workflow with base path `/finance-hub/`. Launch config entries for ports 5201 and 5202.

Accepted when:

- The demo is live at `https://daniel-beachy.github.io/finance-hub/` and works with the network tab showing no API calls after load.
- Recategorizing in the demo updates the charts, and a reload resets it.
- Every chart number clicks through to its transactions.
- On the Review page Dan can clear a real week's items by keyboard, a note he types appears on the transaction everywhere, and a flagged charge stays on the Flagged tab until resolved.
- Local mode shows Dan's real data and the demo shows only synthetic data; the built `dist/` contains no string from the real database (checked by a script that samples real merchant names and greps the build).
- Checked at 375px and desktop widths in light and dark mode.

### M6: Budgets, recurring, alerts, weekly review

Build:

- **Budgets:** per category per month, default amounts, optional rollover, the Budget page.
- **Recurring detection:** group by merchant and account; a series is three or more charges at a steady cadence (interval within 20% of weekly, biweekly, monthly, quarterly or yearly) with amounts within 15%, or exactly equal amounts. The Recurring page and upcoming-charges list.
- **Alerts:** duplicate (same merchant and amount within 3 days on one account), large (over 3 times the merchant's median, or over a settable threshold, default $500, for a new merchant), new merchant, fee, price increase on a series, new subscription, missed recurring.
- **Weekly digest:** a deterministic summary of the last 7 days (spending vs the 8-week average by group, largest transactions, new merchants, alerts, budget pace, queue size, upcoming charges). Shown on Home and returned by `weekly_digest`; the `weekly-review` prompt has Claude narrate it and clear the queue.
- The remaining MCP tools for these features.

Accepted when:

- The synthetic data's planted subscriptions, price increase and duplicate charge are all detected, with no false alert on the planted look-alikes.
- Budget numbers on the page equal `spending_summary` for the same month.
- Dan runs the weekly review in Claude on real data.

### M7: Net worth and investments

Build: holdings history, allocation by asset class and tax treatment, contributions per account per year against limits, manual accounts (house, mortgage, FSA balance), `equity_grants` entry with vest calendar, the Investments page and full Net worth page.

Accepted when:

- Net worth on the page equals the sum of latest balances, and Dan confirms it against his own tally.
- Unvested RSUs appear separately and are excluded from net worth.
- Allocation percentages sum to 100 and match a hand calculation on the synthetic data.

### M8: Projections

All engines are pure functions in core, so they run in the dashboard, the demo and through `run_projection`. Each result carries the assumptions used and a line saying it's an estimate, not advice.

- **Retirement.** Inputs default from real data: balances by tax treatment, trailing-12-month savings, spending, age. Parameters: retirement age, real return and volatility by asset class, inflation, Social Security estimate, spending in retirement. Outputs: a year-by-year deterministic projection in today's dollars, a 1,000-run seeded Monte Carlo with success probability and percentile bands, and the earliest age at which success passes 90%.
- **House, buying.** Affordable price from income and debts (28% and 36% ratios), monthly cost (principal, interest, tax, insurance, PMI, HOA), cash needed at closing, down-payment goal progress from real savings, a rent-vs-buy comparison over a chosen horizon, and the effect of the purchase on the retirement projection.
- **House, owning.** Amortization schedule, extra-payment payoff vs investing the difference, and refinance break-even. Reads the mortgage from a manual `loan` account.
- **Tax.** Current-year federal estimate: wages, RSU vest income, ESPP dispositions, interest, dividends, realized gains; standard or itemized deduction; ordinary and capital-gains brackets, NIIT, Social Security and Medicare including the additional Medicare tax; withholding to date and projected; the gap from 22% supplemental withholding on RSUs; 401k and HSA room left. State tax for Dan's state only, behind a `StateTax` interface. What-ifs: sell a lot, change 401k contributions, a bonus.
- **Tax parameters** live in `packages/core/src/tax/params/<year>.json` with the official source URL beside each number. Look the numbers up from the IRS and the state's revenue department when building; don't write them from memory. Each year file has test vectors computed by hand from the official worksheets.

Accepted when:

- Each engine has unit tests against hand-worked examples.
- The same seed gives the same Monte Carlo result.
- Federal tax on three test households matches the official worksheet result to the dollar.
- Dan runs one scenario of each kind from the Plan page and one through Claude, and saves them.

### M9: Finish

Build: README covering setup, limits and what couldn't be verified. A link back to the portfolio in the app. Final pass on phone and desktop, light and dark. Portfolio card only after Dan says he likes it.

Accepted when:

- A fresh clone plus the README gets to a working demo with `npm install && npm run demo`.
- The README states the data limits honestly: Plaid's 10-connection cap, which Fidelity accounts came from files, and anything unverified.

### Later, not planned in detail

- Private hosted version on Cloudflare.
- Automatic LLM categorization after each sync.
- A partner's accounts and joint views.

## 11. Decisions and reasons

| Decision | Reason |
|---|---|
| Plaid Trial over SimpleFIN | SimpleFIN costs $15/year and Dan wants no subscription. |
| Plaid over scraping bank sites with browser automation | Scraping breaks often, needs stored bank passwords, and can violate bank terms. |
| File import as a first-class path | Fidelity is unverified on Trial, and it removes any single point of failure. |
| `days_requested: 730` on every link | It can't be raised later without burning another of the 10 slots. |
| Never call `/item/remove` | Slots aren't refunded; a removed Item is pure loss. |
| Embedded Link first, Hosted Link as fallback | Embedded needs no redirect URI on desktop and keeps the flow in the dashboard. Hosted avoids any localhost restriction. |
| Poll daily, no webhooks | A local machine can't receive webhooks, and Plaid refreshes only one to four times a day. |
| Local SQLite outside the repo and outside iCloud | Private data on a public repo; iCloud sync can corrupt a live SQLite file. |
| Keychain for secrets | Meets the playbook's no-secrets rule with nothing extra to install. |
| TypeScript core with an async driver | One codebase serves the local app, the browser demo and a future Worker. |
| Demo runs the real API in the browser | The demo can't drift from the real app, and it's interactive without a server. |
| MCP server over an in-app chat | Uses the Pro plan Dan already pays for. An in-app chat needs a metered API key. |
| `run_sql` read-only tool | Lets Claude answer questions no fixed tool anticipates, without risk of writes. |
| Rules, then memory, then Plaid's category, then the queue | Deterministic steps are free, instant and repeatable. The LLM handles only the remainder, and each answer becomes a rule. |
| Manual and Claude categories are locked | Nothing is more annoying than a corrected category reverting on the next sync. |
| One feed per account, exact fingerprints | Fuzzy cross-source dedupe is where finance apps double count. |
| Negative means money out | Reads naturally in sums: spending is negative, net is a plain total. |
| Integer cents | No floating-point drift in money. |
| Audit log with undo on every write | Claude makes bulk changes; they must be reversible. |
| Archive raw Plaid responses before applying them | History is fetched once per connection and slots are limited, so the raw data must survive any bug in our own parsing. |
| Backup copies in iCloud, live database outside it | Dan wants an off-machine copy; iCloud is safe for closed files and unsafe for a live SQLite file. |
| Review is driven by reasons, not only missing categories | Dan wants to see large and unfamiliar charges even when a rule categorized them, to catch fraud and mistakes. |
| Review thresholds apply only after the first sync | Otherwise two years of history would flood the inbox on day one. |
| Gate after M2 | The feed is the biggest unknown. Finding out costs two milestones, and everything in M0 and M1 is used on either path. |
| Dashboard and demo at M5, before budgets and projections | Dan gets a live link early, and later milestones each add a visible page. |
| Tax numbers in dated JSON with sources | Tax law changes yearly; parameters must be auditable and replaceable without touching code. |
| State tax for one state only | Building all states is large and unused. |
| No automatic LLM runs yet | Dan wants reliability and cost measured first. |

## 12. Build notes: what changed while building

Corrections found during M0 and M1. Where these differ from the text above, these win.

- **Link tokens depend on what is being linked.** An investment-only institution does not support Transactions, so one fixed product list fails there. Link takes a `kind`: `bank` requires `transactions` and adds `investments` where supported; `investment` requires `investments` and adds `transactions` where supported. The Accounts page has a button for each.
- **`SqlDriver` has a fourth method, `exec`**, for multi-statement SQL (migrations, `VACUUM`).
- **Migrations are TypeScript modules that export SQL strings**, not `.sql` files, so the same migrations run in Node, the browser and a Worker without a file system.
- **`connections.plaid_env`** records which Plaid environment a connection belongs to. Only `production` connections count toward the 10 slots.
- **`plaid_category_map` is keyed by `pfc_key`**: a detailed Plaid category, with the primary category as a fallback row. The seed map was written from memory of Plaid's taxonomy and must be checked against Plaid's published CSV in M4.
- **Sandbox prepares transactions in the background.** The first sync right after a link often returns zero; the next one returns the history. M2 should expect the same from real institutions and not treat an empty first sync as a failure.
- **`fh sandbox-link` and `fh sandbox-break`** exist for development: the first creates a Sandbox connection without the Link UI, the second forces `ITEM_LOGIN_REQUIRED`. Both refuse to run outside Sandbox.
- **Plaid Link takes several seconds to appear** after the button is pressed. The page says so while it waits.

Added while building M5 (the dashboard), which was built before M3 and M4 while Plaid reviewed the Trial request:

- **M5 came before M4.** The synthetic data already carries categories, so the dashboard did not need the rule engine. The **Rules page and "make this a rule"** wait for M4; budgets, recurring and alerts pages wait for M6 as planned.
- **A first-cut review queue lives in `packages/core/src/review.ts`.** It assigns `uncategorized`, `large`, `unfamiliar` and `unusual` (over 3 times the merchant's median, at least 4 earlier charges). It keys merchants on `COALESCE(merchant_raw, description_raw)`; M4 swaps in the normalized merchant and calls it from sync. Today only the demo generator calls it. Duplicates stay an M6 alert: as a review reason they flooded the queue with transit fares.
- **Edits go through `packages/core/src/mutations.ts`** (`updateTransaction`, `categorizeTransactions`), which write the `changes` log. The MCP tools in M4 should call the same functions.
- **Dashboard numbers are defined in `packages/core/src/insights.ts`.** Spending is the net of expense-kind categories, shown positive; income is the net of income-kind categories. Transfers, investment moves, pending and excluded rows are left out.
- **The demo's clock is pinned** to the setting `demo_as_of` (the day the data ends), so the demo never shows an empty current month. `fh demo-db` writes `packages/web/public/demo.sqlite`, which is generated at build time and not committed.
- **Charts are hand-drawn SVG**, no chart library. The income flow is a three-column diagram (sources, income, groups plus saved).
- **The Spending page's third figure is "Net"** (income minus spending, signed) rather than "Saved", so a month before payday does not read as a failure.

## When the plan is wrong

- If a fact in section 2 has changed, or an acceptance criterion can't be met as written, stop and tell Dan what changed and what you'd do instead. Don't quietly pick a different approach.
- Small choices this plan doesn't cover (file names, component structure, exact chart types) are the builder's to make.
- Anything that costs money, uses a Plaid slot, or touches real credentials is always Dan's call.
