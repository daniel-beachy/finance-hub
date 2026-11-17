import { describe, expect, it } from "vitest";
import {
  earliestRetirementAge,
  portfolioOf,
  projectRetirement,
  type RetirementInput,
  retirementYearTaxCents,
  simulateRetirement,
} from "../src/projections/retirement.ts";
import { taxParams } from "../src/tax/params.ts";

const $ = (n: number) => Math.round(n * 100);
const none = { taxableCents: 0, traditionalCents: 0, rothCents: 0, hsaCents: 0 };

/** A portfolio that earns exactly `r` every year. */
const flat = (r: number) => [{ name: "Fixed", weight: 1, realReturn: r, volatility: 0 }];

const base: RetirementInput = {
  currentAge: 65,
  retirementAge: 65,
  endAge: 68,
  filingStatus: "single",
  taxYear: 2026,
  balances: none,
  annualSavings: none,
  retirementSpendingCents: 0,
  assetClasses: flat(0),
  inflation: 0,
};

describe("retirement, deterministic projection worked by hand", () => {
  it("grows the balance, then adds the year's savings", () => {
    // 100,000 at 5% with 10,000 saved at each year end:
    //   115,000, then 130,750, then 147,287.50.
    const p = projectRetirement({
      ...base,
      currentAge: 30,
      retirementAge: 33,
      endAge: 34,
      balances: { ...none, taxableCents: $(100_000) },
      annualSavings: { ...none, taxableCents: $(10_000) },
      assetClasses: flat(0.05),
    });
    expect(p.rows.map((r) => r.endTotalCents).slice(0, 3)).toEqual([$(115_000), $(130_750), $(147_287.5)]);
    expect(p.balanceAtRetirementCents).toBe($(147_287.5));
    expect(p.rows[0]).toMatchObject({ age: 30, phase: "saving", contributionsCents: $(10_000), taxCents: 0 });
    expect(p.rows[3]?.phase).toBe("retired");
    expect(p.notice).toMatch(/estimate/);
    expect(p.assumptions.join(" ")).toMatch(/today's dollars/);
  });

  it("grows savings when asked", () => {
    // Savings 10,000, 11,000, 12,100: 115,000, then 131,750, then 150,437.50.
    const p = projectRetirement({
      ...base,
      currentAge: 30,
      retirementAge: 33,
      endAge: 34,
      balances: { ...none, rothCents: $(100_000) },
      annualSavings: { ...none, rothCents: $(10_000) },
      savingsGrowth: 0.1,
      assetClasses: flat(0.05),
    });
    expect(p.balanceAtRetirementCents).toBe($(150_437.5));
  });

  it("takes Roth money tax-free at the start of each year", () => {
    // (500,000 - 40,000) x 1.04 = 478,400; (478,400 - 40,000) x 1.04 = 455,936; then 432,573.44.
    const p = projectRetirement({
      ...base,
      balances: { ...none, rothCents: $(500_000) },
      retirementSpendingCents: $(40_000),
      assetClasses: flat(0.04),
    });
    expect(p.rows.map((r) => r.endTotalCents)).toEqual([$(478_400), $(455_936), $(432_573.44)]);
    expect(p.rows.every((r) => r.taxCents === 0)).toBe(true);
    expect(p.endBalanceCents).toBe($(432_573.44));
    expect(p.depletedAtAge).toBeNull();
  });

  it("grosses up a traditional withdrawal for income tax", () => {
    // Single, spending 50,000. Withdrawal W, taxable income W - 16,100, in the 12% bracket:
    //   W - [1,240 + 12% x (W - 16,100 - 12,400)] = 50,000  =>  0.88 W = 47,820  =>  W = 54,340.91.
    //   Tax 4,340.91.
    const p = projectRetirement({
      ...base,
      balances: { ...none, traditionalCents: $(1_000_000) },
      retirementSpendingCents: $(50_000),
    });
    expect(p.rows[0]?.withdrawals.traditionalCents).toBe($(54_340.91));
    expect(p.rows[0]?.taxCents).toBe($(4_340.91));
    expect(p.rows[0]?.endTotalCents).toBe($(945_659.09));
  });

  it("adds the 10% early-distribution tax before age 60", () => {
    // Age 50: 0.9 W - [1,240 + 12% x (W - 28,500)] = 50,000  =>  0.78 W = 47,820  =>  W = 61,307.69.
    //   Income tax 5,176.92 + early tax 6,130.77 = 11,307.69.
    const early = { ...base, currentAge: 50, retirementAge: 50, endAge: 62, balances: { ...none, traditionalCents: $(1_000_000) }, retirementSpendingCents: $(50_000) };
    const p = projectRetirement(early);
    expect(p.rows[0]?.withdrawals.traditionalCents).toBe($(61_307.69));
    expect(p.rows[0]?.taxCents).toBe($(11_307.69));
    // Age 59 still pays it; age 60 does not.
    expect(p.rows[9]?.taxCents).toBe($(11_307.69));
    expect(p.rows[10]?.taxCents).toBe($(4_340.91));
  });

  it("taxes only the gain in a taxable withdrawal, at long-term rates", () => {
    // Married, account 2,000,000 that cost 1,000,000: half of any withdrawal is gain.
    // Spending 100,000: gain 50,000 less the 32,200 deduction is under the 98,900 zero-rate ceiling. No tax.
    const input = { ...base, filingStatus: "mfj" as const, balances: { ...none, taxableCents: $(2_000_000) }, taxableBasisCents: $(1_000_000) };
    const low = projectRetirement({ ...input, retirementSpendingCents: $(100_000) });
    expect(low.rows[0]?.withdrawals.taxableCents).toBe($(100_000));
    expect(low.rows[0]?.taxCents).toBe(0);
    // Spending 300,000: tax = 15% x (W/2 - 32,200 - 98,900), so W = 300,000 + 0.075 W - 19,665
    //   =>  W = 280,335 / 0.925 = 303,064.86. Tax 3,064.86.
    const high = projectRetirement({ ...input, retirementSpendingCents: $(300_000) });
    expect(high.rows[0]?.withdrawals.taxableCents).toBe($(303_064.86));
    expect(high.rows[0]?.taxCents).toBe($(3_064.86));
    // With no inflation the gain share stays at half, so year two is the same.
    expect(high.rows[1]?.taxCents).toBe($(3_064.86));
    // With inflation the cost basis shrinks in today's dollars, so more of each withdrawal is gain.
    const inflated = projectRetirement({ ...input, retirementSpendingCents: $(300_000), inflation: 0.025 });
    expect(inflated.rows[0]?.taxCents).toBe($(3_064.86));
    expect(inflated.rows[1]?.taxCents).toBeGreaterThan($(3_064.86));
  });

  it("counts Social Security toward spending and taxes 85% of it", () => {
    // Benefit 30,000, spending 50,000, single. Taxable benefit 25,500 - 16,100 = 9,400 at 10% = 940.
    // Roth withdrawal 50,000 + 940 - 30,000 = 20,940.
    const p = projectRetirement({
      ...base,
      currentAge: 66,
      retirementAge: 66,
      endAge: 69,
      balances: { ...none, rothCents: $(500_000) },
      retirementSpendingCents: $(50_000),
      socialSecurity: { annualBenefitCents: $(30_000), startAge: 67 },
    });
    expect(p.rows[0]).toMatchObject({ age: 66, socialSecurityCents: 0, taxCents: 0 });
    expect(p.rows[0]?.withdrawals.rothCents).toBe($(50_000));
    expect(p.rows[1]).toMatchObject({ age: 67, socialSecurityCents: $(30_000), taxCents: $(940) });
    expect(p.rows[1]?.withdrawals.rothCents).toBe($(20_940));
  });

  it("saves Social Security left over after spending and tax", () => {
    // Benefit 60,000, spending 40,000. Taxable 51,000 - 16,100 = 34,900: 1,240 + 12% x 22,500 = 3,940.
    // Left over: 60,000 - 3,940 - 40,000 = 16,060.
    const p = projectRetirement({
      ...base,
      currentAge: 67,
      retirementAge: 67,
      endAge: 68,
      retirementSpendingCents: $(40_000),
      socialSecurity: { annualBenefitCents: $(60_000), startAge: 67 },
    });
    expect(p.rows[0]?.taxCents).toBe($(3_940));
    expect(p.endBalanceCents).toBe($(16_060));
  });

  it("draws taxable, then traditional, then Roth, then HSA", () => {
    const p = projectRetirement({
      ...base,
      balances: { taxableCents: $(10_000), traditionalCents: 0, rothCents: $(15_000), hsaCents: $(100_000) },
      retirementSpendingCents: $(30_000),
    });
    expect(p.rows[0]?.withdrawals).toEqual({ taxableCents: $(10_000), traditionalCents: 0, rothCents: $(15_000), hsaCents: $(5_000) });
  });

  it("reports the age the money runs out", () => {
    // 100,000 with 40,000 a year: 60,000, 20,000, then 20,000 short at 67.
    const p = projectRetirement({ ...base, endAge: 70, balances: { ...none, rothCents: $(100_000) }, retirementSpendingCents: $(40_000) });
    expect(p.depletedAtAge).toBe(67);
    expect(p.rows[2]?.shortfallCents).toBe($(20_000));
    expect(p.endBalanceCents).toBe(0);
  });

  it("works the year's tax as a function", () => {
    const params = taxParams(2026);
    // Married, 100,000 traditional + 20,000 gain: taxable income 87,800, of which 67,800 ordinary.
    //   Ordinary: 2,480 + 12% x 43,000 = 7,640. Gain: all under 98,900, so 0%.
    expect(retirementYearTaxCents(params, "mfj", { age: 70, traditionalCents: $(100_000), realizedGainCents: $(20_000), socialSecurityCents: 0 })).toBe($(7_640));
    // A 400,000 gain alone: taxable 367,800; 15% x (367,800 - 98,900) = 40,335; NIIT 3.8% x 150,000 = 5,700.
    expect(retirementYearTaxCents(params, "mfj", { age: 70, traditionalCents: 0, realizedGainCents: $(400_000), socialSecurityCents: 0 })).toBe($(46_035));
  });

  it("rejects input that makes no sense", () => {
    expect(() => projectRetirement({ ...base, retirementAge: 60 })).toThrow(/before the current age/);
    expect(() => projectRetirement({ ...base, endAge: 65 })).toThrow(/end age/);
    expect(() => projectRetirement({ ...base, assetClasses: [{ name: "Half", weight: 0.5, realReturn: 0, volatility: 0 }] })).toThrow(/sum to 0.5/);
  });
});

describe("portfolio", () => {
  const classes = [
    { name: "Stocks", weight: 0.6, realReturn: 0.05, volatility: 0.17 },
    { name: "Bonds", weight: 0.4, realReturn: 0.015, volatility: 0.06 },
  ];

  it("combines asset classes", () => {
    // Mean 0.6 x 5% + 0.4 x 1.5% = 3.6%. Variance 0.102^2 + 0.024^2 = 0.010980.
    const p = portfolioOf({ assetClasses: classes });
    expect(p.meanRealReturn).toBeCloseTo(0.036, 10);
    expect(p.volatility).toBeCloseTo(Math.sqrt(0.01098), 10);
    expect(p.medianRealReturn).toBeLessThan(p.meanRealReturn);
    // With correlation 0.5: add 2 x 0.5 x 0.102 x 0.024 = 0.002448.
    expect(portfolioOf({ assetClasses: classes, correlation: 0.5 }).volatility).toBeCloseTo(Math.sqrt(0.013428), 10);
  });
});

describe("retirement, Monte Carlo", () => {
  const household: RetirementInput = {
    currentAge: 35,
    retirementAge: 60,
    endAge: 95,
    filingStatus: "mfj",
    taxYear: 2026,
    balances: { taxableCents: $(150_000), traditionalCents: $(200_000), rothCents: $(80_000), hsaCents: $(20_000) },
    taxableBasisCents: $(110_000),
    annualSavings: { taxableCents: $(15_000), traditionalCents: $(24_000), rothCents: $(7_000), hsaCents: $(4_000) },
    retirementSpendingCents: $(90_000),
    socialSecurity: { annualBenefitCents: $(40_000), startAge: 67 },
    assetClasses: [
      { name: "Stocks", weight: 0.8, realReturn: 0.05, volatility: 0.17 },
      { name: "Bonds", weight: 0.2, realReturn: 0.015, volatility: 0.06 },
    ],
    inflation: 0.025,
  };

  it("gives the same result for the same seed, and a different one for another", () => {
    const a = simulateRetirement(household, { seed: 7 });
    const b = simulateRetirement(household, { seed: 7 });
    const c = simulateRetirement(household, { seed: 8 });
    expect(a).toEqual(b);
    expect(a.runs).toBe(1000);
    expect(c.bands).not.toEqual(a.bands);
    expect(a.successProbability).toBeGreaterThan(0);
    expect(a.successProbability).toBeLessThanOrEqual(1);
    expect(a.notice).toMatch(/estimate/);
  });

  it("orders the percentile bands and covers every age", () => {
    const r = simulateRetirement(household);
    expect(r.bands.length).toBe(61);
    expect(r.bands[0]).toMatchObject({ age: 35, p10Cents: $(450_000), p90Cents: $(450_000) });
    for (const b of r.bands) {
      expect(b.p10Cents).toBeLessThanOrEqual(b.p25Cents);
      expect(b.p25Cents).toBeLessThanOrEqual(b.p50Cents);
      expect(b.p50Cents).toBeLessThanOrEqual(b.p75Cents);
      expect(b.p75Cents).toBeLessThanOrEqual(b.p90Cents);
    }
  });

  it("is less likely to succeed when spending more or retiring sooner", () => {
    const p = (change: Partial<RetirementInput>) => simulateRetirement({ ...household, ...change }).successProbability;
    expect(p({ retirementSpendingCents: $(140_000) })).toBeLessThan(p({}));
    expect(p({ retirementAge: 50 })).toBeLessThan(p({}));
  });

  it("matches the deterministic projection when returns don't vary", () => {
    const steady = { ...household, assetClasses: flat(0.04) };
    const mc = simulateRetirement(steady, { runs: 20 });
    const det = projectRetirement(steady);
    expect([0, 1]).toContain(mc.successProbability);
    expect(mc.successProbability === 1).toBe(det.depletedAtAge === null);
    expect(mc.bands[25]?.p50Cents).toBe(det.balanceAtRetirementCents);
    expect(mc.bands[25]?.p10Cents).toBe(mc.bands[25]?.p90Cents);
    expect(mc.bands.at(-1)?.p50Cents).toBe(det.endBalanceCents);
  });

  it("draws returns whose middle is the portfolio's median return", () => {
    // One year, nothing in or out: the balance after a year is 100,000 x (1 + return).
    const oneYear = { ...base, currentAge: 30, retirementAge: 31, endAge: 32, balances: { ...none, rothCents: $(100_000) }, assetClasses: [{ name: "Stocks", weight: 1, realReturn: 0.05, volatility: 0.17 }] };
    const r = simulateRetirement(oneYear, { runs: 4000, seed: 3 });
    const median = (r.bands[1]?.p50Cents ?? 0) / $(100_000) - 1;
    expect(median).toBeGreaterThan(r.portfolio.medianRealReturn - 0.01);
    expect(median).toBeLessThan(r.portfolio.medianRealReturn + 0.01);
    expect(r.bands[1]?.p10Cents).toBeLessThan($(90_000));
    expect(r.bands[1]?.p90Cents).toBeGreaterThan($(120_000));
  });
});

describe("earliest retirement age", () => {
  it("finds the age by hand when nothing varies", () => {
    // Saving 50,000 a year from 30 with no return, spending 50,000 a year to age 40:
    // retiring at R needs (R - 30) x 50,000 >= (40 - R) x 50,000, so R = 35.
    const r = earliestRetirementAge(
      { ...base, currentAge: 30, retirementAge: 30, endAge: 40, annualSavings: { ...none, rothCents: $(50_000) }, retirementSpendingCents: $(50_000) },
      { runs: 5 },
    );
    expect(r.age).toBe(35);
    expect(r.tried).toEqual([
      { age: 30, successProbability: 0 },
      { age: 31, successProbability: 0 },
      { age: 32, successProbability: 0 },
      { age: 33, successProbability: 0 },
      { age: 34, successProbability: 0 },
      { age: 35, successProbability: 1 },
    ]);
  });

  it("is the first age to pass the target, and repeats for the same seed", () => {
    const input: RetirementInput = {
      currentAge: 30,
      retirementAge: 30,
      endAge: 95,
      filingStatus: "mfj",
      taxYear: 2026,
      balances: { taxableCents: $(100_000), traditionalCents: $(150_000), rothCents: $(50_000), hsaCents: 0 },
      annualSavings: { taxableCents: $(30_000), traditionalCents: $(30_000), rothCents: $(14_000), hsaCents: $(8_000) },
      retirementSpendingCents: $(80_000),
      socialSecurity: { annualBenefitCents: $(40_000), startAge: 67 },
      assetClasses: [{ name: "Stocks", weight: 1, realReturn: 0.05, volatility: 0.17 }],
      inflation: 0.025,
    };
    const r = earliestRetirementAge(input, { seed: 11, runs: 300 });
    expect(r.age).not.toBeNull();
    const last = r.tried.at(-1);
    expect(last?.age).toBe(r.age);
    expect(last?.successProbability).toBeGreaterThanOrEqual(0.9);
    for (const t of r.tried.slice(0, -1)) expect(t.successProbability).toBeLessThan(0.9);
    // The answer agrees with a direct simulation at that age.
    expect(simulateRetirement({ ...input, retirementAge: r.age as number }, { seed: 11, runs: 300 }).successProbability).toBe(last?.successProbability);
    expect(earliestRetirementAge(input, { seed: 11, runs: 300 })).toEqual(r);
  });

  it("returns null when no age reaches the target", () => {
    const r = earliestRetirementAge({ ...base, currentAge: 60, retirementAge: 60, endAge: 95, retirementSpendingCents: $(50_000) }, { runs: 5, maxAge: 62 });
    expect(r.age).toBeNull();
    expect(r.tried.length).toBe(3);
  });
});
