/**
 * Fidelity CSV exports. Column names come from Fidelity's published export
 * format; parsers look columns up by name, so a reordered or extended export
 * still reads. The header rows still need checking against Dan's real files
 * (docs/PLAN.md section 9).
 */
import { columnIndex, headerKey, parseCents, parseCsv, parseDate, parseNumber } from "./csv.ts";
import {
  emptyAccount,
  type FileAccount,
  type FileHolding,
  type FileInvestmentTransaction,
  type FileParser,
  ParseError,
  type ParsedFile,
} from "./types.ts";

/** The first row (within the first 40) that `isHeader` accepts, and the rows after it. */
export function findHeader(text: string, isHeader: (keys: string[]) => boolean) {
  const rows = parseCsv(text);
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    if (isHeader(rows[i]!.map(headerKey))) return { header: rows[i]!, body: rows.slice(i + 1) };
  }
  return null;
}

const has = (keys: string[], ...names: string[]) => names.every((n) => keys.includes(n));

/** Collapse runs of spaces Fidelity pads its text cells with. */
const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** An account number in a Fidelity file name, e.g. History_for_Account_Z12345678.csv. */
function numberFromFilename(filename: string): string | null {
  return filename.match(/_([A-Z]{0,2}\d{5,})(?:[_.]|$)/i)?.[1]?.toUpperCase() ?? null;
}

/** Guess an account subtype from the name Fidelity shows. Dan confirms it when the account is created. */
export function fidelitySubtype(name: string | null): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("roth")) return "roth";
  if (n.includes("hsa") || n.includes("health savings")) return "hsa";
  if (/401\s?\(?k/.test(n)) return "401k";
  if (/403\s?\(?b/.test(n)) return "403b";
  if (n.includes("ira") || n.includes("rollover")) return "ira";
  if (n.includes("cash management")) return "cash management";
  return "brokerage";
}

function fidelityAccount(number: string | null, name: string | null, fallbackKey: string): FileAccount {
  return emptyAccount({
    key: number ? `fidelity:${number}` : fallbackKey,
    number,
    name,
    type: "investment",
    subtype: fidelitySubtype(name),
  });
}

/** Map a Fidelity action ("YOU BOUGHT ...", "DIVIDEND RECEIVED ...") to Plaid's investment types. */
export function classifyAction(action: string): { type: string; subtype: string | null; trade: boolean } {
  const a = action.toUpperCase();
  if (a.startsWith("YOU BOUGHT")) return { type: "buy", subtype: "buy", trade: true };
  if (a.startsWith("YOU SOLD")) return { type: "sell", subtype: "sell", trade: true };
  if (a.startsWith("REINVESTMENT")) return { type: "buy", subtype: "reinvest", trade: true };
  if (a.includes("DIVIDEND")) return { type: "cash", subtype: "dividend", trade: false };
  if (a.includes("INTEREST")) return { type: "cash", subtype: "interest", trade: false };
  if (a.includes("CAP GAIN")) return { type: "cash", subtype: "capital gain", trade: false };
  if (/\bFEE\b|COMMISSION/.test(a)) return { type: "fee", subtype: "fee", trade: false };
  if (/CONTRIBUTION|DIRECT DEPOSIT|TRANSFER|ELECTRONIC FUNDS|\bEFT\b|WIRE|JOURNAL/.test(a)) {
    return { type: "transfer", subtype: null, trade: false };
  }
  return { type: "cash", subtype: null, trade: false };
}

/** Brokerage activity: `History_for_Account_*.csv` or `Accounts_History*.csv`. */
export const fidelityActivityParser: FileParser = {
  id: "fidelity-activity",
  label: "Fidelity account history CSV",
  detect: (text) => findHeader(text, (k) => has(k, "run date", "action") && (k.includes("amount ($)") || k.includes("amount"))) !== null,
  parse(text, filename): ParsedFile {
    const found = findHeader(text, (k) => has(k, "run date", "action"));
    if (!found) throw new ParseError("No Fidelity history header found");
    const { header, body } = found;
    const col = {
      date: columnIndex(header, "run date"),
      account: columnIndex(header, "account", "account name"),
      number: columnIndex(header, "account number"),
      action: columnIndex(header, "action"),
      symbol: columnIndex(header, "symbol"),
      description: columnIndex(header, "description", "security description"),
      quantity: columnIndex(header, "quantity"),
      price: columnIndex(header, "price ($)", "price"),
      commission: columnIndex(header, "commission ($)", "commission"),
      fees: columnIndex(header, "fees ($)", "fees"),
      amount: columnIndex(header, "amount ($)", "amount"),
    };
    const fileNumber = numberFromFilename(filename);
    const accounts = new Map<string, FileAccount>();
    for (const row of body) {
      const date = parseDate(row[col.date]);
      if (!date) continue; // blank lines and the disclaimer footer
      const amount = parseCents(row[col.amount]) ?? 0;
      const number = clean(row[col.number]).replace(/"/g, "") || fileNumber;
      const name = clean(row[col.account]) || null;
      const key = number ? `fidelity:${number}` : `fidelity:file:${filename.replace(/\d|\.csv$/gi, "")}`;
      const account = accounts.get(key) ?? fidelityAccount(number, name, key);
      accounts.set(key, account);

      const action = clean(row[col.action]);
      const symbol = clean(row[col.symbol]) || null;
      const security = clean(row[col.description]);
      const quantity = parseNumber(row[col.quantity]);
      const { type, subtype, trade } = classifyAction(action);
      const fees = (parseCents(row[col.fees]) ?? 0) + (parseCents(row[col.commission]) ?? 0);
      const described = security && !/^no description$/i.test(security) && !action.toUpperCase().includes(security.toUpperCase());
      const description = described ? `${action} ${security}` : action;
      const inv: FileInvestmentTransaction = {
        date,
        type,
        subtype,
        ticker: symbol,
        security_name: described ? security : null,
        quantity,
        price: parseNumber(row[col.price]),
        amount_cents: amount,
        fees_cents: fees || null,
        description,
      };
      account.investment_transactions.push(inv);
      // Cash that moved in or out without buying or selling (card spending,
      // deposits, dividends paid in cash) also counts as a transaction, so
      // it shows in spending and income.
      if (!trade && !quantity && amount !== 0) {
        account.transactions.push({ posted_date: date, amount_cents: amount, description });
      }
    }
    if (accounts.size === 0) throw new ParseError("The file has no activity rows");
    return { parser: "fidelity-activity", institution: "Fidelity", accounts: [...accounts.values()] };
  },
};

/** The download date Fidelity writes under the positions table, or in the file name. */
function positionsDate(text: string, filename: string): string | null {
  const line = text.match(/date downloaded[^A-Za-z0-9]*([A-Za-z]{3}[a-z]*[- ]\d{1,2},?[- ]\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i);
  return parseDate(line?.[1]) ?? parseDate(filename.match(/([A-Za-z]{3}-\d{1,2}-\d{4})/)?.[1]);
}

/** Positions: `Portfolio_Positions_*.csv`. Writes holdings and the account balance. */
export const fidelityPositionsParser: FileParser = {
  id: "fidelity-positions",
  label: "Fidelity positions CSV",
  detect: (text) => findHeader(text, (k) => has(k, "account number", "symbol", "current value")) !== null,
  parse(text, filename, today): ParsedFile {
    const found = findHeader(text, (k) => has(k, "account number", "symbol", "current value"));
    if (!found) throw new ParseError("No Fidelity positions header found");
    const { header, body } = found;
    const col = {
      number: columnIndex(header, "account number"),
      name: columnIndex(header, "account name"),
      symbol: columnIndex(header, "symbol"),
      description: columnIndex(header, "description"),
      quantity: columnIndex(header, "quantity"),
      price: columnIndex(header, "last price"),
      value: columnIndex(header, "current value"),
      basis: columnIndex(header, "cost basis total", "cost basis"),
    };
    const asOf = positionsDate(text, filename) ?? today;
    const accounts = new Map<string, FileAccount>();
    for (const row of body) {
      const number = clean(row[col.number]);
      const value = parseCents(row[col.value]);
      if (!number || row.length < 5 || value === null) continue; // footer and blank rows
      const name = clean(row[col.name]) || null;
      const key = `fidelity:${number}`;
      let account = accounts.get(key);
      if (!account) {
        account = fidelityAccount(number, name, key);
        account.balance = { as_of: asOf, current_cents: 0, available_cents: null };
        account.holdings = { as_of: asOf, items: [] };
        accounts.set(key, account);
      }
      account.balance!.current_cents += value;
      const rawSymbol = clean(row[col.symbol]);
      if (/^pending activity$/i.test(rawSymbol)) continue; // counts toward the balance only
      const description = clean(row[col.description]) || null;
      const isCash = rawSymbol.endsWith("**") || /money market|^cash$/i.test(description ?? "");
      const price = parseNumber(row[col.price]);
      const holding: FileHolding = {
        ticker: rawSymbol.replace(/\*+$/, "") || null,
        name: description,
        quantity: parseNumber(row[col.quantity]) ?? (isCash ? value / 100 : 0),
        price: price ?? (isCash ? 1 : null),
        value_cents: value,
        cost_basis_cents: parseCents(row[col.basis]),
        is_cash: isCash,
      };
      account.holdings!.items.push(holding);
    }
    if (accounts.size === 0) throw new ParseError("The file has no positions");
    return { parser: "fidelity-positions", institution: "Fidelity", accounts: [...accounts.values()] };
  },
};

const NB_DATE = ["date", "transaction date", "trade date", "activity date"];
const NB_AMOUNT = ["amount", "amount ($)", "transaction amount"];
const NB_FUND = ["investment", "investment name", "fund", "fund name"];
const NB_TYPE = ["transaction type", "activity", "transaction", "type"];
const isNetBenefitsHeader = (k: string[]) =>
  !k.includes("run date") &&
  NB_DATE.some((n) => k.includes(n)) &&
  NB_AMOUNT.some((n) => k.includes(n)) &&
  NB_FUND.some((n) => k.includes(n)) &&
  NB_TYPE.some((n) => k.includes(n));

function classifyPlanActivity(kind: string): { type: string; subtype: string | null } {
  const k = kind.toLowerCase();
  if (k.includes("contribution")) return { type: "transfer", subtype: "contribution" };
  if (k.includes("dividend")) return { type: "cash", subtype: "dividend" };
  if (k.includes("interest")) return { type: "cash", subtype: "interest" };
  if (k.includes("fee")) return { type: "fee", subtype: "fee" };
  if (k.includes("loan")) return { type: "transfer", subtype: "loan" };
  if (k.includes("withdrawal") || k.includes("distribution")) return { type: "cash", subtype: "withdrawal" };
  if (k.includes("exchange") || k.includes("transfer") || k.includes("realignment")) return { type: "transfer", subtype: "exchange" };
  return { type: "cash", subtype: null };
}

/**
 * NetBenefits (workplace plan) activity. Written from the general shape of
 * the export; the column names must be checked against a real download.
 * The file names no account number, so the first import asks which account.
 */
export const netBenefitsParser: FileParser = {
  id: "fidelity-netbenefits",
  label: "Fidelity NetBenefits activity CSV",
  detect: (text) => findHeader(text, isNetBenefitsHeader) !== null,
  parse(text): ParsedFile {
    const found = findHeader(text, isNetBenefitsHeader);
    if (!found) throw new ParseError("No NetBenefits header found");
    const { header, body } = found;
    const col = {
      date: columnIndex(header, ...NB_DATE),
      fund: columnIndex(header, ...NB_FUND),
      kind: columnIndex(header, ...NB_TYPE),
      amount: columnIndex(header, ...NB_AMOUNT),
      shares: columnIndex(header, "shares", "shares/unit", "shares/units", "units", "quantity"),
      price: columnIndex(header, "price", "share price", "nav", "price ($)"),
      plan: columnIndex(header, "plan", "plan name"),
    };
    const accounts = new Map<string, FileAccount>();
    for (const row of body) {
      const date = parseDate(row[col.date]);
      const amount = parseCents(row[col.amount]);
      if (!date || amount === null) continue;
      const plan = clean(row[col.plan]) || null;
      const key = plan ? `netbenefits:${plan.toLowerCase()}` : "netbenefits";
      let account = accounts.get(key);
      if (!account) {
        account = emptyAccount({ key, number: null, name: plan, type: "investment", subtype: fidelitySubtype(plan ?? "401k") });
        accounts.set(key, account);
      }
      const fund = clean(row[col.fund]) || null;
      const kind = clean(row[col.kind]);
      account.investment_transactions.push({
        date,
        ...classifyPlanActivity(kind),
        ticker: null,
        security_name: fund,
        quantity: parseNumber(row[col.shares]),
        price: parseNumber(row[col.price]),
        amount_cents: amount,
        fees_cents: null,
        description: [kind, fund].filter(Boolean).join(" "),
      });
    }
    if (accounts.size === 0) throw new ParseError("The file has no activity rows");
    return { parser: "fidelity-netbenefits", institution: "Fidelity NetBenefits", accounts: [...accounts.values()] };
  },
};
