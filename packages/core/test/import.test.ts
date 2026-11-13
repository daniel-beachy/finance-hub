import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assignImportAccount,
  type CoreDeps,
  createApp,
  fidelityActivityParser,
  fidelityPositionsParser,
  type ImportOutcome,
  type InboxFile,
  type InboxStore,
  importFile,
  importStatus,
  netBenefitsParser,
  ofxParser,
  PARSERS,
  parseCsv,
  parseDate,
  parseNumber,
  processInbox,
} from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url)));
const text = (name: string) => new TextDecoder().decode(fixture(name));
const file = (name: string, bytes = fixture(name)): InboxFile => ({ name, bytes });

function memoryInbox(initial: InboxFile[] = []) {
  const files = new Map(initial.map((f) => [f.name, f.bytes]));
  const archived: string[] = [];
  const store: InboxStore = {
    list: async () => [...files].map(([name, bytes]) => ({ name, bytes })),
    put: async (name, bytes) => {
      files.set(name, bytes);
      return name;
    },
    archive: async (name) => {
      files.delete(name);
      archived.push(name);
    },
    discard: async (name) => void files.delete(name),
  };
  return { store, files, archived };
}

async function setup(initial: InboxFile[] = []) {
  const { deps } = await makeDeps(undefined);
  const inbox = memoryInbox(initial);
  deps.inbox = inbox.store;
  return { deps, inbox };
}

async function addAccount(deps: CoreDeps, opts: { name: string; mask: string; feed: string; type?: string; boundary?: string | null }) {
  const id = deps.newId();
  await deps.db.run(
    `INSERT INTO accounts (id, owner_id, name, mask, type, feed, file_backfill_before, created_at)
     VALUES (?, 'owner-1', ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
    [id, opts.name, opts.mask, opts.type ?? "depository", opts.feed, opts.boundary ?? null],
  );
  return id;
}

const imported = (o: ImportOutcome) => {
  if (o.status !== "imported") throw new Error(`expected imported, got ${o.status}: ${JSON.stringify(o)}`);
  return o;
};

describe("CSV helpers", () => {
  it("reads quotes, doubled quotes, CRLF and a byte-order mark", () => {
    expect(parseCsv('﻿a,"b,c","say ""hi"""\r\n1,2,3\n')).toEqual([
      ["a", "b,c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("parses money as banks and Fidelity write it", () => {
    expect(parseNumber("$1,234.56")).toBe(1234.56);
    expect(parseNumber("-$12.00")).toBe(-12);
    expect(parseNumber("+$3.10")).toBe(3.1);
    expect(parseNumber("(45.00)")).toBe(-45);
    expect(parseNumber("--")).toBeNull();
    expect(parseNumber("n/a")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });

  it("parses the date formats in exports", () => {
    expect(parseDate(" 11/05/2026")).toBe("2026-11-05");
    expect(parseDate("1/2/26")).toBe("2026-01-02");
    expect(parseDate("2026-03-04")).toBe("2026-03-04");
    expect(parseDate("Nov-10-2026")).toBe("2026-11-10");
    expect(parseDate("Run Date")).toBeNull();
  });
});

describe("parsers", () => {
  it("detects each fixture with the right parser", () => {
    const pick = (name: string) => PARSERS.find((p) => p.detect(text(name), name))?.id ?? null;
    expect(pick("checking.qfx")).toBe("ofx");
    expect(pick("card.ofx")).toBe("ofx");
    expect(pick("History_for_Account_Z00000001.csv")).toBe("fidelity-activity");
    expect(pick("Portfolio_Positions_Nov-10-2026.csv")).toBe("fidelity-positions");
    expect(pick("netbenefits_activity.csv")).toBe("fidelity-netbenefits");
    expect(pick("unknown.csv")).toBeNull();
  });

  it("reads an OFX 1 (SGML) bank statement", () => {
    const parsed = ofxParser.parse(text("checking.qfx"), "checking.qfx", "2026-11-10");
    expect(parsed.institution).toBe("Harbor Bank");
    const [a] = parsed.accounts;
    expect(a).toMatchObject({ key: "ofx:000012345671", type: "depository", subtype: "checking" });
    expect(a!.transactions).toEqual([
      { posted_date: "2026-10-03", amount_cents: -475, description: "CORNER COFFEE #12 CARD 0000" },
      { posted_date: "2026-10-03", amount_cents: -475, description: "CORNER COFFEE #12 CARD 0000" },
      { posted_date: "2026-10-15", amount_cents: 250000, description: "EXAMPLE CORP PAYROLL" },
      { posted_date: "2026-10-20", amount_cents: -15000, description: "Check 1042" },
      { posted_date: "2026-11-05", amount_cents: -6218, description: "GREENLEAF MARKET & DELI" },
    ]);
    expect(a!.balance).toEqual({ as_of: "2026-11-10", current_cents: 328332, available_cents: 320000 });
  });

  it("reads an OFX 2 (XML) credit card statement", () => {
    const [a] = ofxParser.parse(text("card.ofx"), "card.ofx", "2026-11-10").accounts;
    expect(a).toMatchObject({ key: "ofx:4000000000009876", type: "credit", subtype: "credit card" });
    expect(a!.transactions.map((t) => t.amount_cents)).toEqual([-8999, 50000]);
    expect(a!.balance?.current_cents).toBe(-41250);
  });

  it("reads Fidelity history: every row as an investment transaction, cash moves as transactions too", () => {
    const parsed = fidelityActivityParser.parse(text("History_for_Account_Z00000001.csv"), "History_for_Account_Z00000001.csv", "2026-11-10");
    const [a] = parsed.accounts;
    expect(a).toMatchObject({ key: "fidelity:Z00000001", number: "Z00000001", type: "investment" });
    expect(a!.investment_transactions.map((t) => [t.date, t.type, t.subtype, t.ticker, t.quantity, t.amount_cents])).toEqual([
      ["2026-11-05", "cash", null, null, null, -475],
      ["2026-11-03", "buy", "buy", "EXTMX", 10.5, -105000],
      ["2026-10-31", "cash", "dividend", "EXTMX", null, 1234],
      ["2026-10-31", "buy", "reinvest", "EXTMX", 0.123, -1234],
      ["2026-10-15", "transfer", null, null, null, 300000],
      ["2026-10-01", "sell", "sell", "EXBDX", -5, 9998],
    ]);
    expect(a!.investment_transactions[5]!.fees_cents).toBe(2);
    expect(a!.transactions).toEqual([
      { posted_date: "2026-11-05", amount_cents: -475, description: "DEBIT CARD PURCHASE CORNER COFFEE #12 ANYTOWN XX" },
      { posted_date: "2026-10-31", amount_cents: 1234, description: "DIVIDEND RECEIVED EXAMPLE TOTAL MARKET INDEX (EXTMX) (Cash)" },
      { posted_date: "2026-10-15", amount_cents: 300000, description: "ELECTRONIC FUNDS TRANSFER RECEIVED (Cash)" },
    ]);
  });

  it("reads Fidelity positions into holdings and a balance per account", () => {
    const parsed = fidelityPositionsParser.parse(text("Portfolio_Positions_Nov-10-2026.csv"), "Portfolio_Positions_Nov-10-2026.csv", "2026-12-01");
    const [individual, roth] = parsed.accounts;
    expect(individual).toMatchObject({ key: "fidelity:Z00000001", name: "Individual", subtype: "brokerage" });
    // Cash, the fund and pending activity: what Fidelity shows as the account total.
    expect(individual!.balance).toEqual({ as_of: "2026-11-10", current_cents: 2171348, available_cents: null });
    expect(individual!.holdings!.items).toEqual([
      { ticker: "SPAXX", name: "HELD IN MONEY MARKET", quantity: 1995.25, price: 1, value_cents: 199525, cost_basis_cents: null, is_cash: true },
      { ticker: "EXTMX", name: "EXAMPLE TOTAL MARKET INDEX", quantity: 190.623, price: 101.5, value_cents: 1934823, cost_basis_cents: 1800000, is_cash: false },
    ]);
    expect(roth).toMatchObject({ key: "fidelity:230000002", subtype: "roth", balance: { current_cents: 507500 } });
  });

  it("reads NetBenefits activity (provisional columns)", () => {
    const [a] = netBenefitsParser.parse(text("netbenefits_activity.csv"), "netbenefits_activity.csv", "2026-11-10").accounts;
    expect(a).toMatchObject({ key: "netbenefits", number: null, subtype: "401k" });
    expect(a!.investment_transactions.map((t) => [t.date, t.type, t.subtype, t.amount_cents, t.quantity])).toEqual([
      ["2026-11-07", "transfer", "contribution", 100000, 40.123],
      ["2026-11-07", "transfer", "contribution", 50000, 20.061],
      ["2026-10-24", "transfer", "contribution", 100000, 40.987],
      ["2026-10-01", "cash", "dividend", 2510, 1.01],
    ]);
  });
});

describe("importing", () => {
  it("imports a file once; the same file again adds nothing", async () => {
    const { deps } = await setup();
    await addAccount(deps, { name: "Everyday checking", mask: "5671", feed: "file" });
    const first = imported(await importFile(deps, file("checking.qfx")));
    expect(first).toMatchObject({ rows_total: 5, rows_added: 5 });
    const again = await importFile(deps, file("checking.qfx"));
    expect(again.status).toBe("duplicate");
    const n = await deps.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM transactions");
    expect(n[0]!.n).toBe(5);
  });

  it("keeps two identical purchases on one day, and a re-export of the same period adds only new rows", async () => {
    const { deps } = await setup();
    const id = await addAccount(deps, { name: "Everyday checking", mask: "5671", feed: "file" });
    imported(await importFile(deps, file("checking.qfx")));
    const coffee = await deps.db.all("SELECT id FROM transactions WHERE account_id = ? AND amount_cents = -475", [id]);
    expect(coffee).toHaveLength(2);

    // A later download overlapping the first: different bytes, one new row.
    const later = text("checking.qfx").replace(
      "</BANKTRANLIST>",
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261108<TRNAMT>-9.99<FITID>A6<NAME>STREAMFLIX</STMTTRN>\n</BANKTRANLIST>",
    );
    const second = imported(await importFile(deps, { name: "checking-2.qfx", bytes: new TextEncoder().encode(later) }));
    expect(second.rows_added).toBe(1);
  });

  it("takes rows into a Plaid account only before Plaid's first date", async () => {
    const { deps } = await setup();
    await addAccount(deps, { name: "Plaid checking", mask: "5671", feed: "plaid", boundary: "2026-10-16" });
    const out = imported(await importFile(deps, file("checking.qfx")));
    // 10/03 twice and 10/15 are before the boundary; 10/20 and 11/05 are Plaid's.
    expect(out).toMatchObject({ rows_added: 3, rows_skipped: 2 });
    const balances = await deps.db.all("SELECT * FROM balances");
    expect(balances).toHaveLength(0); // today's balance is Plaid's to report
  });

  it("refuses a Plaid account with no Plaid history yet, and manual accounts", async () => {
    const { deps } = await setup();
    await addAccount(deps, { name: "New Plaid checking", mask: "5671", feed: "plaid", boundary: null });
    const out = await importFile(deps, file("checking.qfx"));
    expect(out).toMatchObject({ status: "error" });
    expect(await deps.db.all("SELECT id FROM import_files")).toHaveLength(0);
  });

  it("asks for the account when it can't match, then remembers the choice", async () => {
    const { deps } = await setup();
    const out = await importFile(deps, file("History_for_Account_Z00000001.csv"));
    expect(out).toMatchObject({
      status: "needs_account",
      accounts: [{ key: "fidelity:Z00000001", mask: "0001", institution: "Fidelity", type: "investment", subtype: "brokerage", rows: 6 }],
    });
    const id = await assignImportAccount(deps, "fidelity:Z00000001", {
      create: { name: "Fidelity brokerage", type: "investment", subtype: "brokerage", institution: "Fidelity", mask: "0001" },
    });
    const done = imported(await importFile(deps, file("History_for_Account_Z00000001.csv")));
    expect(done.accounts).toEqual([{ id, name: "Fidelity brokerage", added: 6, skipped: 0 }]);
    const account = await deps.db.all<{ feed: string; tax_treatment: string; connection_id: string }>("SELECT feed, tax_treatment, connection_id FROM accounts WHERE id = ?", [id]);
    expect(account[0]).toMatchObject({ feed: "file", tax_treatment: "taxable" });
    const conn = await deps.db.all<{ source: string; institution_name: string; last_synced_at: string | null }>("SELECT * FROM connections WHERE id = ?", [account[0]!.connection_id]);
    expect(conn[0]).toMatchObject({ source: "file", institution_name: "Fidelity" });
    expect(conn[0]!.last_synced_at).not.toBeNull();
    const inv = await deps.db.all("SELECT * FROM investment_transactions WHERE account_id = ? AND source = 'file'", [id]);
    expect(inv).toHaveLength(6);
    const cash = await deps.db.all("SELECT * FROM transactions WHERE account_id = ? AND source = 'file'", [id]);
    expect(cash).toHaveLength(3);
    const tickers = await deps.db.all<{ ticker: string }>("SELECT ticker FROM securities ORDER BY ticker");
    expect(tickers.map((t) => t.ticker)).toEqual(["EXBDX", "EXTMX"]);

    // The positions file names the same account number: no question this time.
    const positions = await importFile(deps, file("Portfolio_Positions_Nov-10-2026.csv"));
    expect(positions).toMatchObject({ status: "needs_account", accounts: [{ key: "fidelity:230000002" }] });
  });

  it("writes positions as holdings and a balance that matches the file to the cent", async () => {
    const { deps } = await setup();
    const brokerage = await addAccount(deps, { name: "Brokerage", mask: "0001", feed: "file", type: "investment" });
    const roth = await addAccount(deps, { name: "Roth", mask: "0002", feed: "file", type: "investment" });
    imported(await importFile(deps, file("Portfolio_Positions_Nov-10-2026.csv")));
    const balances = await deps.db.all<{ account_id: string; current_cents: number; as_of: string; source: string }>(
      "SELECT account_id, current_cents, as_of, source FROM balances ORDER BY current_cents DESC",
    );
    expect(balances).toEqual([
      { account_id: brokerage, current_cents: 2171348, as_of: "2026-11-10", source: "file" },
      { account_id: roth, current_cents: 507500, as_of: "2026-11-10", source: "file" },
    ]);
    const holdings = await deps.db.all<{ value_cents: number }>("SELECT value_cents FROM holdings WHERE account_id = ?", [brokerage]);
    expect(holdings.map((h) => h.value_cents).sort((a, b) => a - b)).toEqual([199525, 1934823]);
    // The same fund in two accounts is one security.
    expect(await deps.db.all("SELECT id FROM securities WHERE ticker = 'EXTMX'")).toHaveLength(1);
  });

  it("leaves an unknown file in the inbox with one alert, and clears it once discarded", async () => {
    const { deps, inbox } = await setup([file("unknown.csv"), file("card.ofx")]);
    await addAccount(deps, { name: "Card", mask: "9876", feed: "file", type: "credit" });
    const outcomes = await processInbox(deps);
    expect(outcomes.map((o) => [o.file, o.status])).toEqual([
      ["unknown.csv", "unknown"],
      ["card.ofx", "imported"],
    ]);
    expect([...inbox.files.keys()]).toEqual(["unknown.csv"]);
    expect(inbox.archived).toEqual(["card.ofx"]);
    await processInbox(deps); // running again doesn't raise a second alert
    const status = await importStatus(deps);
    expect(status.alerts).toHaveLength(1);
    expect(status.alerts[0]!.message).toContain("unknown.csv");
    expect(status.inbox).toEqual([{ file: "unknown.csv", status: "unknown", message: "No parser recognizes this file." }]);
    expect(status.recent[0]).toMatchObject({ filename: "card.ofx", account_name: "Card", rows_added: 2 });

    const app = createApp(deps);
    const res = await app.request("/api/imports/discard", { method: "POST", body: JSON.stringify({ name: "unknown.csv" }) });
    expect(res.status).toBe(200);
    expect((await importStatus(deps)).alerts).toHaveLength(0);
  });

  it("uploads through the API and imports after an account is picked", async () => {
    const { deps, inbox } = await setup();
    const app = createApp(deps);
    const form = new FormData();
    form.append("files", new File([fixture("netbenefits_activity.csv")], "netbenefits_activity.csv"));
    const up = await app.request("/api/imports/upload", { method: "POST", body: form });
    expect(up.status).toBe(200);
    const { outcomes } = (await up.json()) as { outcomes: ImportOutcome[] };
    expect(outcomes).toMatchObject([{ status: "needs_account", accounts: [{ key: "netbenefits" }] }]);
    expect(inbox.files.has("netbenefits_activity.csv")).toBe(true);

    const assign = await app.request("/api/imports/assign", {
      method: "POST",
      body: JSON.stringify({
        key: "netbenefits",
        create: { name: "Workplace 401(k)", type: "investment", subtype: "401k", institution: "Fidelity NetBenefits", mask: null },
      }),
    });
    const body = (await assign.json()) as { outcomes: ImportOutcome[] };
    expect(body.outcomes).toMatchObject([{ status: "imported", rows_added: 4 }]);
    expect(inbox.files.size).toBe(0);
    const account = await deps.db.all<{ tax_treatment: string }>("SELECT tax_treatment FROM accounts WHERE name = 'Workplace 401(k)'");
    expect(account[0]!.tax_treatment).toBe("traditional");
  });

  it("reports that import isn't available without an inbox (the demo)", async () => {
    const { deps } = await makeDeps(undefined);
    const app = createApp(deps);
    const status = (await (await app.request("/api/imports")).json()) as { available: boolean };
    expect(status.available).toBe(false);
    const res = await app.request("/api/imports/process", { method: "POST" });
    expect(res.status).toBe(400);
  });
});
