/** What every file parser returns. Amounts are cents, negative is money out. */

export type FileAccountType = "depository" | "credit" | "investment" | "loan" | "other";

export interface FileTransaction {
  posted_date: string;
  amount_cents: number;
  description: string;
}

export interface FileInvestmentTransaction {
  date: string;
  /** Plaid's vocabulary: buy, sell, cash, fee, transfer. */
  type: string;
  subtype: string | null;
  ticker: string | null;
  security_name: string | null;
  quantity: number | null;
  price: number | null;
  /** Cash effect on the account: negative for a buy, positive for a sale or deposit. */
  amount_cents: number;
  fees_cents: number | null;
  description: string;
}

export interface FileHolding {
  ticker: string | null;
  name: string | null;
  quantity: number;
  price: number | null;
  value_cents: number;
  cost_basis_cents: number | null;
  /** Money market or cash sweep. */
  is_cash: boolean;
}

export interface FileAccount {
  /**
   * Stable identity for the account across downloads, e.g.
   * `fidelity:Z12345678`. Remembered in settings once Dan picks an account.
   */
  key: string;
  /** Account number as the file shows it (may be partial). */
  number: string | null;
  /** Name as the file shows it. */
  name: string | null;
  type: FileAccountType;
  subtype: string | null;
  transactions: FileTransaction[];
  investment_transactions: FileInvestmentTransaction[];
  balance: { as_of: string; current_cents: number; available_cents: number | null } | null;
  holdings: { as_of: string; items: FileHolding[] } | null;
}

export interface ParsedFile {
  parser: string;
  institution: string;
  accounts: FileAccount[];
}

export interface FileParser {
  id: string;
  /** Human name shown in the dashboard. */
  label: string;
  /** True when this parser reads the file. Gets the decoded text and the file name. */
  detect(text: string, filename: string): boolean;
  parse(text: string, filename: string, today: string): ParsedFile;
}

export class ParseError extends Error {}

export function emptyAccount(partial: Pick<FileAccount, "key" | "number" | "name" | "type"> & Partial<FileAccount>): FileAccount {
  return {
    subtype: null,
    transactions: [],
    investment_transactions: [],
    balance: null,
    holdings: null,
    ...partial,
  };
}
