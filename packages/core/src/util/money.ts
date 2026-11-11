/** Dollars (as Plaid and CSV files give them) to integer cents. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function toCentsOrNull(amount: number | null | undefined): number | null {
  return amount === null || amount === undefined ? null : toCents(amount);
}

/** `YYYY-MM-DD` for a Date, in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}
