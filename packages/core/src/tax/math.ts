/**
 * Integer money math for the tax engine. Amounts are integer cents. Rates are
 * fractions with at most four decimal places, turned into whole basis points
 * before multiplying, so a half cent or half dollar always rounds the same
 * way and never depends on floating point.
 */

const SCALE = 10_000;

/** `n / d` rounded half away from zero, for integers. */
export function roundDiv(n: number, d: number): number {
  return n >= 0 ? Math.floor((n + d / 2) / d) : -Math.floor((-n + d / 2) / d);
}

/** A rate as whole basis points (0.22 becomes 2200). */
export function basisPoints(rate: number): number {
  return Math.round(rate * SCALE);
}

/** `cents * rate`, exact, in units of 1/10,000 of a cent. */
export function scaled(cents: number, rate: number): number {
  return cents * basisPoints(rate);
}

/** Units of 1/10,000 of a cent back to cents, half up. */
export function unscale(n: number): number {
  return roundDiv(n, SCALE);
}

/** `cents * rate`, rounded to the cent, half up. */
export function applyRate(cents: number, rate: number): number {
  return unscale(scaled(cents, rate));
}

/** Round cents to whole dollars (still in cents), 50 cents and over going up, as Form 1040 allows. */
export function roundToDollar(cents: number): number {
  return roundDiv(cents, 100) * 100;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Whole dollars to cents. */
export function dollars(n: number): number {
  return Math.round(n * 100);
}
