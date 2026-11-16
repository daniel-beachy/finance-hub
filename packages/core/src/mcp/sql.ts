import { InvalidInput } from "../errors.ts";

/** Most rows `run_sql` returns. */
export const SQL_ROW_LIMIT = 500;
/** Longest a `run_sql` query may run. */
export const SQL_TIMEOUT_MS = 5000;

const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|REPLACE\s+INTO|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOAD_EXTENSION|READFILE|WRITEFILE|FTS3_TOKENIZER)\b/i;

/**
 * Strip comments and quoted text, so a keyword inside a string literal or
 * a quoted identifier can't hide or fake a statement boundary.
 */
function skeleton(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new InvalidInput("Unclosed comment");
      i = end + 2;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k === -1) throw new InvalidInput("Unclosed quote");
        // A doubled quote is an escaped quote inside the literal.
        if (close !== "]" && sql[k + 1] === close) {
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      // Keep a placeholder: identifiers and literals stay one token.
      out += ch === "'" ? " '' " : " q ";
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Accept exactly one read-only query: a `SELECT`, or a `WITH ... SELECT`.
 * Anything else is refused before it reaches the database, and the database
 * connection is read-only as well, so this is the first of two locks.
 */
export function checkSelect(sql: unknown): string {
  if (typeof sql !== "string" || sql.trim() === "") throw new InvalidInput("sql must be one SELECT statement");
  if (sql.length > 20_000) throw new InvalidInput("That query is too long");
  const bare = skeleton(sql).trim().replace(/;\s*$/, "").trim();
  if (bare.includes(";")) throw new InvalidInput("Only one statement is allowed");
  if (!/^(SELECT|WITH)\b/i.test(bare)) throw new InvalidInput("Only a SELECT query is allowed");
  const bad = bare.match(FORBIDDEN);
  if (bad) throw new InvalidInput(`Only a SELECT query is allowed (found ${bad[1]!.toUpperCase().replace(/\s+/g, " ")})`);
  if (/^WITH\b/i.test(bare) && !/\)\s*SELECT\b/i.test(bare)) throw new InvalidInput("A WITH query must end in a SELECT");
  return sql.trim().replace(/;\s*$/, "");
}
