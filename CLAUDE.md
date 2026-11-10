# Finance Hub: instructions for agents

A local personal finance system: Plaid and file imports into SQLite, a dashboard, and an MCP server for Claude. Public repo, private data.

## Read first

- `docs/PLAN.md` is the agreed spec and build plan. Build from it milestone by milestone. Don't re-decide what it settles; if it's wrong, follow its "When the plan is wrong" section.
- Project note (status, design agreed, decisions): `/Users/dbeachy/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-vault/70 Claude/AI Projects/Finance Hub.md`
- Playbook: `AI Projects Playbook.md` in the same vault folder.

## Hard rules

- This repo is public. Never commit real financial data, exports, databases, real merchant rules, screenshots of real data, or secrets. Fixtures are synthetic only.
- Real data lives in `~/Library/Application Support/finance-hub/`. Secrets live in the macOS Keychain.
- Plaid's Trial plan has 10 connections for life. Develop and test in Sandbox. Never call `/item/remove`. Never click or request "production access". Linking a real institution is always Dan's action.
- Never type bank or Plaid credentials. Dan enters them himself.
- Free only: no paid services or metered API keys.
- Money is integer cents; negative is money out.
