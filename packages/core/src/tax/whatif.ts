import { ESTIMATE_NOTICE } from "../projections/notice.ts";
import { computeFederalTax, type EarnerInput, type FederalTaxInput, type FederalTaxResult, type Split } from "./federal.ts";

export interface TaxWhatIf {
  label: string;
  before: FederalTaxResult;
  after: FederalTaxResult;
  /** After minus before. */
  change: {
    /** Income that the change adds to (or removes from) the return's AGI. */
    agiCents: number;
    /** Total tax on the return: income tax, NIIT and Additional Medicare Tax. */
    federalTaxCents: number;
    /** The employee's Social Security and regular Medicare tax. */
    payrollTaxCents: number;
    /** Federal income tax withheld, including Additional Medicare withheld. */
    withholdingCents: number;
    /** What the change adds to the amount owed at filing. */
    balanceDueCents: number;
  };
  /** Federal and payroll tax change as a share of the money involved, or null where that has no meaning. */
  taxRateOnChange: number | null;
  /** Things to know before acting: a limit passed, a loss carried forward. */
  warnings: string[];
  assumptions: string[];
  notice: string;
}

const payroll = (r: FederalTaxResult): number => r.payroll.socialSecurityTaxCents + r.payroll.medicareTaxCents;

/** Runs the estimate twice and reports the difference. The building block for every what-if. */
export function compareTax(label: string, before: FederalTaxInput, after: FederalTaxInput, amountCents: number | null, warnings: string[] = [], notes: string[] = []): TaxWhatIf {
  const a = computeFederalTax(before);
  const b = computeFederalTax(after);
  const federal = b.tax.totalCents - a.tax.totalCents;
  const payrollChange = payroll(b) - payroll(a);
  return {
    label,
    before: a,
    after: b,
    change: {
      agiCents: b.income.agiCents - a.income.agiCents,
      federalTaxCents: federal,
      payrollTaxCents: payrollChange,
      withholdingCents: b.withholding.totalCents - a.withholding.totalCents,
      balanceDueCents: b.balanceDueCents - a.balanceDueCents,
    },
    taxRateOnChange: amountCents ? (federal + payrollChange) / amountCents : null,
    warnings,
    assumptions: [...notes, ...b.assumptions],
    notice: ESTIMATE_NOTICE,
  };
}

function withEarner(input: FederalTaxInput, index: number, change: (e: EarnerInput) => EarnerInput): FederalTaxInput {
  if (!input.earners[index]) throw new Error(`What-if: there is no earner number ${index + 1}.`);
  return { ...input, earners: input.earners.map((e, i) => (i === index ? change(e) : e)) };
}

const plus = (s: Split | undefined, restOfYearCents: number): Split => ({
  toDateCents: s?.toDateCents ?? 0,
  restOfYearCents: (s?.restOfYearCents ?? 0) + restOfYearCents,
});

/**
 * Sell one lot before year end. The gain or loss is proceeds minus basis,
 * long-term if the lot has been held more than a year. For ESPP shares, add
 * the sale to `esppDispositions` and use `compareTax` instead, since part of
 * the gain is wages.
 */
export function whatIfSellLot(input: FederalTaxInput, lot: { label?: string; proceedsCents: number; basisCents: number; longTerm: boolean }): TaxWhatIf {
  const gain = lot.proceedsCents - lot.basisCents;
  const after: FederalTaxInput = lot.longTerm
    ? { ...input, longTermGainsCents: (input.longTermGainsCents ?? 0) + gain }
    : { ...input, shortTermGainsCents: (input.shortTermGainsCents ?? 0) + gain };
  const result = compareTax(lot.label ?? `Sell a ${lot.longTerm ? "long" : "short"}-term lot`, input, after, gain === 0 ? null : gain, [], [
    "No tax is withheld from a sale, so the whole tax change lands on the amount owed at filing.",
    "Wash sales are not checked: a loss is not allowed if the same security is bought within 30 days either side of the sale.",
  ]);
  const carried = result.after.income.capitalLossCarryforwardCents - result.before.income.capitalLossCarryforwardCents;
  if (carried > 0) result.warnings.push(`$${(carried / 100).toFixed(2)} of the loss can't be used this year and carries forward.`);
  return result;
}

/**
 * Change one earner's 401(k) deferrals for the rest of the year. Give the new
 * rest-of-year amounts; anything left out stays as it is.
 */
export function whatIfChange401k(input: FederalTaxInput, change: { earner?: number; traditionalRestOfYearCents?: number; rothRestOfYearCents?: number }): TaxWhatIf {
  const index = change.earner ?? 0;
  const set = (s: Split | undefined, rest: number | undefined): Split | undefined =>
    rest === undefined ? s : { toDateCents: s?.toDateCents ?? 0, restOfYearCents: rest };
  const after = withEarner(input, index, (e) => ({
    ...e,
    traditional401k: set(e.traditional401k, change.traditionalRestOfYearCents),
    roth401k: set(e.roth401k, change.rothRestOfYearCents),
  }));
  const was = input.earners[index] as EarnerInput;
  const traditionalChange = (change.traditionalRestOfYearCents ?? was.traditional401k?.restOfYearCents ?? 0) - (was.traditional401k?.restOfYearCents ?? 0);
  const result = compareTax("Change 401(k) contributions", input, after, traditionalChange === 0 ? null : -traditionalChange, [], [
    "Withholding on the remaining paychecks is left as given. In practice it falls when pre-tax deferrals rise, so less of the saving shows up at filing and more in each paycheck.",
    "Pre-tax deferrals lower income tax but not Social Security or Medicare tax. Roth deferrals change no tax this year.",
  ]);
  const room = result.after.room.earners[index];
  if (room && room.deferralPlannedCents > room.deferralLimitCents)
    result.warnings.push(`Planned deferrals are $${((room.deferralPlannedCents - room.deferralLimitCents) / 100).toFixed(2)} over the ${input.year} limit.`);
  if (room && room.totalPlannedCents > room.totalLimitCents)
    result.warnings.push(`Planned contributions from all sources are $${((room.totalPlannedCents - room.totalLimitCents) / 100).toFixed(2)} over the plan's overall limit.`);
  return result;
}

/** A bonus (or any extra supplemental pay) for one earner before year end. */
export function whatIfBonus(input: FederalTaxInput, bonus: { earner?: number; amountCents: number }): TaxWhatIf {
  const after = withEarner(input, bonus.earner ?? 0, (e) => ({ ...e, bonus: plus(e.bonus, bonus.amountCents) }));
  return compareTax("A bonus", input, after, bonus.amountCents, [], [
    "The bonus has federal income tax withheld at the flat supplemental rate, and no 401(k) deferral is taken from it.",
  ]);
}
