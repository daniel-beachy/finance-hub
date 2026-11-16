import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Runs `run_sql` queries off the main thread, so a runaway query can be
 * stopped by terminating the worker. The connection is read-only and
 * `query_only`, a second and third lock behind the SELECT check in core.
 */
const db = new DatabaseSync(workerData.path as string, { readOnly: true });
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");

parentPort!.on("message", (msg: { id: number; sql: string; maxRows: number }) => {
  try {
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    for (const row of db.prepare(msg.sql).iterate()) {
      if (rows.length === msg.maxRows) {
        truncated = true;
        break;
      }
      rows.push(row as Record<string, unknown>);
    }
    parentPort!.postMessage({ id: msg.id, rows, truncated });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
