import { describe, expect, it } from "vitest";
import type { FederalTaxInput } from "../src/tax/federal.ts";
import { whatIfBonus, whatIfChange401k, whatIfSellLot } from "../src/tax/whatif.ts";

const $ = (n: number) => Math.round(n * 100);

// Single, wages 150,000, standard deduction: taxable income 133,900, in the 24% bracket
// (105,700 to 201,775). Long-term gains sit above the 49,450 zero-rate ceiling: 15%.
const base: FederalTaxInput = {
  year: 2026,
  filingStatus: "single",
  earners: [
    {
      label: "A",
      regularPay: { toDateCents: $(130_000), restOfYearCents: $(20_000) },
      traditional401k: { toDateCents: $(0), restOfYearCents: $(0) },
      federalWithholdingToDateCents: $(22_000),
      restOfYearRegularWithholdingCents: $(3_000),
    },
  ],
};

describe("tax what-ifs", () => {
  it("a bonus: 24% income tax, payroll tax, 22% withheld", () => {
    // 10,000 more: income tax 2,400; Social Security 620 (still under 184,500) + Medicare 145.
    // Withheld 2,200, so 200 more is owed at filing.
    const w = whatIfBonus(base, { amountCents: $(10_000) });
    expect(w.change).toEqual({
      agiCents: $(10_000),
      federalTaxCents: $(2_400),
      payrollTaxCents: $(765),
      withholdingCents: $(2_200),
      balanceDueCents: $(200),
    });
    expect(w.taxRateOnChange).toBeCloseTo(0.3165, 10);
    expect(w.notice).toMatch(/estimate/);
    expect(w.assumptions[0]).toMatch(/supplemental/);
  });

  it("a bonus past the Social Security wage base and into Additional Medicare", () => {
    // Wages 150,000 + 60,000: Social Security only on the 34,500 up to 184,500 = 2,139.
    // Medicare 1.45% x 60,000 = 870. Additional Medicare 0.9% x 10,000 over 200,000 = 90, all withheld.
    // Income tax: 51,775 at 24% (to 201,775 of taxable income... 133,900 + 60,000 = 193,900, all 24%) = 14,400.
    const w = whatIfBonus(base, { amountCents: $(60_000) });
    expect(w.change.payrollTaxCents).toBe($(2_139 + 870));
    expect(w.change.federalTaxCents).toBe($(14_400 + 90));
    expect(w.change.withholdingCents).toBe($(13_200 + 90));
    expect(w.change.balanceDueCents).toBe($(1_200));
  });

  it("more pre-tax 401(k): income tax falls, payroll tax doesn't", () => {
    const w = whatIfChange401k(base, { traditionalRestOfYearCents: $(5_000) });
    expect(w.change.federalTaxCents).toBe($(-1_200));
    expect(w.change.payrollTaxCents).toBe(0);
    expect(w.change.balanceDueCents).toBe($(-1_200));
    expect(w.after.room.earners[0]?.deferralLeftCents).toBe($(19_500));
    expect(w.warnings).toEqual([]);
  });

  it("Roth 401(k) changes no tax, and going over the limit is flagged", () => {
    const w = whatIfChange401k(base, { rothRestOfYearCents: $(26_000) });
    expect(w.change.federalTaxCents).toBe(0);
    expect(w.taxRateOnChange).toBeNull();
    expect(w.warnings).toEqual(["Planned deferrals are $1500.00 over the 2026 limit."]);
  });

  it("selling a long-term lot at a gain: 15%", () => {
    const w = whatIfSellLot(base, { proceedsCents: $(30_000), basisCents: $(10_000), longTerm: true });
    expect(w.change.federalTaxCents).toBe($(3_000));
    expect(w.change.balanceDueCents).toBe($(3_000));
    expect(w.change.payrollTaxCents).toBe(0);
    expect(w.taxRateOnChange).toBeCloseTo(0.15, 10);
  });

  it("selling a short-term lot at a gain: the ordinary rate", () => {
    const w = whatIfSellLot(base, { proceedsCents: $(30_000), basisCents: $(10_000), longTerm: false });
    expect(w.change.federalTaxCents).toBe($(4_800));
  });

  it("a large gain reaches the 3.8% investment tax", () => {
    // Gain 100,000: AGI 250,000, 50,000 over 200,000. 15% x 100,000 + 3.8% x 50,000 = 16,900.
    const w = whatIfSellLot(base, { proceedsCents: $(150_000), basisCents: $(50_000), longTerm: true });
    expect(w.change.federalTaxCents).toBe($(16_900));
  });

  it("selling at a loss: 3,000 offsets income and the rest carries forward", () => {
    // 3,000 at 24% = 720 saved; 17,000 carried.
    const w = whatIfSellLot(base, { proceedsCents: $(10_000), basisCents: $(30_000), longTerm: true });
    expect(w.change.federalTaxCents).toBe($(-720));
    expect(w.warnings).toEqual(["$17000.00 of the loss can't be used this year and carries forward."]);
  });

  it("names a missing earner", () => {
    expect(() => whatIfBonus(base, { earner: 2, amountCents: 1 })).toThrow(/no earner number 3/);
  });
});
