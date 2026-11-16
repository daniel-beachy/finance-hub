import type { SqlDriver } from "../db/driver.ts";
import { InvalidInput } from "../errors.ts";

/**
 * A rule: when every given field of `match` holds, set the category.
 * Rules run in `priority` order (lowest first; the newest wins a tie) and the
 * first match decides. They never touch a transaction a person or Claude
 * categorized by hand.
 */
export interface RuleMatch {
  /** The normalized merchant key, e.g. `SPACE AGE FUEL`. */
  merchant_key?: string;
  /** Case-insensitive text anywhere in the bank's description. */
  description_contains?: string;
  /** Case-insensitive regular expression on the bank's description. */
  description_regex?: string;
  account_id?: string;
  /** Bounds on the size of the amount, ignoring its sign. */
  amount_min_cents?: number;
  amount_max_cents?: number;
  /** `in` is money arriving, `out` is money leaving. */
  direction?: "in" | "out";
  plaid_pfc_detailed?: string;
}

/** Only `category_id` for now; the plan's other actions wait until they're needed. */
export interface RuleActions {
  category_id: string;
}

export interface Rule {
  id: string;
  priority: number;
  enabled: boolean;
  match: RuleMatch;
  actions: RuleActions;
  origin: "seed" | "user" | "claude";
  created_from_transaction_id: string | null;
  hit_count: number;
  created_at: string;
}

export const DEFAULT_RULE_PRIORITY = 100;

const MATCH_KEYS = new Set<keyof RuleMatch>([
  "merchant_key",
  "description_contains",
  "description_regex",
  "account_id",
  "amount_min_cents",
  "amount_max_cents",
  "direction",
  "plaid_pfc_detailed",
]);

/** What a rule looks at. */
export interface RuleSubject {
  merchant_key: string | null;
  description_raw: string;
  account_id: string;
  amount_cents: number;
  plaid_pfc_detailed: string | null;
}

/** Check a match object from outside and return a clean copy. */
export function validateMatch(input: unknown): RuleMatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidInput("match must be an object");
  const raw = input as Record<string, unknown>;
  const match: RuleMatch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (!MATCH_KEYS.has(key as keyof RuleMatch)) throw new InvalidInput(`Unknown match field: ${key}`);
    switch (key) {
      case "amount_min_cents":
      case "amount_max_cents":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new InvalidInput(`${key} must be a whole number of cents, zero or more`);
        }
        match[key] = value;
        break;
      case "direction":
        if (value !== "in" && value !== "out") throw new InvalidInput("direction must be in or out");
        match.direction = value;
        break;
      default: {
        if (typeof value !== "string" || value.trim() === "") throw new InvalidInput(`${key} must be text`);
        if (value.length > 200) throw new InvalidInput(`${key} can be at most 200 characters`);
        match[key as "merchant_key"] = key === "merchant_key" ? value.trim().toUpperCase() : value.trim();
      }
    }
  }
  if (Object.keys(match).length === 0) throw new InvalidInput("A rule needs at least one match field");
  if (match.description_regex) {
    try {
      new RegExp(match.description_regex, "i");
    } catch {
      throw new InvalidInput("description_regex is not a valid regular expression");
    }
  }
  if (
    match.amount_min_cents !== undefined &&
    match.amount_max_cents !== undefined &&
    match.amount_min_cents > match.amount_max_cents
  ) {
    throw new InvalidInput("amount_min_cents is larger than amount_max_cents");
  }
  return match;
}

/** A rule ready to test many transactions: its regex is compiled once. */
export interface CompiledRule {
  rule: Rule;
  test(t: RuleSubject): boolean;
}

export function compileRule(rule: Rule): CompiledRule {
  const m = rule.match;
  const contains = m.description_contains?.toUpperCase();
  let regex: RegExp | null = null;
  let broken = false;
  if (m.description_regex) {
    try {
      regex = new RegExp(m.description_regex, "i");
    } catch {
      broken = true; // a rule that can't be read matches nothing
    }
  }
  return {
    rule,
    test(t) {
      if (broken) return false;
      if (m.merchant_key !== undefined && t.merchant_key !== m.merchant_key) return false;
      if (contains !== undefined && !t.description_raw.toUpperCase().includes(contains)) return false;
      if (regex && !regex.test(t.description_raw)) return false;
      if (m.account_id !== undefined && t.account_id !== m.account_id) return false;
      const size = Math.abs(t.amount_cents);
      if (m.amount_min_cents !== undefined && size < m.amount_min_cents) return false;
      if (m.amount_max_cents !== undefined && size > m.amount_max_cents) return false;
      if (m.direction === "in" && t.amount_cents <= 0) return false;
      if (m.direction === "out" && t.amount_cents >= 0) return false;
      if (m.plaid_pfc_detailed !== undefined && t.plaid_pfc_detailed !== m.plaid_pfc_detailed) return false;
      return true;
    },
  };
}

interface RuleRow {
  id: string;
  priority: number;
  enabled: number;
  match: string;
  actions: string;
  origin: Rule["origin"];
  created_from_transaction_id: string | null;
  hit_count: number;
  created_at: string;
}

const toRule = (r: RuleRow): Rule => ({
  ...r,
  enabled: r.enabled === 1,
  match: JSON.parse(r.match) as RuleMatch,
  actions: JSON.parse(r.actions) as RuleActions,
});

/** Every rule, in the order they are tried. */
export async function listRules(db: SqlDriver): Promise<Rule[]> {
  const rows = await db.all<RuleRow>("SELECT * FROM rules ORDER BY priority, created_at DESC, id DESC");
  return rows.map(toRule);
}

export async function getRule(db: SqlDriver, id: string): Promise<Rule | undefined> {
  const rows = await db.all<RuleRow>("SELECT * FROM rules WHERE id = ?", [id]);
  return rows[0] ? toRule(rows[0]) : undefined;
}
