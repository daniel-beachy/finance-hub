const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** $1,234.56. A true minus sign for negatives. */
export function money(cents: number | null | undefined, opts: { whole?: boolean; plus?: boolean } = {}): string {
  if (cents === null || cents === undefined) return "";
  const abs = (opts.whole ? usdWhole : usd).format(Math.abs(cents) / 100);
  if (cents < 0) return `−${abs}`;
  return opts.plus && cents > 0 ? `+${abs}` : abs;
}

/** $1.2K, $34K, $1.2M: for chart axes and tight spots. */
export function moneyCompact(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const sign = cents < 0 ? "−" : "";
  if (dollars >= 1_000_000) return `${sign}$${trim(dollars / 1_000_000)}M`;
  if (dollars >= 10_000) return `${sign}$${Math.round(dollars / 1000)}K`;
  if (dollars >= 1000) return `${sign}$${trim(dollars / 1000)}K`;
  return `${sign}$${Math.round(dollars)}`;
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

export function percent(ratio: number): string {
  return `${Math.round(Math.abs(ratio) * 100)}%`;
}

function parse(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

/** `YYYY-MM-DD` in local time for an ISO timestamp. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Nov 3, or Nov 3, 2025 when the year differs from `today`. */
export function shortDate(date: string, today?: string): string {
  const sameYear = today ? date.slice(0, 4) === today.slice(0, 4) : false;
  return parse(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

export function monthLabel(month: string, style: "long" | "short" | "narrow" = "long"): string {
  const d = parse(`${month}-01`);
  if (style === "narrow") return d.toLocaleDateString("en-US", { month: "short" });
  return d.toLocaleDateString("en-US", { month: style, year: "numeric" });
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

/** A calendar month (2026-11) or year (2026) as an inclusive date range. */
export function periodRange(period: string): { from: string; to: string; label: string } {
  if (period.length === 4) return { from: `${period}-01-01`, to: `${period}-12-31`, label: period };
  return { from: `${period}-01`, to: monthEnd(period), label: monthLabel(period) };
}

export function shiftPeriod(period: string, delta: number): string {
  return period.length === 4 ? String(Number(period) + delta) : shiftMonth(period, delta);
}

/** Build a /transactions link from filters, dropping empty ones. */
export function txLink(filters: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}
