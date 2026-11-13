import { parseCents } from "./csv.ts";
import { emptyAccount, type FileAccount, type FileParser, ParseError, type ParsedFile } from "./types.ts";

/** One OFX element: a leaf has `value`, an aggregate has `children`. */
interface Node {
  tag: string;
  value?: string;
  children: Node[];
}

/**
 * Read OFX 1.x (SGML, leaf tags left open) and OFX 2.x (XML) into a tree.
 * QFX is OFX with an extra Intuit block, which this ignores.
 */
export function parseOfxTree(text: string): Node {
  const start = text.search(/<OFX>/i);
  if (start < 0) throw new ParseError("No <OFX> element found");
  const body = text.slice(start);
  const root: Node = { tag: "ROOT", children: [] };
  const stack: Node[] = [root];
  const tagRe = /<(\/?)([A-Za-z0-9.]+)[^>]*>([^<]*)/g;
  for (const m of body.matchAll(tagRe)) {
    const closing = m[1] === "/";
    const tag = m[2]!.toUpperCase();
    const text = decodeEntities(m[3]!.trim());
    const top = stack[stack.length - 1]!;
    if (closing) {
      // Close the matching aggregate. A close tag for a leaf (XML style) has
      // no aggregate on the stack and is ignored.
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    if (text !== "") {
      top.children.push({ tag, value: text, children: [] });
    } else {
      const node: Node = { tag, children: [] };
      top.children.push(node);
      stack.push(node);
    }
  }
  return root;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function findAll(node: Node, tag: string, out: Node[] = []): Node[] {
  for (const child of node.children) {
    if (child.tag === tag) out.push(child);
    findAll(child, tag, out);
  }
  return out;
}

function find(node: Node | undefined, tag: string): Node | undefined {
  return node ? findAll(node, tag)[0] : undefined;
}

function val(node: Node | undefined, tag: string): string | null {
  return find(node, tag)?.value ?? null;
}

/** `20261105120000[-5:EST]` to `2026-11-05`. */
export function ofxDate(s: string | null): string | null {
  const m = s?.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const BANK_SUBTYPES: Record<string, string> = {
  CHECKING: "checking",
  SAVINGS: "savings",
  MONEYMRKT: "money market",
  CREDITLINE: "line of credit",
  CD: "cd",
};

export const ofxParser: FileParser = {
  id: "ofx",
  label: "OFX / QFX download",
  detect: (text) => /<OFX>/i.test(text.slice(0, 4096)) || /^\s*OFXHEADER/i.test(text),
  parse(text): ParsedFile {
    const root = parseOfxTree(text);
    if (find(root, "INVSTMTRS")) {
      throw new ParseError("Investment OFX files aren't supported. Download the account's CSV history instead.");
    }
    const institution = val(find(root, "FI"), "ORG") ?? "Bank";
    const accounts: FileAccount[] = [];
    for (const [stmtTag, fromTag] of [
      ["STMTRS", "BANKACCTFROM"],
      ["CCSTMTRS", "CCACCTFROM"],
    ] as const) {
      for (const stmt of findAll(root, stmtTag)) {
        const from = find(stmt, fromTag);
        const number = val(from, "ACCTID");
        if (!number) throw new ParseError("A statement in the file has no account number");
        const credit = stmtTag === "CCSTMTRS";
        const acctType = val(from, "ACCTTYPE") ?? "";
        const account = emptyAccount({
          key: `ofx:${number}`,
          number,
          name: null,
          type: credit ? "credit" : acctType === "CREDITLINE" ? "credit" : "depository",
          subtype: credit ? "credit card" : (BANK_SUBTYPES[acctType] ?? null),
        });
        for (const t of findAll(stmt, "STMTTRN")) {
          const date = ofxDate(val(t, "DTPOSTED"));
          const amount = parseCents(val(t, "TRNAMT") ?? undefined);
          if (!date || amount === null) throw new ParseError("A transaction is missing its date or amount");
          const name = val(t, "NAME") ?? val(t, "PAYEE") ?? "";
          const memo = val(t, "MEMO") ?? "";
          const check = val(t, "CHECKNUM");
          let description = name;
          if (memo && !name.toUpperCase().includes(memo.toUpperCase())) description = name ? `${name} ${memo}` : memo;
          if (!description) description = check ? `Check ${check}` : (val(t, "TRNTYPE") ?? "Transaction");
          account.transactions.push({ posted_date: date, amount_cents: amount, description });
        }
        const ledger = find(stmt, "LEDGERBAL");
        const balance = parseCents(val(ledger, "BALAMT") ?? undefined);
        const asOf = ofxDate(val(ledger, "DTASOF"));
        if (balance !== null && asOf) {
          const available = parseCents(val(find(stmt, "AVAILBAL"), "BALAMT") ?? undefined);
          account.balance = { as_of: asOf, current_cents: balance, available_cents: available };
        }
        accounts.push(account);
      }
    }
    if (accounts.length === 0) throw new ParseError("The file has no bank or credit card statements");
    return { parser: "ofx", institution, accounts };
  },
};
