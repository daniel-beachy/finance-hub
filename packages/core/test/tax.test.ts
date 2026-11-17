import { describe, expect, it } from "vitest";
import { esppDisposition } from "../src/tax/espp.ts";
import {
  computeFederalTax,
  type FederalTaxInput,
  incomeTax,
  ordinaryTaxCents,
  saltCapCents,
  supplementalWithholdingCents,
} from "../src/tax/federal.ts";
import { type TaxParams, taxParams } from "../src/tax/params.ts";
import { noIncomeTaxState } from "../src/tax/state.ts";
import raw2026 from "../src/tax/params/2026.json" with { type: "json" };

/** Dollars to cents, so the hand-worked figures below read as on the forms. */
const $ = (n: number) => Math.round(n * 100);
const all = (n: number) => ({ toDateCents: $(n), restOfYearCents: 0 });
const p = taxParams(2026);

describe("2026 parameters", () => {
  it("names an official source beside every group of numbers", () => {
    const official = /^https:\/\/(www\.irs\.gov|www\.govinfo\.gov|www\.ssa\.gov)\//;
    for (const [key, value] of Object.entries(raw2026)) {
      if (typeof value !== "object" || Array.isArray(value)) continue;
      expect((value as { source?: string }).source, key).toMatch(official);
      expect((value as { cite?: string }).cite, key).toBeTruthy();
    }
  });

  it("has brackets whose running totals match the Rev. Proc. tables", () => {
    // Rev. Proc. 2025-32 states the tax at each bracket start; these are those figures.
    expect(ordinaryTaxCents(p, "mfj", $(768_700))).toBe($(206_583.5));
    expect(ordinaryTaxCents(p, "mfj", $(403_550))).toBe($(82_048));
    expect(ordinaryTaxCents(p, "single", $(640_600))).toBe($(192_979.25));
    expect(ordinaryTaxCents(p, "hoh", $(640_600))).toBe($(191_171));
    expect(ordinaryTaxCents(p, "mfs", $(384_350))).toBe($(103_291.75));
  });
});

describe("Tax Table method", () => {
  // The 2025 single brackets, to check the method against the published 2025
  // Tax Table (https://www.irs.gov/pub/irs-pdf/i1040tt.pdf). The 2026 table
  // was not out when this was written.
  const p2025 = {
    ...p,
    ordinaryBrackets: {
      ...p.ordinaryBrackets,
      single: [
        { rate: 0.1, from: 0 },
        { rate: 0.12, from: 11_925 },
        { rate: 0.22, from: 48_475 },
        { rate: 0.24, from: 103_350 },
        { rate: 0.32, from: 197_300 },
        { rate: 0.35, from: 250_525 },
        { rate: 0.37, from: 626_350 },
      ],
    },
  } as TaxParams;

  it.each([
    [20, 2],
    [2_990, 299],
    [3_010, 303],
    [25_300, 2_801],
    [25_349, 2_801],
    [60_000, 8_120],
    [99_999, 16_909],
  ])("single, taxable income $%i is $%i in the 2025 table", (income, tax) => {
    expect(ordinaryTaxCents(p2025, "single", $(income), "form1040")).toBe($(tax));
  });

  it("uses the Tax Computation Worksheet from $100,000", () => {
    // 2025 worksheet, section A: 100,000 x 22% - 5,086.00
    expect(ordinaryTaxCents(p2025, "single", $(100_000), "form1040")).toBe($(16_914));
  });
});

describe("federal tax, households worked by hand from the worksheets", () => {
  it("A: single, wages and interest, Tax Table", () => {
    // Wages 78,400 less 6,000 pre-tax 401(k) = 72,400. Interest 350. AGI 72,750.
    // Standard deduction 16,100. Taxable income 56,650.
    // Tax Table band 56,650 to 56,700, midpoint 56,675:
    //   5,800 + 22% x (56,675 - 50,400) = 5,800 + 1,380.50 = 7,180.50, which rounds to 7,181.
    const r = computeFederalTax({
      year: 2026,
      filingStatus: "single",
      rounding: "form1040",
      earners: [
        {
          label: "A",
          regularPay: all(78_400),
          traditional401k: all(6_000),
          federalWithholdingToDateCents: $(6_000),
          restOfYearRegularWithholdingCents: $(1_500),
        },
      ],
      interestCents: $(350),
    });
    expect(r.income.agiCents).toBe($(72_750));
    expect(r.deduction.used).toBe("standard");
    expect(r.taxableIncomeCents).toBe($(56_650));
    expect(r.tax.incomeTaxCents).toBe($(7_181));
    expect(r.tax.totalCents).toBe($(7_181));
    // Social Security 6.2% and Medicare 1.45% of 78,400 (the 401(k) doesn't reduce them).
    expect(r.payroll.socialSecurityTaxCents).toBe($(4_860.8));
    expect(r.payroll.medicareTaxCents).toBe($(1_136.8));
    expect(r.withholding.totalCents).toBe($(7_500));
    expect(r.balanceDueCents).toBe($(-319));
    expect(r.rsu).toBeNull();
    expect(r.marginal).toEqual({ ordinaryRate: 0.22, capitalGainsRate: 0.15 });
    expect(r.room.earners[0]?.deferralLeftCents).toBe($(18_500));
    expect(r.notice).toMatch(/estimate/);
    expect(r.assumptions.length).toBeGreaterThan(5);
  });

  it("B: married, gains straddling the 0% and 15% rates", () => {
    // Wages 70,000 + 48,000 = 118,000. Interest 1,200. Dividends 3,000 (2,400 qualified).
    // Long-term gain 14,000, short-term loss 1,000: net 13,000, all of it net capital gain.
    // AGI 118,000 + 1,200 + 3,000 + 13,000 = 135,200.
    // Standard deduction 32,200 + 500 cash gifts (non-itemizer) = 32,700. Taxable income 102,500.
    // Qualified Dividends and Capital Gain Tax Worksheet:
    //   4: 2,400 + 13,000 = 15,400     5: 102,500 - 15,400 = 87,100
    //   6: 98,900   7: 98,900   8: 87,100   9: 11,800 (taxed at 0%)
    //   10: 15,400  12: 3,600   13: 613,700  14: 102,500  15: 98,900  16: 3,600  17: 3,600
    //   18: 540     20: 0       21: 0
    //   22: Tax Table on 87,100 (midpoint 87,125): 2,480 + 12% x 62,325 = 9,959
    //   23: 10,499
    //   24: Tax Computation Worksheet on 102,500: 11,600 + 22% x 1,700 = 11,974
    //   25: 10,499
    const r = computeFederalTax({
      year: 2026,
      filingStatus: "mfj",
      rounding: "form1040",
      earners: [
        { label: "one", regularPay: all(70_000), federalWithholdingToDateCents: $(5_000) },
        { label: "two", regularPay: all(48_000), federalWithholdingToDateCents: $(3_000) },
      ],
      interestCents: $(1_200),
      ordinaryDividendsCents: $(3_000),
      qualifiedDividendsCents: $(2_400),
      longTermGainsCents: $(14_000),
      shortTermGainsCents: $(-1_000),
      charitableCashCents: $(500),
      state: noIncomeTaxState("XX", "Example State"),
    });
    expect(r.income.agiCents).toBe($(135_200));
    expect(r.deduction.amountCents).toBe($(32_700));
    expect(r.taxableIncomeCents).toBe($(102_500));
    expect(r.tax.ordinaryPortionCents).toBe($(87_100));
    expect(r.tax.at0Cents).toBe($(11_800));
    expect(r.tax.at15Cents).toBe($(3_600));
    expect(r.tax.at20Cents).toBe(0);
    expect(r.tax.incomeTaxCents).toBe($(10_499));
    expect(r.tax.niitCents).toBe(0);
    expect(r.tax.additionalMedicareTaxCents).toBe(0);
    expect(r.payroll.socialSecurityTaxCents).toBe($(4_340 + 2_976));
    expect(r.payroll.medicareTaxCents).toBe($(1_015 + 696));
    expect(r.balanceDueCents).toBe($(2_499));
    expect(r.state.taxCents).toBe(0);
  });

  const householdC: FederalTaxInput = {
    year: 2026,
    filingStatus: "mfj",
    rounding: "form1040",
    hsaCoverage: "family",
    earners: [
      {
        label: "one",
        regularPay: all(210_000),
        bonus: all(30_000),
        rsuVests: { toDateCents: $(120_000), restOfYearCents: $(40_000) },
        traditional401k: all(24_500),
        hsaPayroll: all(7_750),
        hsaEmployer: all(1_000),
        otherPretax: all(3_250),
        federalWithholdingToDateCents: $(50_000),
        restOfYearRegularWithholdingCents: $(6_000),
      },
      {
        label: "two",
        regularPay: all(95_000),
        traditional401k: all(10_000),
        federalWithholdingToDateCents: $(9_000),
        restOfYearRegularWithholdingCents: $(1_500),
      },
    ],
    interestCents: $(4_000),
    ordinaryDividendsCents: $(6_000),
    qualifiedDividendsCents: $(5_000),
    longTermGainsCents: $(40_000),
    shortTermGainsCents: $(2_000),
    itemized: { stateAndLocalTaxesCents: $(30_000), mortgageInterestCents: $(18_000) },
    charitableCashCents: $(10_000),
  };

  it("C: married, RSUs, itemized, NIIT, Additional Medicare, Social Security cap", () => {
    // Earner one: gross 210,000 + 30,000 + 160,000 = 400,000. Cafeteria plan 7,750 + 3,250 = 11,000.
    //   Medicare wages 389,000. Box 1: 389,000 - 24,500 = 364,500.
    //   Social Security 6.2% x 184,500 = 11,439. Medicare 1.45% x 389,000 = 5,640.50.
    //   Additional Medicare withheld 0.9% x (389,000 - 200,000) = 1,701.
    // Earner two: Medicare wages 95,000, box 1 85,000. Social Security 5,890. Medicare 1,377.50.
    // Wages 449,500. AGI 449,500 + 4,000 + 6,000 + 42,000 = 501,500.
    // Schedule A: taxes 30,000 (under the 40,400 cap; AGI is under 505,000), interest 18,000,
    //   gifts 10,000 less 0.5% x 501,500 = 2,507.50, rounded 2,508: 7,492. Total 55,492.
    //   Standard would be 32,200 + 2,000 = 34,200. Taxable income 446,008.
    // Worksheet: 4: 5,000 + 40,000 = 45,000   5: 401,008   7: 98,900   8: 98,900   9: 0
    //   12: 45,000  14: 446,008  15: 401,008  16: 45,000  17: 45,000  18: 6,750  21: 0
    //   22: 35,932 + 24% x (401,008 - 211,400) = 35,932 + 45,505.92 = 81,437.92, rounded 81,438
    //   23: 88,188
    //   24: 82,048 + 32% x (446,008 - 403,550) = 82,048 + 13,586.56 = 95,634.56, rounded 95,635
    //   25: 88,188
    // Form 8960: investment income 4,000 + 6,000 + 42,000 = 52,000; AGI over 250,000 by 251,500;
    //   3.8% x 52,000 = 1,976.
    // Form 8959: Medicare wages 484,000 - 250,000 = 234,000; 0.9% = 2,106.
    // Total tax 88,188 + 1,976 + 2,106 = 92,270.
    // Payments: 50,000 + 6,000 + 22% x 40,000 (8,800) + 9,000 + 1,500 + 1,701 = 77,001.
    // Balance due 15,269.
    const r = computeFederalTax(householdC);
    expect(r.income.wagesCents).toBe($(449_500));
    expect(r.income.agiCents).toBe($(501_500));
    expect(r.deduction.used).toBe("itemized");
    expect(r.deduction.standardCents).toBe($(34_200));
    expect(r.deduction.itemizedDetail.charityAllowedCents).toBe($(7_492));
    expect(r.deduction.amountCents).toBe($(55_492));
    expect(r.taxableIncomeCents).toBe($(446_008));
    expect(r.tax.at15Cents).toBe($(45_000));
    expect(r.tax.incomeTaxCents).toBe($(88_188));
    expect(r.tax.niitCents).toBe($(1_976));
    expect(r.tax.additionalMedicareTaxCents).toBe($(2_106));
    expect(r.tax.totalCents).toBe($(92_270));
    expect(r.payroll.earners[0]?.socialSecurityTaxCents).toBe($(11_439));
    expect(r.payroll.earners[0]?.medicareTaxCents).toBe($(5_640.5));
    expect(r.payroll.earners[0]?.additionalMedicareWithheldCents).toBe($(1_701));
    expect(r.payroll.earners[1]?.socialSecurityTaxCents).toBe($(5_890));
    expect(r.withholding.projectedSupplementalCents).toBe($(8_800));
    expect(r.withholding.totalCents).toBe($(77_001));
    expect(r.balanceDueCents).toBe($(15_269));
    expect(r.marginal).toEqual({ ordinaryRate: 0.24, capitalGainsRate: 0.15 });
  });

  it("C: the RSU withholding gap", () => {
    // Without the 160,000 of vests: box 1 204,500 + 85,000 = 289,500. AGI 341,500.
    //   Gifts 10,000 - 0.5% x 341,500 (1,707.50, rounded 1,708) = 8,292. Itemized 56,292.
    //   Taxable income 285,208, ordinary part 240,208.
    //   22: 35,932 + 24% x 28,808 = 42,845.92, rounded 42,846.  18: 6,750.  23: 49,596.
    //   24: 35,932 + 24% x 73,808 = 53,645.92.  Tax 49,596.
    //   NIIT 1,976. Additional Medicare 0.9% x (324,000 - 250,000) = 666. Total 52,238.
    // Tax caused by the vests: 92,270 - 52,238 = 40,032.
    // Withheld from them: 22% x 160,000 = 35,200, plus Additional Medicare 1,701 - 0.9% x 29,000 (261) = 1,440.
    // Gap: 40,032 - 36,640 = 3,392.
    const r = computeFederalTax(householdC);
    expect(r.rsu).toEqual({
      incomeCents: $(160_000),
      taxCausedCents: $(40_032),
      withheldCents: $(36_640),
      gapCents: $(3_392),
      effectiveRate: 40_032 / 160_000,
      withholdingRate: 0.22,
    });
  });

  it("C: 401(k) and HSA room", () => {
    const r = computeFederalTax(householdC);
    expect(r.room.earners[0]).toMatchObject({
      deferralLimitCents: $(24_500),
      deferralLeftCents: 0,
      totalLimitCents: $(72_000),
      totalPlannedCents: $(24_500),
      totalLeftCents: $(47_500),
    });
    expect(r.room.earners[1]?.deferralLeftCents).toBe($(14_500));
    expect(r.room.hsa).toEqual({ limitCents: $(8_750), plannedCents: $(8_750), leftCents: 0 });
  });

  it("cents rounding lands within a few dollars of the form result", () => {
    const exact = computeFederalTax({ ...householdC, rounding: "cents" });
    // The gift floor is 2,507.50 not 2,508, so taxable income is 446,007.50 and the ordinary
    // part 401,007.50: 35,932 + 24% x 189,607.50 = 81,437.80. Plus 6,750 on the gains.
    expect(exact.tax.incomeTaxCents).toBe($(88_187.8));
    expect(exact.tax.totalCents).toBe($(92_269.8));
  });
});

describe("income tax pieces", () => {
  it("taxes gains above the 15% ceiling at 20%", () => {
    // Married, taxable income 700,000 with 150,000 of long-term gain.
    // Ordinary 550,000: 116,896 + 35% x 37,550 = 130,038.50.
    // 15% on 613,700 - 550,000 = 63,700: 9,555. 20% on the other 86,300: 17,260.
    const t = incomeTax(p, "mfj", $(700_000), $(150_000));
    expect(t.at0Cents).toBe(0);
    expect(t.at15Cents).toBe($(63_700));
    expect(t.at20Cents).toBe($(86_300));
    expect(t.taxCents).toBe($(130_038.5 + 9_555 + 17_260));
  });

  it("taxes nothing when gains fit under the 0% ceiling", () => {
    const t = incomeTax(p, "single", $(40_000), $(40_000));
    expect(t.at0Cents).toBe($(40_000));
    expect(t.taxCents).toBe(0);
  });

  it("limits a net capital loss to 3,000 and carries the rest", () => {
    const r = computeFederalTax({
      year: 2026,
      filingStatus: "single",
      earners: [{ label: "A", regularPay: all(90_000), federalWithholdingToDateCents: 0 }],
      shortTermGainsCents: $(-12_000),
      longTermGainsCents: $(4_000),
      qualifiedDividendsCents: 0,
    });
    expect(r.income.capitalGainInAgiCents).toBe($(-3_000));
    expect(r.income.capitalLossCarryforwardCents).toBe($(5_000));
    expect(r.income.agiCents).toBe($(87_000));
    expect(r.tax.preferentialCents).toBe(0);
  });

  it("phases the state and local tax cap down to its floor", () => {
    expect(saltCapCents(p, "mfj", $(505_000))).toBe($(40_400));
    // 40,400 - 30% x (555,000 - 505,000) = 25,400
    expect(saltCapCents(p, "mfj", $(555_000))).toBe($(25_400));
    expect(saltCapCents(p, "mfj", $(700_000))).toBe($(10_000));
    expect(saltCapCents(p, "mfs", $(100_000))).toBe($(20_200));
  });

  it("cuts itemized deductions by 2/37 of the part of income in the top bracket", () => {
    // Married, wages 900,000. Itemized: taxes capped at the 10,000 floor, mortgage 30,000: 40,000.
    // Income before deductions is 131,300 over 768,700, so the cut is 2/37 x 40,000 = 2,162.16.
    const r = computeFederalTax({
      year: 2026,
      filingStatus: "mfj",
      deduction: "itemized",
      earners: [{ label: "A", regularPay: all(900_000), federalWithholdingToDateCents: 0 }],
      itemized: { stateAndLocalTaxesCents: $(60_000), mortgageInterestCents: $(30_000) },
    });
    expect(r.deduction.itemizedDetail.saltAllowedCents).toBe($(10_000));
    expect(r.deduction.itemizedDetail.highIncomeReductionCents).toBe($(2_162.16));
    expect(r.deduction.amountCents).toBe($(37_837.84));
  });

  it("withholds 37% on supplemental pay past a million", () => {
    expect(supplementalWithholdingCents(p, $(100_000))).toBe($(22_000));
    expect(supplementalWithholdingCents(p, $(1_200_000))).toBe($(220_000 + 74_000));
    expect(supplementalWithholdingCents(p, $(100_000), 0.3)).toBe($(30_000));
  });

  it("gives catch-up room by age", () => {
    const at = (age: number) =>
      computeFederalTax({
        year: 2026,
        filingStatus: "single",
        earners: [{ label: "A", age, regularPay: all(100_000), roth401k: all(30_000), federalWithholdingToDateCents: 0 }],
      }).room.earners[0];
    expect(at(49)?.deferralLimitCents).toBe($(24_500));
    expect(at(50)?.deferralLimitCents).toBe($(32_500));
    expect(at(61)?.deferralLimitCents).toBe($(35_750));
    expect(at(64)?.deferralLimitCents).toBe($(32_500));
    // Catch-up dollars don't count against the overall plan limit.
    expect(at(50)?.totalPlannedCents).toBe($(24_500));
  });

  it("refuses a year it has no parameters for", () => {
    expect(() => computeFederalTax({ year: 2031, filingStatus: "single", earners: [] })).toThrow(/2031/);
  });
});

describe("ESPP dispositions", () => {
  const lot = {
    shares: 100,
    offeringDate: "2023-10-01",
    purchaseDate: "2024-03-31",
    fmvAtOfferingCents: $(50),
    fmvAtPurchaseCents: $(60),
    purchasePriceCents: $(42.5),
    discountRate: 0.15,
  };

  it("qualifying: ordinary income is the offering-date discount, the rest long-term", () => {
    // Paid 4,250, sold for 7,000. Lesser of the gain (2,750) and 15% x 50 x 100 (750).
    expect(esppDisposition({ ...lot, saleDate: "2026-05-01", salePriceCents: $(70) })).toMatchObject({
      qualifying: true,
      ordinaryIncomeCents: $(750),
      basisCents: $(5_000),
      capitalGainCents: $(2_000),
      longTerm: true,
    });
  });

  it("qualifying at a loss: no ordinary income", () => {
    expect(esppDisposition({ ...lot, saleDate: "2026-05-01", salePriceCents: $(40) })).toMatchObject({
      qualifying: true,
      ordinaryIncomeCents: 0,
      capitalGainCents: $(-250),
    });
  });

  it("disqualifying: ordinary income is the purchase-date spread", () => {
    // (60 - 42.50) x 100 = 1,750. Basis 6,000. Sold for 7,000: short-term gain 1,000.
    expect(esppDisposition({ ...lot, saleDate: "2024-06-15", salePriceCents: $(70) })).toMatchObject({
      qualifying: false,
      ordinaryIncomeCents: $(1_750),
      basisCents: $(6_000),
      capitalGainCents: $(1_000),
      longTerm: false,
    });
  });

  it("disqualifying at a loss: the spread is still income", () => {
    expect(esppDisposition({ ...lot, saleDate: "2024-06-15", salePriceCents: $(40) })).toMatchObject({
      ordinaryIncomeCents: $(1_750),
      capitalGainCents: $(-2_000),
    });
  });

  it("a sale on the first anniversary of purchase is still short-term", () => {
    expect(esppDisposition({ ...lot, saleDate: "2025-03-31", salePriceCents: $(70) }).longTerm).toBe(false);
    const dayAfter = esppDisposition({ ...lot, saleDate: "2025-04-01", salePriceCents: $(70) });
    expect(dayAfter.longTerm).toBe(true);
    // Over a year from purchase but not two from the offering: disqualifying, long-term.
    expect(dayAfter.qualifying).toBe(false);
    expect(esppDisposition({ ...lot, saleDate: "2025-10-01", salePriceCents: $(70) }).qualifying).toBe(false);
    expect(esppDisposition({ ...lot, saleDate: "2025-10-02", salePriceCents: $(70) }).qualifying).toBe(true);
  });

  it("flows into the return as wages and gains, with no payroll tax", () => {
    // Wages 100,000 + 1,750 ESPP income. Short-term gain 1,000.
    const r = computeFederalTax({
      year: 2026,
      filingStatus: "single",
      earners: [{ label: "A", regularPay: all(100_000), federalWithholdingToDateCents: 0 }],
      esppDispositions: [{ ...lot, saleDate: "2024-06-15", salePriceCents: $(70) }],
    });
    expect(r.income.wagesCents).toBe($(101_750));
    expect(r.income.netShortTermCents).toBe($(1_000));
    expect(r.income.agiCents).toBe($(102_750));
    expect(r.payroll.earners[0]?.medicareWagesCents).toBe($(100_000));
  });
});
