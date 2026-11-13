import { first } from "../db/driver.ts";
import { DEFAULT_OWNER_ID, getSetting, setSetting } from "../db/seed.ts";
import { type CoreDeps, localDate } from "../deps.ts";
import { InvalidInput, NotFound } from "../mutations.ts";
import { taxTreatment } from "../sync/sync.ts";
import { fidelityActivityParser, fidelityPositionsParser, netBenefitsParser } from "./fidelity.ts";
import { ofxParser } from "./ofx.ts";
import { type FileAccount, type FileAccountType, type FileParser, ParseError, type ParsedFile } from "./types.ts";

/** In detection order: the first parser whose `detect` accepts a file reads it. */
export const PARSERS: FileParser[] = [ofxParser, fidelityPositionsParser, fidelityActivityParser, netBenefitsParser];

/** A file waiting to be imported. */
export interface InboxFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Where files wait. The Node server backs it with `<data>/inbox/` and moves
 * imported files to `<data>/imported/`; the demo has none.
 */
export interface InboxStore {
  list(): Promise<InboxFile[]>;
  /** Save an uploaded file. Returns the name it was saved under. */
  put(name: string, bytes: Uint8Array): Promise<string>;
  /** Move a processed file out of the inbox, keeping it exactly as received. */
  archive(name: string): Promise<void>;
  /** Delete a file Dan chose to discard. */
  discard(name: string): Promise<void>;
}

/** Settings key: file account key -> our account id, remembered once Dan picks. */
const ACCOUNT_MAP_KEY = "import_account_map";

export interface UnmatchedAccount {
  key: string;
  /** Last four of the account number, never the whole number. */
  mask: string | null;
  name: string | null;
  type: FileAccountType;
  subtype: string | null;
  institution: string;
  rows: number;
}

export type ImportOutcome =
  | { file: string; status: "imported"; parser: string; rows_total: number; rows_added: number; rows_skipped: number; accounts: { id: string; name: string; added: number; skipped: number }[] }
  | { file: string; status: "duplicate"; imported_at: string }
  | { file: string; status: "unknown"; message: string }
  | { file: string; status: "error"; parser: string | null; message: string }
  | { file: string; status: "needs_account"; parser: string; accounts: UnmatchedAccount[] };

interface AccountRow {
  id: string;
  name: string;
  feed: string;
  file_backfill_before: string | null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Upper case, single spaces: the description as it goes into a fingerprint. */
export function normalizeDescription(s: string): string {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

function mask(number: string | null): string | null {
  const digits = number?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Read and parse a file without writing anything. */
async function readFile(deps: CoreDeps, file: InboxFile) {
  const sha = await sha256Hex(file.bytes);
  const seen = await first<{ imported_at: string }>(deps.db, "SELECT imported_at FROM import_files WHERE sha256 = ?", [sha]);
  if (seen) return { sha, outcome: { file: file.name, status: "duplicate", imported_at: seen.imported_at } as ImportOutcome };
  const text = new TextDecoder("utf-8").decode(file.bytes);
  const parser = PARSERS.find((p) => p.detect(text, file.name));
  if (!parser) {
    return { sha, outcome: { file: file.name, status: "unknown", message: "No parser recognizes this file." } as ImportOutcome };
  }
  try {
    return { sha, parser, parsed: parser.parse(text, file.name, localDate(deps.now())) };
  } catch (err) {
    const message = err instanceof ParseError ? err.message : `Could not read the file: ${(err as Error).message}`;
    return { sha, outcome: { file: file.name, status: "error", parser: parser.id, message } as ImportOutcome };
  }
}

/**
 * Find our account for a file account: the remembered choice first, then a
 * single open account with the same last four digits.
 */
async function matchAccount(deps: CoreDeps, fa: FileAccount): Promise<AccountRow | null> {
  const map = await getSetting<Record<string, string>>(deps.db, ACCOUNT_MAP_KEY, {});
  const remembered = map[fa.key];
  const cols = "id, name, feed, file_backfill_before";
  if (remembered) {
    const row = await first<AccountRow>(deps.db, `SELECT ${cols} FROM accounts WHERE id = ?`, [remembered]);
    if (row) return row;
  }
  const last4 = mask(fa.number);
  if (!last4) return null;
  const rows = await deps.db.all<AccountRow>(`SELECT ${cols} FROM accounts WHERE mask = ? AND closed_at IS NULL`, [last4]);
  return rows.length === 1 ? rows[0]! : null;
}

function rowCount(fa: FileAccount): number {
  return Math.max(fa.transactions.length, fa.investment_transactions.length) + (fa.holdings?.items.length ?? 0);
}

/** What `importFile` would do, without writing. Used to list the inbox. */
export async function previewFile(deps: CoreDeps, file: InboxFile): Promise<ImportOutcome | { file: string; status: "ready"; parser: string; accounts: { id: string; name: string; rows: number }[] }> {
  const read = await readFile(deps, file);
  if (!read.parsed) return read.outcome!;
  const resolved = await resolveAccounts(deps, file.name, read.parsed);
  if ("status" in resolved) return resolved;
  return {
    file: file.name,
    status: "ready",
    parser: read.parsed.parser,
    accounts: resolved.map(({ fa, account }) => ({ id: account.id, name: account.name, rows: rowCount(fa) })),
  };
}

async function resolveAccounts(deps: CoreDeps, filename: string, parsed: ParsedFile): Promise<ImportOutcome | { fa: FileAccount; account: AccountRow }[]> {
  const pairs: { fa: FileAccount; account: AccountRow }[] = [];
  const unmatched: UnmatchedAccount[] = [];
  for (const fa of parsed.accounts) {
    const account = await matchAccount(deps, fa);
    if (account) pairs.push({ fa, account });
    else {
      unmatched.push({
        key: fa.key,
        mask: mask(fa.number),
        name: fa.name,
        type: fa.type,
        subtype: fa.subtype,
        institution: parsed.institution,
        rows: rowCount(fa),
      });
    }
  }
  if (unmatched.length) return { file: filename, status: "needs_account", parser: parsed.parser, accounts: unmatched };
  for (const { account } of pairs) {
    if (account.feed === "manual") {
      return { file: filename, status: "error", parser: parsed.parser, message: `${account.name} is a manual account; files can't be imported into it.` };
    }
    if (account.feed === "plaid" && !account.file_backfill_before) {
      return {
        file: filename,
        status: "error",
        parser: parsed.parser,
        message: `${account.name} is fed by Plaid and has no Plaid history yet. Sync it first; then older rows from files can fill in before Plaid's first date.`,
      };
    }
  }
  return pairs;
}

/**
 * Import one file. Repeats (same SHA-256) are skipped. A file whose accounts
 * can't all be matched imports nothing and reports which ones need picking.
 * Writes happen in one database transaction.
 */
export async function importFile(deps: CoreDeps, file: InboxFile): Promise<ImportOutcome> {
  const read = await readFile(deps, file);
  if (!read.parsed) return read.outcome!;
  const { parsed, sha } = read;
  const resolved = await resolveAccounts(deps, file.name, parsed);
  if ("status" in resolved) return resolved;

  const { db } = deps;
  const nowIso = deps.now().toISOString();
  return db.transaction(async () => {
    const fileId = deps.newId();
    await db.run(
      `INSERT INTO import_files (id, sha256, filename, parser, account_id, rows_total, rows_added, imported_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
      [fileId, sha, file.name, parsed.parser, resolved.length === 1 ? resolved[0]!.account.id : null, nowIso],
    );
    const accounts: { id: string; name: string; added: number; skipped: number }[] = [];
    let total = 0;
    for (const { fa, account } of resolved) {
      const r = await writeAccount(deps, fa, account, fileId, nowIso);
      accounts.push({ id: account.id, name: account.name, added: r.added, skipped: r.skipped });
      total += rowCount(fa);
    }
    const added = accounts.reduce((n, a) => n + a.added, 0);
    const skipped = accounts.reduce((n, a) => n + a.skipped, 0);
    await db.run("UPDATE import_files SET rows_total = ?, rows_added = ? WHERE id = ?", [total, added, fileId]);
    await db.run(
      `UPDATE connections SET last_synced_at = ? WHERE source = 'file'
         AND id IN (SELECT connection_id FROM accounts WHERE id IN (${resolved.map(() => "?").join(",")}))`,
      [nowIso, ...resolved.map((r) => r.account.id)],
    );
    await dismissImportAlerts(deps, file.name);
    return { file: file.name, status: "imported", parser: parsed.parser, rows_total: total, rows_added: added, rows_skipped: skipped, accounts };
  });
}

/**
 * Fingerprint for a file row (docs/PLAN.md section 5): `n` counts identical
 * rows earlier in the same file, so two identical purchases on one day both
 * survive and a re-export of the same period adds nothing.
 */
function fingerprinter(accountId: string) {
  const counts = new Map<string, number>();
  return async (...parts: (string | number | null)[]) => {
    const base = [accountId, ...parts.map((p) => (p === null ? "" : String(p)))].join("|");
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return sha256Hex(new TextEncoder().encode(`${base}|${n}`));
  };
}

async function writeAccount(deps: CoreDeps, fa: FileAccount, account: AccountRow, fileId: string, nowIso: string) {
  const { db } = deps;
  // One feed per account: a Plaid account takes file rows only from before
  // Plaid's first date. This is what prevents double counting.
  const boundary = account.feed === "plaid" ? account.file_backfill_before : null;
  const accepts = (date: string) => boundary === null || date < boundary;
  let added = 0;
  let skipped = 0;

  const txFingerprint = fingerprinter(account.id);
  let txAdded = 0;
  for (const t of fa.transactions) {
    const description = normalizeDescription(t.description);
    const externalId = await txFingerprint(t.posted_date, t.amount_cents, description);
    if (!accepts(t.posted_date)) continue;
    const res = await db.run(
      `INSERT INTO transactions (id, account_id, source, external_id, posted_date, amount_cents, currency,
         description_raw, import_file_id, created_at, updated_at)
       VALUES (?, ?, 'file', ?, ?, ?, 'USD', ?, ?, ?, ?)
       ON CONFLICT(account_id, external_id) DO NOTHING`,
      [deps.newId(), account.id, externalId, t.posted_date, t.amount_cents, t.description.trim(), fileId, nowIso, nowIso],
    );
    txAdded += res.changes;
  }

  const invFingerprint = fingerprinter(account.id);
  let invAdded = 0;
  for (const t of fa.investment_transactions) {
    const externalId = await invFingerprint(t.date, t.amount_cents, normalizeDescription(t.description), t.ticker, t.quantity);
    if (!accepts(t.date)) continue;
    const securityId = await securityFor(deps, t.ticker, t.security_name, false);
    const res = await db.run(
      `INSERT INTO investment_transactions (id, account_id, external_id, date, security_id, type, subtype,
         quantity, price, amount_cents, fees_cents, description, source, import_file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'file', ?)
       ON CONFLICT(account_id, external_id) DO NOTHING`,
      [deps.newId(), account.id, externalId, t.date, securityId, t.type, t.subtype, t.quantity, t.price, t.amount_cents, t.fees_cents, t.description, fileId],
    );
    invAdded += res.changes;
  }
  added += Math.max(txAdded, invAdded);
  skipped += fa.transactions.length >= fa.investment_transactions.length
    ? fa.transactions.filter((t) => !accepts(t.posted_date)).length
    : fa.investment_transactions.filter((t) => !accepts(t.date)).length;

  if (fa.balance && accepts(fa.balance.as_of)) {
    await db.run(
      `INSERT INTO balances (account_id, as_of, current_cents, available_cents, source) VALUES (?, ?, ?, ?, 'file')
       ON CONFLICT(account_id, as_of) DO UPDATE SET current_cents = excluded.current_cents,
         available_cents = excluded.available_cents, source = 'file'`,
      [account.id, fa.balance.as_of, fa.balance.current_cents, fa.balance.available_cents],
    );
  }
  if (fa.holdings) {
    if (accepts(fa.holdings.as_of)) {
      // A snapshot replaces that day's holdings, so a position sold since drops out.
      await db.run("DELETE FROM holdings WHERE account_id = ? AND as_of = ?", [account.id, fa.holdings.as_of]);
      const merged = new Map<string, { securityId: string; quantity: number; value: number; basis: number | null; price: number | null }>();
      for (const h of fa.holdings.items) {
        const securityId = await securityFor(deps, h.ticker, h.name, h.is_cash);
        if (!securityId) continue;
        const m = merged.get(securityId);
        if (m) {
          m.quantity += h.quantity;
          m.value += h.value_cents;
          m.basis = m.basis === null || h.cost_basis_cents === null ? null : m.basis + h.cost_basis_cents;
        } else {
          merged.set(securityId, { securityId, quantity: h.quantity, value: h.value_cents, basis: h.cost_basis_cents, price: h.price });
        }
      }
      for (const m of merged.values()) {
        await db.run(
          `INSERT INTO holdings (account_id, security_id, as_of, quantity, price, value_cents, cost_basis_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [account.id, m.securityId, fa.holdings.as_of, m.quantity, m.price, m.value, m.basis],
        );
      }
      added += fa.holdings.items.length;
    } else skipped += fa.holdings.items.length;
  }
  return { added, skipped };
}

/** Find a security by ticker (or by name when there is no ticker), creating it if new. */
async function securityFor(deps: CoreDeps, ticker: string | null, name: string | null, isCash: boolean): Promise<string | null> {
  const { db } = deps;
  if (!ticker && !name) return null;
  const existing = ticker
    ? await first<{ id: string }>(db, "SELECT id FROM securities WHERE UPPER(ticker) = UPPER(?) ORDER BY plaid_security_id IS NULL LIMIT 1", [ticker])
    : await first<{ id: string }>(db, "SELECT id FROM securities WHERE ticker IS NULL AND UPPER(name) = UPPER(?) LIMIT 1", [name]);
  if (existing) return existing.id;
  const id = deps.newId();
  await db.run("INSERT INTO securities (id, ticker, name, type, asset_class) VALUES (?, ?, ?, ?, ?)", [
    id,
    ticker,
    name,
    isCash ? "cash" : null,
    isCash ? "cash" : "other",
  ]);
  return id;
}

async function raiseImportAlert(deps: CoreDeps, filename: string, sha: string, message: string): Promise<void> {
  const open = await deps.db.all<{ data: string }>(
    "SELECT data FROM alerts WHERE kind = 'import' AND dismissed_at IS NULL",
  );
  if (open.some((a) => JSON.parse(a.data ?? "{}").sha256 === sha)) return;
  await deps.db.run("INSERT INTO alerts (id, kind, message, data, created_at) VALUES (?, 'import', ?, ?, ?)", [
    deps.newId(),
    `${filename}: ${message}`,
    JSON.stringify({ file: filename, sha256: sha }),
    deps.now().toISOString(),
  ]);
}

async function dismissImportAlerts(deps: CoreDeps, filename: string): Promise<void> {
  await deps.db.run(
    "UPDATE alerts SET dismissed_at = ? WHERE kind = 'import' AND dismissed_at IS NULL AND json_extract(data, '$.file') = ?",
    [deps.now().toISOString(), filename],
  );
}

function requireInbox(deps: CoreDeps): InboxStore {
  if (!deps.inbox) throw new InvalidInput("File import isn't available here.");
  return deps.inbox;
}

/**
 * Import everything in the inbox. Imported files and repeats move to
 * `imported/`. Unreadable files stay and raise an alert. Files waiting for
 * an account choice stay until Dan picks one.
 */
export async function processInbox(deps: CoreDeps): Promise<ImportOutcome[]> {
  const inbox = requireInbox(deps);
  const outcomes: ImportOutcome[] = [];
  for (const file of await inbox.list()) {
    const outcome = await importFile(deps, file);
    if (outcome.status === "imported" || outcome.status === "duplicate") {
      await inbox.archive(file.name);
      if (outcome.status === "duplicate") await dismissImportAlerts(deps, file.name);
    } else if (outcome.status === "unknown" || outcome.status === "error") {
      await raiseImportAlert(deps, file.name, await sha256Hex(file.bytes), outcome.message);
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

export interface ImportFileView {
  id: string;
  filename: string;
  parser: string;
  account_name: string | null;
  rows_total: number;
  rows_added: number;
  imported_at: string;
}

/** The inbox as it stands, recent imports and open import alerts. */
export async function importStatus(deps: CoreDeps) {
  const inbox = deps.inbox ? await Promise.all((await deps.inbox.list()).map((f) => previewFile(deps, f))) : null;
  const recent = await deps.db.all<ImportFileView>(
    `SELECT f.id, f.filename, f.parser, a.name AS account_name, f.rows_total, f.rows_added, f.imported_at
     FROM import_files f LEFT JOIN accounts a ON a.id = f.account_id
     ORDER BY f.imported_at DESC LIMIT 20`,
  );
  const alerts = await deps.db.all<{ id: string; message: string; created_at: string }>(
    "SELECT id, message, created_at FROM alerts WHERE kind = 'import' AND dismissed_at IS NULL ORDER BY created_at DESC",
  );
  return { available: inbox !== null, inbox: inbox ?? [], recent, alerts, parsers: PARSERS.map((p) => p.label) };
}

/** Save uploaded files to the inbox, then process the whole inbox. */
export async function uploadFiles(deps: CoreDeps, files: InboxFile[]): Promise<ImportOutcome[]> {
  const inbox = requireInbox(deps);
  const saved = new Set<string>();
  for (const f of files) saved.add(await inbox.put(f.name, f.bytes));
  return (await processInbox(deps)).filter((o) => saved.has(o.file));
}

export async function discardInboxFile(deps: CoreDeps, name: string): Promise<void> {
  const inbox = requireInbox(deps);
  if (!(await inbox.list()).some((f) => f.name === name)) throw new NotFound(`${name} is not in the inbox`);
  await inbox.discard(name);
  await dismissImportAlerts(deps, name);
}

export type AccountChoice =
  | { account_id: string }
  | { create: { name: string; type: FileAccountType; subtype: string | null; institution: string; mask: string | null } };

const ACCOUNT_TYPES = new Set(["depository", "credit", "investment", "loan", "other"]);

/**
 * Remember which account a file account belongs to: an existing one, or a
 * new file-fed account. Returns the account id.
 */
export async function assignImportAccount(deps: CoreDeps, key: string, choice: AccountChoice): Promise<string> {
  const { db } = deps;
  if (!key) throw new InvalidInput("key is required");
  let accountId: string;
  if ("account_id" in choice) {
    const row = await first<{ id: string }>(db, "SELECT id FROM accounts WHERE id = ?", [choice.account_id]);
    if (!row) throw new NotFound("No such account");
    accountId = row.id;
  } else {
    const c = choice.create;
    if (!c.name?.trim()) throw new InvalidInput("A name is required");
    if (!ACCOUNT_TYPES.has(c.type)) throw new InvalidInput("Unknown account type");
    accountId = await db.transaction(async () => {
      const institution = c.institution?.trim() || "Files";
      let connection = await first<{ id: string }>(
        db,
        "SELECT id FROM connections WHERE source = 'file' AND institution_name = ?",
        [institution],
      );
      if (!connection) {
        connection = { id: deps.newId() };
        await db.run(
          "INSERT INTO connections (id, source, institution_name, status, created_at) VALUES (?, 'file', ?, 'ok', ?)",
          [connection.id, institution, deps.now().toISOString()],
        );
      }
      const id = deps.newId();
      await db.run(
        `INSERT INTO accounts (id, connection_id, owner_id, name, mask, type, subtype, tax_treatment, feed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'file', ?)`,
        [id, connection.id, DEFAULT_OWNER_ID, c.name.trim(), c.mask, c.type, c.subtype, taxTreatment(c.type, c.subtype), deps.now().toISOString()],
      );
      return id;
    });
  }
  const map = await getSetting<Record<string, string>>(db, ACCOUNT_MAP_KEY, {});
  map[key] = accountId;
  await setSetting(db, ACCOUNT_MAP_KEY, map);
  return accountId;
}
