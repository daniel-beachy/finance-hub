/**
 * One row per automatic categorizing run (the weekly Sonnet run, PLAN
 * section 12). The counts are what the deferred decision on automatic
 * categorizing needs: how much arrives, how much Claude settles, what's left.
 */
export const reviewRuns = `
CREATE TABLE review_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  queue_before INTEGER,
  queue_after INTEGER NOT NULL,
  categorized INTEGER NOT NULL,
  reviewed INTEGER NOT NULL,
  flagged INTEGER NOT NULL,
  rules_created INTEGER NOT NULL,
  batch_ids TEXT NOT NULL,
  summary TEXT
);
CREATE INDEX review_runs_started ON review_runs(started_at);
`;
