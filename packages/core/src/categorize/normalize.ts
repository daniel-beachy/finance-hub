/**
 * Merchant normalization: turn what a bank prints into one stable key per
 * merchant, so rules and merchant memory keep matching when the store number,
 * city or reference code changes. Pure functions; cases live in
 * `test/normalize.test.ts`.
 *
 * Stability matters more than beauty. Two charges from the same place must
 * get the same key; the key doesn't have to be the merchant's proper name.
 */

export interface NormalizedMerchant {
  /** Uppercase letters, digits and single spaces. Never empty. */
  key: string;
  /** What to show for a merchant created from this transaction. */
  name: string;
}

/** Payment processors and bank boilerplate that hide the real merchant. */
const PREFIXES: RegExp[] = [
  /^(SQ|TST|PP|PY|SP|IN|FS|BT|CKE|DD|EB|GDP|LS|SQU|TM|ZG|CKO)\s*\*\s*/,
  /^PAYPAL\s*\*\s*/,
  /^(POS|DEBIT CARD|CHECKCARD|CHECK CARD|VISA|RECURRING|ACH|PURCHASE)\s+(PURCHASE|DEBIT|WITHDRAWAL|PAYMENT)\s+(?=\S)/,
  /^(CHECKCARD|CHECK CARD)\s+\d{4}\s+/,
  /^PURCHASE AUTHORIZED ON \d{2}\/\d{2}\s+/,
];

/** Merchants whose descriptions vary in the first words. */
const ALIASES: [RegExp, string][] = [
  [/^AMAZON PRIME\b/, "AMAZON PRIME"],
  [/^(AMZN|AMAZON)(\s+(MKTPL?|MKTPLACE|MARKETPLACE|COM|RETA|DIGITAL|DIGI))?\b/, "AMAZON"],
];

const STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND " +
    "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY"
  ).split(" "),
);

function clean(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’`]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function title(key: string): string {
  return key.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** A token that identifies one charge, store or account, not the merchant. */
function isReference(token: string): boolean {
  if (/^X{2,}\d*$/.test(token)) return true; // masked account number
  if (/^\d{3,}$/.test(token)) return true; // store or reference number
  // A mixed code like B74LW12L0 or TY0R276767758: long, with at least two digits.
  return token.length >= 8 && /[A-Z]/.test(token) && (token.match(/\d/g)?.length ?? 0) >= 2;
}

/** The key for a bank description with no merchant name from Plaid. */
export function keyFromDescription(description: string): string {
  let s = description.toUpperCase().trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of PREFIXES) {
      const next = s.replace(prefix, "");
      // Only strip when a real word is left: "POS PURCHASE 483920" stays itself.
      if (next !== s && clean(next).split(" ").some((t) => t !== "" && !isReference(t))) {
        s = next;
        changed = true;
      }
    }
  }
  // A code glued on after "*" is a reference: "AMAZON MKTPL*B74LW12L0".
  s = s.replace(/\*\s*[A-Z0-9]*\d[A-Z0-9]*\b/g, " ");
  // Everything after a store number is location: "SPACE AGE #24 KING CITY OR".
  s = s.replace(/\s#\s*\d+.*$/, "");
  s = s.replace(/\.(COM|NET|ORG|GOV)\b/g, "");

  let tokens = clean(s).split(" ").filter(Boolean);
  for (const [pattern, alias] of ALIASES) {
    if (pattern.test(tokens.join(" "))) return alias;
  }
  // A trailing state takes its city with it. One word of city is a guess, but
  // a stable one: the same store gives the same key every time.
  if (tokens.length >= 4 && STATES.has(tokens[tokens.length - 1]!)) tokens = tokens.slice(0, -2);
  while (tokens.length > 1 && isReference(tokens[tokens.length - 1]!)) tokens = tokens.slice(0, -1);
  const kept = tokens.filter((t, i) => i === 0 || !isReference(t));
  const key = kept.join(" ");
  return key || clean(description) || "UNKNOWN";
}

/**
 * Plaid's merchant name wins when there is one: it has already merged the
 * variants. Otherwise the key is worked out from the description.
 */
export function normalizeMerchant(merchantName: string | null | undefined, description: string): NormalizedMerchant {
  const fromPlaid = merchantName ? clean(merchantName) : "";
  if (fromPlaid) return { key: fromPlaid, name: merchantName!.trim() };
  const key = keyFromDescription(description);
  return { key, name: title(key) };
}

/**
 * Keys that name a way of paying or a store that sells everything, not one
 * kind of spending. One hand-categorized charge says nothing about the next,
 * so merchant memory never learns from these. A rule can still target them.
 */
const GENERIC = /^(POS PURCHASE|PURCHASE|CHECK|ATM|VENMO|PAYPAL|ZELLE|CASH APP|APPLE CASH|DEPOSIT|WITHDRAWAL|TRANSFER|AMAZON)( |$)/;

export function isGenericMerchant(key: string): boolean {
  return key !== "AMAZON PRIME" && GENERIC.test(key);
}
