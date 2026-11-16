/**
 * Corrections to `plaid_category_map` after checking it against Plaid's
 * published taxonomy (PFCv1 and v2). New keys arrive through the seed
 * (INSERT OR IGNORE on every open); only changed and dropped rows need SQL.
 * Seeding runs after migrations, so on a fresh database these touch nothing.
 * The reasons are in packages/core/src/seed/plaidCategoryMap.ts.
 */
export const plaidCategoryMapFixes = `
UPDATE plaid_category_map SET category_id = 'financial.fees'
  WHERE pfc_key = 'GOVERNMENT_AND_NON_PROFIT' AND category_id = 'financial.taxes';
UPDATE plaid_category_map SET category_id = 'transfers.loan-principal'
  WHERE pfc_key = 'TRANSFER_IN_CASH_ADVANCES_AND_LOANS' AND category_id = 'transfers.internal';
DELETE FROM plaid_category_map
  WHERE pfc_key = 'TRANSFER_OUT_WITHDRAWAL' AND category_id = 'shopping.general';
`;
