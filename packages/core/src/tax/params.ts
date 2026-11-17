import raw2026 from "./params/2026.json" with { type: "json" };

export type FilingStatus = "single" | "mfj" | "mfs" | "hoh";

export const FILING_STATUSES: readonly FilingStatus[] = ["single", "mfj", "mfs", "hoh"];

/** One tax bracket: `rate` applies to taxable income above `from` (whole dollars). */
export interface Bracket {
  rate: number;
  from: number;
}

type ByStatus = Record<FilingStatus, number>;

/**
 * One tax year's numbers, as stored in `params/<year>.json`. Dollar amounts
 * are whole dollars; rates are fractions. Each group in the file names the
 * official source its numbers came from.
 */
export interface TaxParams {
  year: number;
  ordinaryBrackets: Record<FilingStatus, Bracket[]>;
  capitalGains: { rates: number[]; maxZeroRate: ByStatus; max15Rate: ByStatus };
  capitalLossLimit: ByStatus;
  standardDeduction: ByStatus;
  nonItemizerCharity: ByStatus;
  saltCap: { cap: number; phaseDownThreshold: number; phaseDownRate: number; floor: number };
  charityFloor: { rateOfAgi: number };
  itemizedLimit: { numerator: number; denominator: number };
  niit: { rate: number; threshold: ByStatus };
  socialSecurity: { rate: number; wageBase: number };
  medicare: { rate: number };
  additionalMedicare: { rate: number; threshold: ByStatus; employerWithholdingThreshold: number };
  supplementalWithholding: { rate: number; overMillionRate: number; millionThreshold: number };
  retirementPlans: { electiveDeferral: number; catchUp50: number; catchUp60to63: number; annualAdditions: number };
  hsa: { selfOnly: number; family: number };
  earlyDistribution: { rate: number; age: number };
  socialSecurityBenefits: { maxTaxableShare: number };
  unverified: string[];
}

const BY_YEAR: Record<number, TaxParams> = { 2026: raw2026 as TaxParams };

export const TAX_YEARS: readonly number[] = Object.keys(BY_YEAR).map(Number);

/** The parameters for a tax year. Throws for a year with no file. */
export function taxParams(year: number): TaxParams {
  const p = BY_YEAR[year];
  if (!p) throw new Error(`No tax parameters for ${year}. Years available: ${TAX_YEARS.join(", ")}.`);
  return p;
}
