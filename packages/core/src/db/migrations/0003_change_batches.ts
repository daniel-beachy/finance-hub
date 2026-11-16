/**
 * One user action can change many rows (a bulk recategorization, a rule and
 * the merchant default it sets). `batch_id` ties those entries together so
 * `undo` can reverse the whole action at once.
 */
export const changeBatches = `
ALTER TABLE changes ADD COLUMN batch_id TEXT;
CREATE INDEX changes_batch ON changes(batch_id);
`;
