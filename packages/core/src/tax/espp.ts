import { applyRate } from "./math.ts";

/**
 * One sale of shares bought through a section 423 employee stock purchase
 * plan. Prices are per share, in cents. Dates are `YYYY-MM-DD`.
 */
export interface EsppDisposition {
  label?: string;
  shares: number;
  /** First day of the offering period (the grant date). */
  offeringDate: string;
  purchaseDate: string;
  saleDate: string;
  /** Market price on the offering date. */
  fmvAtOfferingCents: number;
  /** Market price on the purchase date. */
  fmvAtPurchaseCents: number;
  /** What was actually paid, after the discount. */
  purchasePriceCents: number;
  salePriceCents: number;
  /** The plan's discount, for example 0.15. Used only for a qualifying sale. */
  discountRate: number;
}

export interface EsppResult {
  label: string | null;
  qualifying: boolean;
  /** Reported as wages. No Social Security or Medicare tax, and usually nothing withheld. */
  ordinaryIncomeCents: number;
  /** Purchase cost plus the ordinary income. */
  basisCents: number;
  proceedsCents: number;
  capitalGainCents: number;
  longTerm: boolean;
}

function addYears(date: string, years: number): string {
  return `${String(Number(date.slice(0, 4)) + years).padStart(4, "0")}${date.slice(4)}`;
}

/**
 * Ordinary income and capital gain from an ESPP sale (IRC 423(c), IRS
 * Publication 525).
 *
 * Qualifying (sold more than two years after the offering date and more than
 * one year after purchase): ordinary income is the lesser of the actual gain
 * over the price paid and the discount measured on the offering-date price,
 * never below zero. The rest is long-term gain.
 *
 * Disqualifying: ordinary income is the purchase-date spread, even if the
 * shares are sold at a loss. The rest is a gain or loss, long-term only if
 * held more than a year from purchase.
 */
export function esppDisposition(d: EsppDisposition): EsppResult {
  const heldOverYear = d.saleDate > addYears(d.purchaseDate, 1);
  const qualifying = heldOverYear && d.saleDate > addYears(d.offeringDate, 2);
  const shares = d.shares;
  const cost = Math.round(d.purchasePriceCents * shares);
  const proceeds = Math.round(d.salePriceCents * shares);

  let ordinary: number;
  if (qualifying) {
    const actualGain = proceeds - cost;
    const offeringDiscount = Math.round(applyRate(d.fmvAtOfferingCents, d.discountRate) * shares);
    ordinary = Math.max(0, Math.min(actualGain, offeringDiscount));
  } else {
    ordinary = Math.max(0, Math.round((d.fmvAtPurchaseCents - d.purchasePriceCents) * shares));
  }
  const basis = cost + ordinary;
  return {
    label: d.label ?? null,
    qualifying,
    ordinaryIncomeCents: ordinary,
    basisCents: basis,
    proceedsCents: proceeds,
    capitalGainCents: proceeds - basis,
    longTerm: heldOverYear,
  };
}
