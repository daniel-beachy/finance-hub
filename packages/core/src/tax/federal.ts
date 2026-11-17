import { ESTIMATE_NOTICE } from "../projections/notice.ts";
import { type EsppDisposition, type EsppResult, esppDisposition } from "./espp.ts";
import { applyRate, roundDiv, roundToDollar, scaled, unscale } from "./math.ts";
import { type Bracket, type FilingStatus, type TaxParams, taxParams } from "./params.ts";
import { STATE_TAX_NOT_MODELED, type StateTax, type StateTaxResult } from "./state.ts";

/**
 * How amounts are rounded.
 *
 * - `cents`: the bracket formulas applied exactly, to the cent. Smooth, so a
 *   what-if shows the real change. The default.
 * - `form1040`: the way the paper return works. Every line is rounded to whole
 *   dollars, and tax on less than $100,000 comes from the Tax Table (tax at
 *   the midpoint of a $50 band). Used to match the official worksheets.
 */
export type Rounding = "cents" | "form1040";

/** An amount so far this year and the amount still expected before year end. */
export interface Split {
  toDateCents: number;
  restOfYearCents: number;
}

/** One person with a job. Social Security and 401(k) limits are per person. */
export interface EarnerInput {
  label: string;
  /** Age at the end of the tax year. Only used for 401(k) catch-up room. */
  age?: number;
  /** Gross regular pay before any deduction. Leaves out bonuses and RSU vests. */
  regularPay: Split;
  bonus?: Split;
  /** Market value of RSU shares on the day they vest. */
  rsuVests?: Split;
  /** Pre-tax 401(k) deferrals. They lower taxable wages but not Social Security or Medicare wages. */
  traditional401k?: Split;
  roth401k?: Split;
  /** After-tax 401(k) contributions (the "mega backdoor"). Count toward the overall plan limit only. */
  afterTax401k?: Split;
  /** Employer match and other employer contributions. */
  employer401k?: Split;
  /** The employee's own HSA contributions taken from pay before tax. */
  hsaPayroll?: Split;
  /** The employer's HSA contributions. Not income, but they use up the HSA limit. */
  hsaEmployer?: Split;
  /** Other pre-tax payroll deductions under a cafeteria plan: health premiums, FSA. */
  otherPretax?: Split;
  /** All federal income tax withheld so far, including from vests and bonuses. */
  federalWithholdingToDateCents: number;
  /** Federal income tax expected from the remaining regular paychecks. */
  restOfYearRegularWithholdingCents?: number;
  /** Rate the employer withholds on vests and bonuses. Defaults to the flat supplemental rate. */
  supplementalWithholdingRate?: number;
}

export interface ItemizedInput {
  /** State and local income (or sales) and property taxes paid, before the cap. */
  stateAndLocalTaxesCents?: number;
  mortgageInterestCents?: number;
  /** Anything else on Schedule A, already limited as that schedule requires. */
  otherCents?: number;
}

export interface FederalTaxInput {
  year: number;
  filingStatus: FilingStatus;
  earners: EarnerInput[];
  interestCents?: number;
  /** All ordinary dividends (1099-DIV box 1a), qualified ones included. */
  ordinaryDividendsCents?: number;
  /** The qualified part of the dividends above (box 1b). */
  qualifiedDividendsCents?: number;
  /** Net short-term gain or loss, realized and expected, leaving out ESPP sales listed below. */
  shortTermGainsCents?: number;
  /** Net long-term gain or loss, including capital gain distributions and any loss carried in. */
  longTermGainsCents?: number;
  esppDispositions?: EsppDisposition[];
  /** Any other income taxed at ordinary rates. */
  otherOrdinaryIncomeCents?: number;
  /** HSA contributions made outside payroll (deducted on the return). */
  hsaDirectCents?: number;
  hsaCoverage?: "self" | "family" | "none";
  /** Other adjustments to income, such as a deductible IRA contribution. */
  otherAdjustmentsCents?: number;
  /** `best` (the default) takes whichever is larger. */
  deduction?: "best" | "standard" | "itemized";
  itemized?: ItemizedInput;
  /** Cash gifts to charity. Used on Schedule A, or up to the small limit for people who don't itemize. */
  charitableCashCents?: number;
  estimatedPaymentsCents?: number;
  /** Left out, state tax is zero and the result says so. */
  state?: StateTax;
  rounding?: Rounding;
}

export interface IncomeTaxBreakdown {
  /** Taxable income taxed at ordinary rates. */
  ordinaryPortionCents: number;
  /** Qualified dividends and net capital gain inside taxable income. */
  preferentialCents: number;
  at0Cents: number;
  at15Cents: number;
  at20Cents: number;
  taxCents: number;
}

export interface EarnerPayroll {
  label: string;
  /** W-2 box 1 for this job, before ESPP income. */
  taxableWagesCents: number;
  medicareWagesCents: number;
  socialSecurityWagesCents: number;
  socialSecurityTaxCents: number;
  medicareTaxCents: number;
  additionalMedicareWithheldCents: number;
}

export interface EarnerRoom {
  label: string;
  /** Limit on the employee's own traditional plus Roth deferrals, catch-up included. */
  deferralLimitCents: number;
  deferralToDateCents: number;
  deferralPlannedCents: number;
  /** Room left if nothing more than the planned amounts goes in. */
  deferralLeftCents: number;
  /** Limit on everything going into the plan: deferrals, employer money and after-tax. */
  totalLimitCents: number;
  totalPlannedCents: number;
  totalLeftCents: number;
}

export interface RsuGap {
  incomeCents: number;
  /** Extra federal tax on the return because of the vests. */
  taxCausedCents: number;
  /** Income tax withheld from the vests at the supplemental rate, plus any extra Additional Medicare withheld. */
  withheldCents: number;
  /** Tax caused minus withheld: what the vests add to the bill at filing. */
  gapCents: number;
  /** Tax caused as a share of the vest income. */
  effectiveRate: number;
  withholdingRate: number;
}

export interface FederalTaxResult {
  year: number;
  filingStatus: FilingStatus;
  rounding: Rounding;
  income: {
    /** W-2 box 1 across all jobs, with RSU vests and ESPP ordinary income. */
    wagesCents: number;
    rsuCents: number;
    esppOrdinaryCents: number;
    interestCents: number;
    ordinaryDividendsCents: number;
    qualifiedDividendsCents: number;
    netShortTermCents: number;
    netLongTermCents: number;
    /** What reaches Form 1040 line 7: the net gain, or the loss up to the yearly limit. */
    capitalGainInAgiCents: number;
    /** Loss beyond the limit, carried to next year. */
    capitalLossCarryforwardCents: number;
    otherOrdinaryCents: number;
    adjustmentsCents: number;
    agiCents: number;
  };
  espp: EsppResult[];
  deduction: {
    used: "standard" | "itemized";
    amountCents: number;
    standardCents: number;
    itemizedCents: number;
    itemizedDetail: {
      saltPaidCents: number;
      saltCapCents: number;
      saltAllowedCents: number;
      mortgageInterestCents: number;
      charityGivenCents: number;
      charityAllowedCents: number;
      otherCents: number;
      /** The cut for income in the top bracket (IRC 68). */
      highIncomeReductionCents: number;
    };
  };
  taxableIncomeCents: number;
  tax: IncomeTaxBreakdown & {
    incomeTaxCents: number;
    netInvestmentIncomeCents: number;
    niitCents: number;
    additionalMedicareTaxCents: number;
    /** Income tax, NIIT and Additional Medicare Tax: the total on the return. */
    totalCents: number;
  };
  payroll: {
    earners: EarnerPayroll[];
    socialSecurityTaxCents: number;
    medicareTaxCents: number;
  };
  withholding: {
    toDateCents: number;
    projectedRegularCents: number;
    projectedSupplementalCents: number;
    additionalMedicareWithheldCents: number;
    estimatedPaymentsCents: number;
    totalCents: number;
  };
  /** Total tax minus payments. Positive is owed at filing, negative is a refund. */
  balanceDueCents: number;
  rsu: RsuGap | null;
  marginal: { ordinaryRate: number; capitalGainsRate: number };
  /** Total tax on the return over AGI. */
  effectiveRate: number;
  room: {
    earners: EarnerRoom[];
    hsa: { limitCents: number; plannedCents: number; leftCents: number } | null;
  };
  state: StateTaxResult;
  assumptions: string[];
  notice: string;
}

const total = (s: Split | undefined): number => (s ? s.toDateCents + s.restOfYearCents : 0);
const soFar = (s: Split | undefined): number => (s ? s.toDateCents : 0);
const cents = (dollarAmount: number): number => dollarAmount * 100;

/** Tax from the bracket schedule, exact, in 1/10,000 of a cent. */
function bracketScaled(incomeCents: number, brackets: Bracket[]): number {
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const b = brackets[i] as Bracket;
    const lo = cents(b.from);
    if (incomeCents <= lo) break;
    const next = brackets[i + 1];
    const hi = next ? cents(next.from) : Number.POSITIVE_INFINITY;
    tax += scaled(Math.min(incomeCents, hi) - lo, b.rate);
  }
  return tax;
}

/** The middle of the Tax Table band a whole-dollar income falls in, in cents. */
function taxTableMidpointCents(dollarsOfIncome: number): number {
  const d = dollarsOfIncome;
  let lo: number;
  let width: number;
  if (d < 5) [lo, width] = [0, 5];
  else if (d < 25) [lo, width] = [5 + Math.floor((d - 5) / 10) * 10, 10];
  else if (d < 3000) [lo, width] = [Math.floor(d / 25) * 25, 25];
  else [lo, width] = [Math.floor(d / 50) * 50, 50];
  return (lo * 2 + width) * 50;
}

/**
 * Tax on income taxed entirely at ordinary rates. With `form1040` rounding,
 * income under $100,000 uses the Tax Table method and larger income the Tax
 * Computation Worksheet (the plain formula, cents kept).
 */
export function ordinaryTaxCents(
  params: TaxParams,
  status: FilingStatus,
  incomeCents: number,
  rounding: Rounding = "cents",
): number {
  if (incomeCents <= 0) return 0;
  const brackets = params.ordinaryBrackets[status];
  if (rounding === "cents") return unscale(bracketScaled(incomeCents, brackets));
  const d = roundDiv(incomeCents, 100);
  if (d >= 100_000) return unscale(bracketScaled(d * 100, brackets));
  return roundDiv(bracketScaled(taxTableMidpointCents(d), brackets), 1_000_000) * 100;
}

/**
 * Income tax on taxable income that includes qualified dividends and net
 * capital gain, following the Qualified Dividends and Capital Gain Tax
 * Worksheet: ordinary income fills the brackets first, then the preferential
 * income stacks on top and is taxed at 0, 15 and 20 percent by where it lands.
 */
export function incomeTax(
  params: TaxParams,
  status: FilingStatus,
  taxableIncomeCents: number,
  preferentialIncomeCents: number,
  rounding: Rounding = "cents",
): IncomeTaxBreakdown {
  const ti = Math.max(0, taxableIncomeCents);
  const pref = Math.min(Math.max(0, preferentialIncomeCents), ti);
  const ordinary = ti - pref; // worksheet line 5
  const zeroMax = cents(params.capitalGains.maxZeroRate[status]);
  const fifteenMax = cents(params.capitalGains.max15Rate[status]);
  const at0 = Math.min(ti, zeroMax) - Math.min(ordinary, Math.min(ti, zeroMax)); // line 9
  const at15 = Math.min(pref - at0, Math.max(0, Math.min(ti, fifteenMax) - (ordinary + at0))); // line 17
  const at20 = pref - at0 - at15; // line 20
  const [, rate15, rate20] = params.capitalGains.rates as [number, number, number];

  let tax: number;
  if (rounding === "form1040") {
    const stacked =
      roundToDollar(applyRate(at15, rate15)) +
      roundToDollar(applyRate(at20, rate20)) +
      roundToDollar(ordinaryTaxCents(params, status, ordinary, rounding));
    const allOrdinary = roundToDollar(ordinaryTaxCents(params, status, ti, rounding));
    tax = Math.min(stacked, allOrdinary);
  } else {
    const brackets = params.ordinaryBrackets[status];
    const stacked = bracketScaled(ordinary, brackets) + scaled(at15, rate15) + scaled(at20, rate20);
    tax = unscale(Math.min(stacked, bracketScaled(ti, brackets)));
  }
  return { ordinaryPortionCents: ordinary, preferentialCents: pref, at0Cents: at0, at15Cents: at15, at20Cents: at20, taxCents: tax };
}

/** The rate on the next dollar of ordinary income, and on the next dollar of long-term gain. */
export function marginalRates(
  params: TaxParams,
  status: FilingStatus,
  taxableIncomeCents: number,
  preferentialIncomeCents: number,
): { ordinaryRate: number; capitalGainsRate: number } {
  const ti = Math.max(0, taxableIncomeCents);
  const ordinary = ti - Math.min(Math.max(0, preferentialIncomeCents), ti);
  const brackets = params.ordinaryBrackets[status];
  let ordinaryRate = (brackets[0] as Bracket).rate;
  for (const b of brackets) if (ordinary >= cents(b.from)) ordinaryRate = b.rate;
  const [rate0, rate15, rate20] = params.capitalGains.rates as [number, number, number];
  const capitalGainsRate =
    ti < cents(params.capitalGains.maxZeroRate[status]) ? rate0 : ti < cents(params.capitalGains.max15Rate[status]) ? rate15 : rate20;
  return { ordinaryRate, capitalGainsRate };
}

/** Federal income tax an employer withholds from supplemental pay (vests, bonuses) at the flat rate. */
export function supplementalWithholdingCents(params: TaxParams, supplementalCents: number, rate?: number): number {
  const s = params.supplementalWithholding;
  const million = cents(s.millionThreshold);
  const under = Math.min(Math.max(0, supplementalCents), million);
  const over = Math.max(0, supplementalCents - million);
  return applyRate(under, rate ?? s.rate) + applyRate(over, s.overMillionRate);
}

/** The state and local tax deduction limit at a given modified AGI. */
export function saltCapCents(params: TaxParams, status: FilingStatus, magiCents: number): number {
  const half = status === "mfs" ? 2 : 1;
  const s = params.saltCap;
  const cap = cents(s.cap) / half;
  const over = Math.max(0, magiCents - cents(s.phaseDownThreshold) / half);
  return Math.max(cents(s.floor) / half, cap - applyRate(over, s.phaseDownRate));
}

/** The 401(k) deferral limit for a person of a given age at year end. */
export function deferralLimitCents(params: TaxParams, age: number | undefined): number {
  const r = params.retirementPlans;
  const catchUp = age === undefined || age < 50 ? 0 : age >= 60 && age <= 63 ? r.catchUp60to63 : r.catchUp50;
  return cents(r.electiveDeferral + catchUp);
}

interface Assessment {
  result: Omit<FederalTaxResult, "rsu" | "assumptions" | "notice">;
  supplementalWithheldCents: number;
}

function assess(input: FederalTaxInput, params: TaxParams): Assessment {
  const status = input.filingStatus;
  const rounding = input.rounding ?? "cents";
  const r = (c: number): number => (rounding === "form1040" ? roundToDollar(c) : c);

  // Payroll: wages for income tax and for Social Security and Medicare.
  const payrollEarners: EarnerPayroll[] = [];
  const room: EarnerRoom[] = [];
  let wages = 0;
  let rsu = 0;
  let medicareWages = 0;
  let toDate = 0;
  let projectedRegular = 0;
  let projectedSupplemental = 0;
  let supplementalWithheld = 0;
  let hsaPlanned = input.hsaDirectCents ?? 0;
  for (const e of input.earners) {
    const gross = total(e.regularPay) + total(e.bonus) + total(e.rsuVests);
    const cafeteria = total(e.hsaPayroll) + total(e.otherPretax);
    const medicare = Math.max(0, gross - cafeteria);
    const taxable = Math.max(0, medicare - total(e.traditional401k));
    const ssWages = Math.min(medicare, cents(params.socialSecurity.wageBase));
    payrollEarners.push({
      label: e.label,
      taxableWagesCents: taxable,
      medicareWagesCents: medicare,
      socialSecurityWagesCents: ssWages,
      socialSecurityTaxCents: applyRate(ssWages, params.socialSecurity.rate),
      medicareTaxCents: applyRate(medicare, params.medicare.rate),
      additionalMedicareWithheldCents: applyRate(
        Math.max(0, medicare - cents(params.additionalMedicare.employerWithholdingThreshold)),
        params.additionalMedicare.rate,
      ),
    });
    wages += taxable;
    rsu += total(e.rsuVests);
    medicareWages += medicare;

    const supplementalAll = total(e.bonus) + total(e.rsuVests);
    const supplementalSoFar = soFar(e.bonus) + soFar(e.rsuVests);
    const rate = e.supplementalWithholdingRate;
    const withheldAll = supplementalWithholdingCents(params, supplementalAll, rate);
    toDate += e.federalWithholdingToDateCents;
    projectedRegular += e.restOfYearRegularWithholdingCents ?? 0;
    projectedSupplemental += withheldAll - supplementalWithholdingCents(params, supplementalSoFar, rate);
    supplementalWithheld += withheldAll;

    const deferralLimit = deferralLimitCents(params, e.age);
    const deferralPlanned = total(e.traditional401k) + total(e.roth401k);
    // Catch-up deferrals sit outside the overall limit.
    const catchUpUsed = Math.max(0, deferralPlanned - cents(params.retirementPlans.electiveDeferral));
    const totalPlanned = deferralPlanned - catchUpUsed + total(e.afterTax401k) + total(e.employer401k);
    const totalLimit = cents(params.retirementPlans.annualAdditions);
    room.push({
      label: e.label,
      deferralLimitCents: deferralLimit,
      deferralToDateCents: soFar(e.traditional401k) + soFar(e.roth401k),
      deferralPlannedCents: deferralPlanned,
      deferralLeftCents: Math.max(0, deferralLimit - deferralPlanned),
      totalLimitCents: totalLimit,
      totalPlannedCents: totalPlanned,
      totalLeftCents: Math.max(0, totalLimit - totalPlanned),
    });
    hsaPlanned += total(e.hsaPayroll) + total(e.hsaEmployer);
  }

  // Income.
  const espp = (input.esppDispositions ?? []).map(esppDisposition);
  const esppOrdinary = espp.reduce((s, d) => s + d.ordinaryIncomeCents, 0);
  const wagesLine = r(wages + esppOrdinary);
  const interest = r(input.interestCents ?? 0);
  const ordinaryDividends = r(input.ordinaryDividendsCents ?? 0);
  const qualifiedDividends = Math.min(r(input.qualifiedDividendsCents ?? 0), ordinaryDividends);
  const shortTerm = r((input.shortTermGainsCents ?? 0) + espp.reduce((s, d) => s + (d.longTerm ? 0 : d.capitalGainCents), 0));
  const longTerm = r((input.longTermGainsCents ?? 0) + espp.reduce((s, d) => s + (d.longTerm ? d.capitalGainCents : 0), 0));
  const netCapital = shortTerm + longTerm;
  const capitalInAgi = Math.max(netCapital, -cents(params.capitalLossLimit[status]));
  const netCapitalGain = Math.max(0, Math.min(longTerm, netCapital));
  const otherOrdinary = r(input.otherOrdinaryIncomeCents ?? 0);
  const adjustments = r((input.hsaDirectCents ?? 0) + (input.otherAdjustmentsCents ?? 0));
  const agi = wagesLine + interest + ordinaryDividends + capitalInAgi + otherOrdinary - adjustments;

  // Deduction.
  const charityGiven = r(input.charitableCashCents ?? 0);
  const standard = cents(params.standardDeduction[status]) + Math.min(charityGiven, cents(params.nonItemizerCharity[status]));
  const saltPaid = r(input.itemized?.stateAndLocalTaxesCents ?? 0);
  const saltCap = saltCapCents(params, status, agi);
  const saltAllowed = Math.min(saltPaid, saltCap);
  const mortgage = r(input.itemized?.mortgageInterestCents ?? 0);
  const otherItemized = r(input.itemized?.otherCents ?? 0);
  const charityAllowed = Math.max(0, charityGiven - r(applyRate(Math.max(0, agi), params.charityFloor.rateOfAgi)));
  const itemizedBefore = saltAllowed + mortgage + charityAllowed + otherItemized;
  const brackets = params.ordinaryBrackets[status];
  const topStart = cents((brackets[brackets.length - 1] as Bracket).from);
  const overTop = Math.max(0, Math.max(0, agi - itemizedBefore) + itemizedBefore - topStart);
  const highIncomeReduction = r(
    roundDiv(Math.min(itemizedBefore, overTop) * params.itemizedLimit.numerator, params.itemizedLimit.denominator),
  );
  const itemized = itemizedBefore - highIncomeReduction;
  const choice = input.deduction ?? "best";
  const used: "standard" | "itemized" = choice === "best" ? (itemized > standard ? "itemized" : "standard") : choice;
  const deduction = used === "itemized" ? itemized : standard;
  const taxableIncome = Math.max(0, agi - deduction);

  // Tax.
  const breakdown = incomeTax(params, status, taxableIncome, qualifiedDividends + netCapitalGain, rounding);
  const netInvestmentIncome = Math.max(0, interest + ordinaryDividends + capitalInAgi);
  const niit = r(
    applyRate(Math.min(netInvestmentIncome, Math.max(0, agi - cents(params.niit.threshold[status]))), params.niit.rate),
  );
  const additionalMedicare = r(
    applyRate(Math.max(0, medicareWages - cents(params.additionalMedicare.threshold[status])), params.additionalMedicare.rate),
  );
  const totalTax = breakdown.taxCents + niit + additionalMedicare;

  // Payments.
  const additionalMedicareWithheld = payrollEarners.reduce((s, e) => s + e.additionalMedicareWithheldCents, 0);
  const estimated = input.estimatedPaymentsCents ?? 0;
  const payments = r(toDate + projectedRegular + projectedSupplemental + additionalMedicareWithheld + estimated);

  // HSA room.
  const coverage = input.hsaCoverage ?? "none";
  const hsaLimit = coverage === "none" ? null : cents(coverage === "family" ? params.hsa.family : params.hsa.selfOnly);

  const state = (input.state ?? STATE_TAX_NOT_MODELED).compute({
    year: input.year,
    filingStatus: status,
    federalAgiCents: agi,
    wagesCents: wagesLine,
    federalTaxableIncomeCents: taxableIncome,
    netCapitalGainCents: netCapitalGain,
  });

  return {
    supplementalWithheldCents: supplementalWithheld,
    result: {
      year: input.year,
      filingStatus: status,
      rounding,
      income: {
        wagesCents: wagesLine,
        rsuCents: rsu,
        esppOrdinaryCents: esppOrdinary,
        interestCents: interest,
        ordinaryDividendsCents: ordinaryDividends,
        qualifiedDividendsCents: qualifiedDividends,
        netShortTermCents: shortTerm,
        netLongTermCents: longTerm,
        capitalGainInAgiCents: capitalInAgi,
        capitalLossCarryforwardCents: capitalInAgi - netCapital,
        otherOrdinaryCents: otherOrdinary,
        adjustmentsCents: adjustments,
        agiCents: agi,
      },
      espp,
      deduction: {
        used,
        amountCents: deduction,
        standardCents: standard,
        itemizedCents: itemized,
        itemizedDetail: {
          saltPaidCents: saltPaid,
          saltCapCents: saltCap,
          saltAllowedCents: saltAllowed,
          mortgageInterestCents: mortgage,
          charityGivenCents: charityGiven,
          charityAllowedCents: charityAllowed,
          otherCents: otherItemized,
          highIncomeReductionCents: highIncomeReduction,
        },
      },
      taxableIncomeCents: taxableIncome,
      tax: {
        ...breakdown,
        incomeTaxCents: breakdown.taxCents,
        netInvestmentIncomeCents: netInvestmentIncome,
        niitCents: niit,
        additionalMedicareTaxCents: additionalMedicare,
        totalCents: totalTax,
      },
      payroll: {
        earners: payrollEarners,
        socialSecurityTaxCents: payrollEarners.reduce((s, e) => s + e.socialSecurityTaxCents, 0),
        medicareTaxCents: payrollEarners.reduce((s, e) => s + e.medicareTaxCents, 0),
      },
      withholding: {
        toDateCents: toDate,
        projectedRegularCents: projectedRegular,
        projectedSupplementalCents: projectedSupplemental,
        additionalMedicareWithheldCents: additionalMedicareWithheld,
        estimatedPaymentsCents: estimated,
        totalCents: payments,
      },
      balanceDueCents: totalTax - payments,
      marginal: marginalRates(params, status, taxableIncome, qualifiedDividends + netCapitalGain),
      effectiveRate: agi > 0 ? totalTax / agi : 0,
      room: {
        earners: room,
        hsa: hsaLimit === null ? null : { limitCents: hsaLimit, plannedCents: hsaPlanned, leftCents: Math.max(0, hsaLimit - hsaPlanned) },
      },
      state,
    },
  };
}

const withoutRsus = (input: FederalTaxInput): FederalTaxInput => ({
  ...input,
  earners: input.earners.map((e) => ({ ...e, rsuVests: undefined })),
});

/** What the engine leaves out or simplifies. Shown with every result. */
export const FEDERAL_TAX_SIMPLIFICATIONS: readonly string[] = [
  "Not included: the alternative minimum tax, every credit (child, education, foreign tax, energy, saver's), self-employment and business income, rental income, Social Security benefits, the deductions for tips, overtime and car loan interest, the extra standard deduction at 65 or for blindness, and underpayment penalties.",
  "All long-term gains are taxed at 0, 15 or 20 percent. The 25 and 28 percent rates on real estate depreciation and collectibles are not modeled.",
  "Net investment income is interest, dividends and net gains with nothing subtracted, so the 3.8 percent tax can be slightly overstated.",
  "The charity deduction applies the new floor (0.5 percent of income) but not the ceilings by share of income, and treats every gift as cash to a public charity.",
  "Social Security tax is figured per job listed. Someone who changed employers mid-year may have had too much withheld; that credit is not modeled.",
  "ESPP income is added to wages with no withholding and no Social Security or Medicare tax.",
  "Health premiums, FSA and payroll HSA contributions are treated as free of income, Social Security and Medicare tax (a cafeteria plan).",
  "The HSA catch-up at 55 and the IRA limits are not modeled.",
];

/**
 * The federal estimate for one tax year: income tax with ordinary and
 * capital-gains brackets, NIIT, Social Security and Medicare, withholding so
 * far and projected, the shortfall from flat-rate withholding on RSU vests,
 * and room left in the 401(k) and HSA.
 */
export function computeFederalTax(input: FederalTaxInput): FederalTaxResult {
  const params = taxParams(input.year);
  const { result, supplementalWithheldCents } = assess(input, params);

  let rsu: RsuGap | null = null;
  if (result.income.rsuCents > 0) {
    const without = assess(withoutRsus(input), params);
    const taxCaused = result.tax.totalCents - without.result.tax.totalCents;
    const withheld =
      supplementalWithheldCents -
      without.supplementalWithheldCents +
      (result.withholding.additionalMedicareWithheldCents - without.result.withholding.additionalMedicareWithheldCents);
    rsu = {
      incomeCents: result.income.rsuCents,
      taxCausedCents: taxCaused,
      withheldCents: withheld,
      gapCents: taxCaused - withheld,
      effectiveRate: taxCaused / result.income.rsuCents,
      withholdingRate: params.supplementalWithholding.rate,
    };
  }

  const assumptions = [
    `Tax year ${input.year} federal amounts from IRS Rev. Proc. 2025-32, Notice 2025-67, Rev. Proc. 2025-19, Publication 15 and Pub. L. 119-21; each number's source is in tax/params/${input.year}.json.`,
    `Filing status: ${input.filingStatus}. Deduction used: ${result.deduction.used}.`,
    result.rounding === "form1040"
      ? "Rounded as on Form 1040: whole dollars, with the Tax Table for taxable income under $100,000."
      : "Bracket formulas applied to the cent, without the Tax Table's $50 bands, so the filed return can differ by a few dollars.",
    "Rest-of-year pay, vests, bonuses and withholding are the amounts given, not forecasts by the engine. Vests and bonuses still to come are assumed to have federal income tax withheld at the flat supplemental rate.",
    ...result.state.notes,
    ...FEDERAL_TAX_SIMPLIFICATIONS,
    ...params.unverified,
  ];
  return { ...result, rsu, assumptions, notice: ESTIMATE_NOTICE };
}
