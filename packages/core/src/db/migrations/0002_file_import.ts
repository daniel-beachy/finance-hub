/**
 * File import (M3): an `import` alert kind for files that can't be read, and
 * a source on investment transactions so file rows and Plaid rows can be
 * told apart. SQLite can't change a CHECK constraint, so alerts is rebuilt.
 */
export const fileImport = `
CREATE TABLE alerts_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'duplicate', 'large', 'new_merchant', 'fee', 'price_increase',
    'new_subscription', 'missed_recurring', 'connection', 'import')),
  transaction_id TEXT REFERENCES transactions(id),
  series_id TEXT REFERENCES recurring_series(id),
  connection_id TEXT REFERENCES connections(id),
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL,
  dismissed_at TEXT
);
INSERT INTO alerts_new SELECT * FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;
CREATE INDEX alerts_open ON alerts(dismissed_at) WHERE dismissed_at IS NULL;

ALTER TABLE investment_transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'plaid'
  CHECK (source IN ('plaid', 'file'));
ALTER TABLE investment_transactions ADD COLUMN import_file_id TEXT REFERENCES import_files(id);
`;
