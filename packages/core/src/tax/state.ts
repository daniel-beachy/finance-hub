import type { FilingStatus } from "./params.ts";

/** What a state calculation is given: the federal figures, already worked out. */
export interface StateTaxContext {
  year: number;
  filingStatus: FilingStatus;
  federalAgiCents: number;
  wagesCents: number;
  federalTaxableIncomeCents: number;
  netCapitalGainCents: number;
}

export interface StateTaxResult {
  code: string;
  name: string;
  taxCents: number;
  notes: string[];
}

/**
 * A state's income tax. One implementation per state, added only when the
 * state is known and its numbers have been looked up from its revenue
 * department. The federal engine never guesses a state.
 */
export interface StateTax {
  code: string;
  name: string;
  compute(ctx: StateTaxContext): StateTaxResult;
}

/** A state with no tax on wages or investment income. */
export function noIncomeTaxState(code: string, name: string): StateTax {
  return {
    code,
    name,
    compute: () => ({ code, name, taxCents: 0, notes: [`${name} is modeled as having no state income tax.`] }),
  };
}

/** Used when no state is given: zero tax and a note saying state tax is left out. */
export const STATE_TAX_NOT_MODELED: StateTax = {
  code: "none",
  name: "No state",
  compute: () => ({
    code: "none",
    name: "No state",
    taxCents: 0,
    notes: ["State income tax is not included: no state was given."],
  }),
};
