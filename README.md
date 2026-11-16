# Finance Hub

A personal finance system that runs on your own Mac. It pulls transactions, balances and holdings from your banks through Plaid, stores them in a local SQLite database, and shows them in a local dashboard. Later milestones add budgets, a review inbox, net worth, projections and a Claude connection.

The code is public. The data is not: nothing financial ever lives in this repo.

**Demo:** <https://daniel-beachy.github.io/finance-hub/> runs the real dashboard in your browser on made-up data. Edits you make there last until you reload.

**Status:** the foundation (M0), Plaid in Sandbox (M1), real accounts with backups and the daily sync (M2), file import (M3), categorizing and the Claude connection (M4) and the dashboard (M5) are built. The dashboard has Home, Transactions, Review, Spending, Net worth, Accounts and Rules pages; every edit can be undone. Claude reads and edits the ledger through a local MCP server, and a weekly Sonnet run clears what it confidently can from Review. Next are budgets, recurring charges and alerts (M6). The full plan is in [docs/PLAN.md](docs/PLAN.md).

## What you need

- macOS (secrets are kept in the Keychain)
- Node 26 or newer
- A free Plaid account on the Trial plan, with its client ID and Sandbox secret

## Setup

```bash
npm install
```

```bash
npm run fh -- setup
```

`setup` checks the Keychain for your Plaid keys and asks for any that are missing. Keys are never written to a file.

```bash
npm run build
```

```bash
npm run serve
```

Then open http://127.0.0.1:5202.

## Commands

| Command | What it does |
| --- | --- |
| `npm run fh -- init` | Create the data folder and database |
| `npm run fh -- setup` | Check or store Plaid keys in the Keychain |
| `npm run fh -- status` | Connections, slots used, recent syncs |
| `npm run fh -- sync` | Pull new data for every connection, import the inbox, then back up |
| `npm run fh -- import` | Import files waiting in the inbox |
| `npm run fh -- categorize` | Re-run the categorizer over everything not set by hand |
| `npm run fh -- review backfill --since <date>` | Also queue large and first-time charges from that date (normally only those after each account's first sync) |
| `npm run fh -- review runs` | What the weekly categorizing runs did |
| `npm run fh -- mcp` | The MCP server for Claude, over stdio (Claude starts it; you don't run it by hand) |
| `npm run fh -- backup` | Back up the database now, locally and to iCloud Drive |
| `npm run fh -- restore <file>` | Replace the database with a backup (asks first; keeps the old one) |
| `npm run fh -- replay` | Rebuild everything Plaid sent from the raw archive into a new file, and compare it with the live database |
| `npm run fh -- install` | Run `fh sync` every day at 06:30 (a launchd job), register the MCP server with Claude Code and print Claude desktop's config; `uninstall` turns the sync off |
| `npm run fh -- serve` | Start the dashboard and API on port 5202 |
| `npm run fh -- env sandbox` | Choose Sandbox or Production for new links |
| `npm run fh -- sandbox-link` | Create a test connection to Plaid's fake bank |
| `npm run fh -- demo-db` | Write a database of made-up data for the public demo |
| `npm run dev:demo` | Run the dashboard on made-up data at port 5201 |
| `npm run build:demo` | Build the public demo into `packages/web/dist` |
| `npm run check` | Lint, type-check and run the tests |

## Where things live

| What | Where |
| --- | --- |
| Database, raw Plaid responses, logs | `~/Library/Application Support/finance-hub/` |
| Files waiting to import / imported | `inbox/` and `imported/` in the same folder |
| Plaid keys and access tokens | macOS Keychain, service `finance-hub` |
| Code | `packages/core` (logic), `packages/server` (CLI and local server), `packages/web` (dashboard) |

Every Plaid response, and every Plaid error, is saved to the `raw/` folder before anything is applied to the database, so history can be rebuilt even if the database is lost.

## Backups

- **After every full sync**, and after linking or syncing from the dashboard, the database is copied with `VACUUM INTO` to `backups/finance-YYYY-MM-DD.db`. The newest 14 copies are kept.
- That copy, plus any new raw Plaid responses and imported files, then goes to iCloud Drive › `Backups/finance-hub/`. iCloud keeps every daily copy for 30 days, then the first copy of each month forever. Only finished files go to iCloud, never the live database. If the copy fails, the sync still succeeds and an alert is recorded.
- **`fh restore <file>`** puts a backup back. The database it replaces is kept as `finance.db.before-restore`.
- **`fh replay`** rebuilds every Plaid connection from the raw archive alone, through the same code a live sync uses, and checks the transaction count and total per account against the live database. Categories, notes, rules and file imports aren't in the raw archive; the database backups cover those.
- **Plaid access tokens are not in any backup.** They live only in the Keychain. On a new Mac, move the `finance-hub` Keychain items by hand (Keychain Access, or `security find-generic-password -s finance-hub -a <name> -w`), or the connections will need relinking, which costs slots.

## The daily sync

`npm run fh -- install` adds a launchd job that runs `fh sync` at 06:30, or when the Mac wakes if it was asleep then. It logs to `logs/sync.log` in the data folder. It posts a macOS notification when a bank needs you to sign in again, a sync fails, a file in the inbox needs you, the iCloud copy fails, or a connection's Plaid access is about to expire.

The job runs through `/bin/bash`, so for the iCloud copy `/bin/bash` needs Full Disk Access (System Settings › Privacy & Security › Full Disk Access).

## Categorizing

Each new transaction goes through, in order: a category you or Claude set by hand (never changed by anything automatic), transfer matching between your own accounts, your rules, the merchant's remembered category, Plaid's category when Plaid is confident, and otherwise Review. On the Transactions page, open a transaction and choose **Make this a rule**: it shows how many existing transactions the rule would change before you save. The **Rules** page lists, edits, turns off and deletes rules. After any edit an **Undo** button appears for a few seconds.

**Real-data baseline:** 117 transactions waited in Review after the first full categorizing pass (2026-11-15, four institutions, 381 transactions), before any clearing. The number after the first clear with Claude goes here once it's done.

## Claude (MCP)

`npm run fh -- install` registers a local MCP server named `finance-hub` with Claude Code (`claude mcp add --scope user`) and prints the block to paste into Claude desktop's config. Claude then has tools to read the ledger (overview, transactions, spending summaries, cash flow, net worth, holdings, the review queue, rules, sync status, and a read-only `run_sql`) and to change it (categorize, rules with a dry run, split, notes and tags, mark reviewed, pair transfers, sync, undo). Read tools use a read-only database connection; `run_sql` accepts one `SELECT`, returns at most 500 rows and is stopped after 5 seconds. Everything Claude changes is logged with a `batch_id` that `undo` reverses. Three prompts are included: `clear-review-queue`, `weekly-review` and `month-close`. Linking or removing connections, reading secrets and deleting transactions are not exposed.

A Claude desktop scheduled task, **Finance Hub: weekly categorizing run**, runs on Sunday at 07:30 on Sonnet. It categorizes only what it's confident of, makes rules only for unambiguous merchants, leaves the rest in Review with a note, and records its counts (`fh review runs`). It runs while the Claude app is open.

## Limits to know about

- **Plaid's Trial plan allows 10 real connections for life.** Removing one does not give the slot back. The app asks before using a slot and never removes a connection at Plaid.
- **History depth is fixed when an account is linked.** The app always asks for the maximum, 24 months.
- The server only answers on `127.0.0.1` and refuses requests from other sites. It has no login, so don't expose the port.
- Fidelity support through Plaid is not confirmed yet. File import (M3) is the fallback.

## Importing files

Drop files on the Accounts page, or put them in `inbox/` and run `npm run fh -- import`. It reads:

- **OFX or QFX** downloads from any bank or card (Chase, Capital One, Citi and others)
- **Fidelity** account history (`History_for_Account_*.csv`), positions (`Portfolio_Positions_*.csv`) and NetBenefits activity

The first time a file's account can't be matched by its last four digits, the Accounts page asks which account it is and remembers the answer. Importing the same file twice adds nothing, and a later download that overlaps an earlier one adds only the new rows. An account fed by Plaid takes file rows only from before Plaid's first date, so nothing is counted twice. A file nothing can read stays in the inbox with an alert.

## Not verified yet

- The Fidelity parsers against real downloads. They follow Fidelity's published export columns; the NetBenefits columns are a best guess until a real file is checked.

- Asking questions through Claude Code and Claude desktop on real data (the tools are tested, but not yet by Dan through Claude).
