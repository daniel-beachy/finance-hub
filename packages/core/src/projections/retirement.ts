import { incomeTax } from "../tax/federal.ts";
import { applyRate } from "../tax/math.ts";
import { type FilingStatus, type TaxParams, taxParams } from "../tax/params.ts";
import { createRng } from "../util/rng.ts";
import { ESTIMATE_NOTICE } from "./notice.ts";

/** Money held by how it is taxed. All amounts are in today's dollars, in cents. */
export interface Balances {
  /** A regular brokerage or savings account. */
  taxableCents: number;
  /** Pre-tax accounts: traditional 401(k) and IRA. Withdrawals are ordinary income. */
  traditionalCents: number;
  /** Roth accounts. Withdrawals are tax-free. */
  rothCents: number;
  hsaCents: number;
}

export interface AssetClass {
  name: string;
  /** Share of the portfolio, 0 to 1. Weights sum to 1. */
  weight: number;
  /** Expected yearly return after inflation, for example 0.05. */
  realReturn: number;
  /** Standard deviation of the yearly return, for example 0.17. */
  volatility: number;
}

export interface RetirementInput {
  /** Age now. A household is modeled as one person of this age. */
  currentAge: number;
  retirementAge: number;
  /** The plan must last until this age. */
  endAge: number;
  filingStatus: FilingStatus;
  /** Which year's tax rules to apply, in today's dollars, for every future year. */
  taxYear: number;
  balances: Balances;
  /** What the taxable balance cost. Defaults to the whole balance (no gain yet). */
  taxableBasisCents?: number;
  /** Saved each year until retirement, by where it goes. */
  annualSavings: Balances;
  /** Yearly growth of savings beyond inflation. Default 0. */
  savingsGrowth?: number;
  /** Spending each year in retirement, after tax. */
  retirementSpendingCents: number;
  /** The household's yearly benefit in today's dollars and the age it starts. */
  socialSecurity?: { annualBenefitCents: number; startAge: number };
  assetClasses: AssetClass[];
  /** Correlation between each pair of asset classes. Default 0. */
  correlation?: number;
  /** Yearly inflation. Only used to wear down the taxable account's cost basis in today's dollars. */
  inflation: number;
}

/**
 * Round planning numbers, not forecasts and not looked up from a source:
 * the builder's starting point for the Plan page, meant to be changed there.
 */
export const DEFAULT_RETIREMENT_ASSUMPTIONS = {
  endAge: 95,
  inflation: 0.025,
  correlation: 0,
  stocks: { name: "Stocks", realReturn: 0.05, volatility: 0.17 },
  bonds: { name: "Bonds", realReturn: 0.015, volatility: 0.06 },
  cash: { name: "Cash", realReturn: 0, volatility: 0.01 },
} as const;

export interface RetirementYear {
  age: number;
  phase: "saving" | "retired";
  /** Balances at the start of the year. */
  start: Balances;
  startTotalCents: number;
  /** The year's real return. */
  realReturn: number;
  contributionsCents: number;
  withdrawals: Balances;
  socialSecurityCents: number;
  /** Federal income tax, NIIT and any early-withdrawal tax on the year's withdrawals. */
  taxCents: number;
  spendingCents: number;
  /** Spending the accounts could not cover. */
  shortfallCents: number;
  endTotalCents: number;
}

export interface Portfolio {
  /** Weighted average of the asset classes' expected real returns. */
  meanRealReturn: number;
  volatility: number;
  /** The return a typical (median) year compounds at, lower than the mean because of volatility. */
  medianRealReturn: number;
}

export interface DeterministicProjection {
  rows: RetirementYear[];
  balanceAtRetirementCents: number;
  endBalanceCents: number;
  /** The first age at which spending could not be met, or null if the money lasts. */
  depletedAtAge: number | null;
  portfolio: Portfolio;
  assumptions: string[];
  notice: string;
}

export interface PercentileBand {
  /** Total balance at the start of this age (the last row is the end of the plan). */
  age: number;
  p10Cents: number;
  p25Cents: number;
  p50Cents: number;
  p75Cents: number;
  p90Cents: number;
}

export interface MonteCarloResult {
  runs: number;
  seed: number;
  /** Share of runs in which spending was met every year to the end age. */
  successProbability: number;
  bands: PercentileBand[];
  portfolio: Portfolio;
  assumptions: string[];
  notice: string;
}

export interface MonteCarloOptions {
  /** Default 1,000. */
  runs?: number;
  /** Default 1. The same seed always gives the same result. */
  seed?: number;
}

export interface EarliestRetirementResult {
  /** The earliest age whose success probability reaches the target, or null if none does by `maxAge`. */
  age: number | null;
  target: number;
  /** Every age tried, in order, up to and including the one that passed. */
  tried: { age: number; successProbability: number }[];
  runs: number;
  seed: number;
  assumptions: string[];
  notice: string;
}

/** What the retirement engine leaves out or simplifies. Shown with every result. */
export const RETIREMENT_SIMPLIFICATIONS: readonly string[] = [
  "Everything is in today's dollars. Returns are after inflation, and the chosen year's tax brackets are assumed to keep pace with inflation (the 3.8 percent investment tax thresholds in fact do not).",
  "A household is one person with one age, one retirement date and one Social Security benefit.",
  "Each year: while saving, the balances grow and the year's savings go in at year end. In retirement, the year's spending and tax come out at the start of the year and the rest grows.",
  "Withdrawals come from the taxable account first, then traditional, then Roth, then the HSA.",
  "Traditional withdrawals are ordinary income. Taxable-account withdrawals realize gains in proportion to the account's gain and are taxed at long-term rates. Roth and HSA withdrawals are tax-free (the HSA is assumed to pay for medical costs). Only the standard deduction is applied.",
  "The largest taxable share of Social Security benefits (85 percent) is taxed in every case, which overstates tax at low incomes.",
  "Traditional withdrawals before age 60 pay the 10 percent early-distribution tax. Roth and HSA withdrawals never do, though the real rules can charge it on Roth earnings before 59 and a half.",
  "Not modeled: required minimum distributions, Roth conversions, state tax, tax on dividends and interest while the taxable account is held, Medicare premiums and surcharges, pensions, annuities, selling a home, and changes in spending with age.",
  "Income tax while working is not modeled: yearly savings are the amounts given.",
  "Every account holds the same mix of assets, rebalanced yearly, and the mix never changes with age.",
  "Monte Carlo draws each year's return independently from a lognormal distribution with the portfolio's mean and volatility. Real markets have fatter tails and runs of bad years.",
];

const KEYS = ["taxableCents", "traditionalCents", "rothCents", "hsaCents"] as const;
const sum = (b: Balances): number => b.taxableCents + b.traditionalCents + b.rothCents + b.hsaCents;
const zero = (): Balances => ({ taxableCents: 0, traditionalCents: 0, rothCents: 0, hsaCents: 0 });
const rounded = (b: Balances): Balances => ({
  taxableCents: Math.round(b.taxableCents),
  traditionalCents: Math.round(b.traditionalCents),
  rothCents: Math.round(b.rothCents),
  hsaCents: Math.round(b.hsaCents),
});

function validate(input: RetirementInput): void {
  const fail = (message: string): never => {
    throw new Error(`Retirement projection: ${message}`);
  };
  if (!(input.retirementAge >= input.currentAge)) fail("the retirement age is before the current age.");
  if (!(input.endAge > input.retirementAge)) fail("the end age must be after the retirement age.");
  if (!Number.isInteger(input.currentAge) || !Number.isInteger(input.retirementAge) || !Number.isInteger(input.endAge))
    fail("ages must be whole numbers.");
  if (input.assetClasses.length === 0) fail("at least one asset class is needed.");
  const weight = input.assetClasses.reduce((s, a) => s + a.weight, 0);
  if (Math.abs(weight - 1) > 1e-6) fail(`asset class weights sum to ${weight}, not 1.`);
  if (input.retirementSpendingCents < 0) fail("spending can't be negative.");
}

/** The whole portfolio's expected real return and volatility from its asset classes. */
export function portfolioOf(input: Pick<RetirementInput, "assetClasses" | "correlation">): Portfolio {
  const classes = input.assetClasses;
  const rho = input.correlation ?? 0;
  let mean = 0;
  let variance = 0;
  for (let i = 0; i < classes.length; i++) {
    const a = classes[i] as AssetClass;
    mean += a.weight * a.realReturn;
    variance += (a.weight * a.volatility) ** 2;
    for (let j = i + 1; j < classes.length; j++) {
      const b = classes[j] as AssetClass;
      variance += 2 * rho * a.weight * a.volatility * b.weight * b.volatility;
    }
  }
  const volatility = Math.sqrt(Math.max(0, variance));
  const { mu } = lognormal(mean, volatility);
  return { meanRealReturn: mean, volatility, medianRealReturn: Math.exp(mu) - 1 };
}

/** Parameters of ln(1 + return) so that the return has the given mean and standard deviation. */
function lognormal(mean: number, volatility: number): { mu: number; sigma: number } {
  const sigma2 = Math.log(1 + (volatility / (1 + mean)) ** 2);
  return { mu: Math.log(1 + mean) - sigma2 / 2, sigma: Math.sqrt(sigma2) };
}

/**
 * Tax on one retirement year's withdrawals: income tax on traditional
 * withdrawals, the taxable share of Social Security and realized gains, after
 * the standard deduction; NIIT on the gains; and the early-distribution tax.
 */
export function retirementYearTaxCents(
  params: TaxParams,
  status: FilingStatus,
  y: { age: number; traditionalCents: number; realizedGainCents: number; socialSecurityCents: number },
): number {
  const ordinary = Math.round(y.traditionalCents) + applyRate(Math.round(y.socialSecurityCents), params.socialSecurityBenefits.maxTaxableShare);
  const gain = Math.max(0, Math.round(y.realizedGainCents));
  const agi = ordinary + gain;
  const taxable = Math.max(0, agi - params.standardDeduction[status] * 100);
  const income = incomeTax(params, status, taxable, gain).taxCents;
  const niit = applyRate(Math.min(gain, Math.max(0, agi - params.niit.threshold[status] * 100)), params.niit.rate);
  const early = y.age < params.earlyDistribution.age ? applyRate(Math.round(y.traditionalCents), params.earlyDistribution.rate) : 0;
  return income + niit + early;
}

interface Run {
  rows: RetirementYear[];
  /** Total at the start of each age, then at the end of the plan. */
  totals: number[];
  success: boolean;
  depletedAtAge: number | null;
}

function simulate(input: RetirementInput, params: TaxParams, returnFor: (yearIndex: number) => number, collect: boolean): Run {
  const b: Balances = { ...input.balances };
  let basis = Math.min(input.taxableBasisCents ?? b.taxableCents, b.taxableCents);
  const rows: RetirementYear[] = [];
  const totals: number[] = [];
  let depletedAtAge: number | null = null;
  const growth = input.savingsGrowth ?? 0;
  const ss = input.socialSecurity;

  for (let age = input.currentAge; age < input.endAge; age++) {
    const i = age - input.currentAge;
    const r = returnFor(i);
    const start = collect ? rounded(b) : b;
    const startTotal = sum(b);
    totals.push(startTotal);
    const withdrawals = zero();
    let contributions = 0;
    let tax = 0;
    let shortfall = 0;
    let benefit = 0;
    const retired = age >= input.retirementAge;

    if (retired) {
      benefit = ss && age >= ss.startAge ? ss.annualBenefitCents : 0;
      const gainShare = b.taxableCents > 0 ? Math.max(0, 1 - basis / b.taxableCents) : 0;
      // Tax depends on the withdrawals and the withdrawals on the tax, so repeat until they agree.
      for (let pass = 0; pass < 60; pass++) {
        let need = Math.max(0, input.retirementSpendingCents + tax - benefit);
        for (const k of KEYS) {
          withdrawals[k] = Math.min(b[k], need);
          need -= withdrawals[k];
        }
        shortfall = need;
        const next = retirementYearTaxCents(params, input.filingStatus, {
          age,
          traditionalCents: withdrawals.traditionalCents,
          realizedGainCents: withdrawals.taxableCents * gainShare,
          socialSecurityCents: benefit,
        });
        const settled = Math.abs(next - tax) < 1;
        tax = next;
        if (settled) break;
      }
      if (b.taxableCents > 0) basis *= 1 - withdrawals.taxableCents / b.taxableCents;
      for (const k of KEYS) b[k] -= withdrawals[k];
      // Social Security beyond the year's spending and tax is saved.
      const surplus = benefit - tax - input.retirementSpendingCents;
      if (surplus > 0) {
        b.taxableCents += surplus;
        basis += surplus;
      }
      if (shortfall >= 1 && depletedAtAge === null) depletedAtAge = age;
    }

    for (const k of KEYS) b[k] *= 1 + r;
    basis /= 1 + input.inflation;

    if (!retired) {
      const factor = (1 + growth) ** i;
      for (const k of KEYS) {
        const add = input.annualSavings[k] * factor;
        b[k] += add;
        contributions += add;
      }
      basis += input.annualSavings.taxableCents * factor;
    }

    if (collect) {
      rows.push({
        age,
        phase: retired ? "retired" : "saving",
        start,
        startTotalCents: Math.round(startTotal),
        realReturn: r,
        contributionsCents: Math.round(contributions),
        withdrawals: rounded(withdrawals),
        socialSecurityCents: Math.round(benefit),
        taxCents: Math.round(tax),
        spendingCents: retired ? input.retirementSpendingCents : 0,
        shortfallCents: Math.round(shortfall),
        endTotalCents: Math.round(sum(b)),
      });
    }
  }
  totals.push(sum(b));
  return { rows, totals, success: depletedAtAge === null, depletedAtAge };
}

function assumptionsFor(input: RetirementInput, portfolio: Portfolio, extra: string[] = []): string[] {
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  const dollars = (c: number): string => `$${Math.round(c / 100).toLocaleString("en-US")}`;
  const ss = input.socialSecurity;
  return [
    `Age ${input.currentAge} now, retiring at ${input.retirementAge}, planning to age ${input.endAge}. Filing status ${input.filingStatus}, ${input.taxYear} tax rules.`,
    `Spending in retirement: ${dollars(input.retirementSpendingCents)} a year after tax. Savings until then: ${dollars(sum(input.annualSavings))} a year${input.savingsGrowth ? `, growing ${pct(input.savingsGrowth)} a year beyond inflation` : ""}.`,
    ss ? `Social Security: ${dollars(ss.annualBenefitCents)} a year from age ${ss.startAge}.` : "No Social Security income.",
    `Portfolio: ${input.assetClasses.map((a) => `${pct(a.weight)} ${a.name} (${pct(a.realReturn)} real return, ${pct(a.volatility)} volatility)`).join(", ")}. Together: ${pct(portfolio.meanRealReturn)} expected real return, ${pct(portfolio.volatility)} volatility. Inflation ${pct(input.inflation)}.`,
    ...extra,
    ...RETIREMENT_SIMPLIFICATIONS,
  ];
}

/** One projection in which every year earns the portfolio's expected real return. */
export function projectRetirement(input: RetirementInput): DeterministicProjection {
  validate(input);
  const params = taxParams(input.taxYear);
  const portfolio = portfolioOf(input);
  const run = simulate(input, params, () => portfolio.meanRealReturn, true);
  return {
    rows: run.rows,
    balanceAtRetirementCents: Math.round(run.totals[input.retirementAge - input.currentAge] as number),
    endBalanceCents: Math.round(run.totals[run.totals.length - 1] as number),
    depletedAtAge: run.depletedAtAge,
    portfolio,
    assumptions: assumptionsFor(input, portfolio, [
      "Every year earns the expected return. Real returns vary, and a typical outcome is lower than this line: see the Monte Carlo result.",
    ]),
    notice: ESTIMATE_NOTICE,
  };
}

/** A sampler of yearly real returns: lognormal, so a year can never lose more than everything. */
function returnSampler(portfolio: Portfolio, seed: number): () => number {
  const rng = createRng(seed);
  const { mu, sigma } = lognormal(portfolio.meanRealReturn, portfolio.volatility);
  return () => {
    const u1 = 1 - rng.next();
    const u2 = rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(mu + sigma * z) - 1;
  };
}

function monteCarlo(input: RetirementInput, params: TaxParams, portfolio: Portfolio, runs: number, seed: number, keepTotals: boolean) {
  const sample = returnSampler(portfolio, seed);
  const years = input.endAge - input.currentAge;
  const returns = new Array<number>(years);
  const totals: number[][] = [];
  let successes = 0;
  for (let n = 0; n < runs; n++) {
    // Draw the whole path first, so run n sees the same returns whatever the retirement age.
    for (let y = 0; y < years; y++) returns[y] = sample();
    const run = simulate(input, params, (y) => returns[y] as number, false);
    if (run.success) successes++;
    if (keepTotals) totals.push(run.totals);
  }
  return { successProbability: successes / runs, totals };
}

/** The value at a percentile (0 to 1) of a sorted list, by nearest rank. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}

/**
 * Many projections with random yearly returns. Seeded: the same input and
 * seed always give the same result.
 */
export function simulateRetirement(input: RetirementInput, options: MonteCarloOptions = {}): MonteCarloResult {
  validate(input);
  const runs = options.runs ?? 1000;
  const seed = options.seed ?? 1;
  const params = taxParams(input.taxYear);
  const portfolio = portfolioOf(input);
  const mc = monteCarlo(input, params, portfolio, runs, seed, true);
  const bands: PercentileBand[] = [];
  for (let i = 0; i <= input.endAge - input.currentAge; i++) {
    const column = mc.totals.map((t) => t[i] as number).sort((a, b) => a - b);
    const at = (p: number): number => Math.round(percentile(column, p));
    bands.push({ age: input.currentAge + i, p10Cents: at(0.1), p25Cents: at(0.25), p50Cents: at(0.5), p75Cents: at(0.75), p90Cents: at(0.9) });
  }
  return {
    runs,
    seed,
    successProbability: mc.successProbability,
    bands,
    portfolio,
    assumptions: assumptionsFor(input, portfolio, [
      `${runs.toLocaleString("en-US")} random runs, seed ${seed}. Success means spending was met every year to age ${input.endAge}.`,
    ]),
    notice: ESTIMATE_NOTICE,
  };
}

/**
 * The earliest retirement age at which the Monte Carlo success probability
 * reaches the target (default 90%). Tries each age in turn from the current
 * age (or `minAge`) to `maxAge` (default 75), with the same random returns
 * for every age so the ages are compared on equal terms.
 */
export function earliestRetirementAge(
  input: RetirementInput,
  options: MonteCarloOptions & { target?: number; minAge?: number; maxAge?: number } = {},
): EarliestRetirementResult {
  const runs = options.runs ?? 1000;
  const seed = options.seed ?? 1;
  const target = options.target ?? 0.9;
  const first = Math.max(input.currentAge, options.minAge ?? input.currentAge);
  const last = Math.min(options.maxAge ?? 75, input.endAge - 1);
  validate({ ...input, retirementAge: first });
  const params = taxParams(input.taxYear);
  const portfolio = portfolioOf(input);
  const tried: { age: number; successProbability: number }[] = [];
  let found: number | null = null;
  for (let age = first; age <= last; age++) {
    const p = monteCarlo({ ...input, retirementAge: age }, params, portfolio, runs, seed, false).successProbability;
    tried.push({ age, successProbability: p });
    if (p >= target) {
      found = age;
      break;
    }
  }
  return {
    age: found,
    target,
    tried,
    runs,
    seed,
    assumptions: assumptionsFor({ ...input, retirementAge: found ?? last }, portfolio, [
      `Earliest age from ${first} to ${last} at which at least ${(target * 100).toFixed(0)}% of ${runs.toLocaleString("en-US")} random runs (seed ${seed}) met spending every year to age ${input.endAge}. Savings continue until the retirement age being tried.`,
    ]),
    notice: ESTIMATE_NOTICE,
  };
}
