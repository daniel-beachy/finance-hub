# Finance Hub

A personal finance system that runs on your own Mac. It pulls transactions, balances and holdings from your banks through Plaid, stores them in a local SQLite database, and shows them in a local dashboard. Later milestones add budgets, a review inbox, net worth, projections and a Claude connection.

The code is public. The data is not: nothing financial ever lives in this repo.

**Status:** milestones M0 (foundation) and M1 (Plaid in Sandbox) are built. The app links Plaid's test bank, syncs it and shows a bare Accounts page. Real accounts come in M2. The full plan is in [docs/PLAN.md](docs/PLAN.md).

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
| `npm run fh -- sync` | Pull new data for every connection |
| `npm run fh -- serve` | Start the dashboard and API on port 5202 |
| `npm run fh -- env sandbox` | Choose Sandbox or Production for new links |
| `npm run fh -- sandbox-link` | Create a test connection to Plaid's fake bank |
| `npm run fh -- demo-db` | Write a database of made-up data for the public demo |
| `npm run check` | Lint, type-check and run the tests |

## Where things live

| What | Where |
| --- | --- |
| Database, raw Plaid responses, logs | `~/Library/Application Support/finance-hub/` |
| Plaid keys and access tokens | macOS Keychain, service `finance-hub` |
| Code | `packages/core` (logic), `packages/server` (CLI and local server), `packages/web` (dashboard) |

Every Plaid response is saved to the `raw/` folder before it is applied to the database, so history can be rebuilt even if the database is lost.

## Limits to know about

- **Plaid's Trial plan allows 10 real connections for life.** Removing one does not give the slot back. The app asks before using a slot and never removes a connection at Plaid.
- **History depth is fixed when an account is linked.** The app always asks for the maximum, 24 months.
- The server only answers on `127.0.0.1` and refuses requests from other sites. It has no login, so don't expose the port.
- Fidelity support through Plaid is not confirmed yet. File import (M3) is the fallback.

## Not verified yet

- Completing Plaid Link in the browser end to end, including the "Sign in again" repair. The dialog opens correctly in both cases; finishing it means accepting Plaid's terms, which the account owner does.
- Anything against real institutions. That is M2.
