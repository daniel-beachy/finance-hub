/**
 * A small RFC 4180 CSV reader: quoted fields, doubled quotes, CRLF or LF,
 * a leading byte-order mark. Returns every row, blank ones included, so a
 * parser can find its header below a preamble and stop at a footer.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Normalize a header cell for matching: lower case, no BOM, single spaces. */
export function headerKey(cell: string): string {
  return cell.replace(/﻿/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Column lookup by any of several header spellings. */
export function columnIndex(header: string[], ...names: string[]): number {
  const keys = header.map(headerKey);
  for (const name of names) {
    const i = keys.indexOf(name.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse a money or number cell as Fidelity and banks write them:
 * `$1,234.56`, `-$12.00`, `+$3.10`, `(45.00)`, `1,000.5`. Blank, `--` and
 * `n/a` are null.
 */
export function parseNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  let s = cell.trim();
  if (s === "" || s === "--" || /^n\/?a$/i.test(s)) return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  s = s.replace(/%$/, "");
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}

/** Dollars in a cell to integer cents, or null. */
export function parseCents(cell: string | undefined): number | null {
  const n = parseNumber(cell);
  return n === null ? null : Math.round(n * 100);
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** `MM/DD/YYYY`, `M/D/YY`, `YYYY-MM-DD` or `Nov-12-2026` to `YYYY-MM-DD`, or null. */
export function parseDate(cell: string | undefined): string | null {
  if (!cell) return null;
  const s = cell.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) {
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  m = s.match(/^([A-Za-z]{3})[a-z]*[- ](\d{1,2}),?[- ](\d{4})/);
  if (m && MONTHS[m[1]!.toLowerCase()]) return `${m[3]}-${MONTHS[m[1]!.toLowerCase()]}-${m[2]!.padStart(2, "0")}`;
  return null;
}
