/**
 * M6: what recurring detection, alerts and budgets need beyond the M0 tables.
 *
 * - `recurring_series` gains what the Recurring page shows (a label, first
 *   date, charge count, the price before the last increase) and whether the
 *   status or the subscription mark was set by a person, so detection never
 *   overrides it.
 * - `recurring_members` links each series to its charges, so a series keeps
 *   its id from one detection run to the next.
 * - `alerts.key` names what an alert is about (`duplicate:<transaction>`), so
 *   an alert is raised once, and a dismissed one never comes back.
 * - `budgets.since_month` is the month a budget was first set: rollover
 *   counts from there, not from the start of the data.
 */
export const recurringAlerts = `
ALTER TABLE recurring_series ADD COLUMN label TEXT;
ALTER TABLE recurring_series ADD COLUMN first_date TEXT;
ALTER TABLE recurring_series ADD COLUMN charge_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recurring_series ADD COLUMN previous_amount_cents INTEGER;
ALTER TABLE recurring_series ADD COLUMN price_changed_on TEXT;
ALTER TABLE recurring_series ADD COLUMN status_set_by TEXT CHECK (status_set_by IN ('user', 'claude'));
ALTER TABLE recurring_series ADD COLUMN subscription_set_by TEXT CHECK (subscription_set_by IN ('user', 'claude'));
ALTER TABLE recurring_series ADD COLUMN created_at TEXT;

CREATE TABLE recurring_members (
  series_id TEXT NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  PRIMARY KEY (series_id, transaction_id)
);
CREATE INDEX recurring_members_tx ON recurring_members(transaction_id);

ALTER TABLE alerts ADD COLUMN key TEXT;
CREATE UNIQUE INDEX alerts_key ON alerts(key);

ALTER TABLE budgets ADD COLUMN since_month TEXT;
`;
