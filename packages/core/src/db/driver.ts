export type SqlValue = string | number | null | Uint8Array;

/**
 * The only way core touches a database. Async because Cloudflare D1 is async;
 * the Node and WASM drivers wrap synchronous engines.
 */
export interface SqlDriver {
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Run one or more statements with no parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Run `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export async function first<T = Record<string, unknown>>(
  db: SqlDriver,
  sql: string,
  params?: SqlValue[],
): Promise<T | undefined> {
  const rows = await db.all<T>(sql, params);
  return rows[0];
}

/** Shared BEGIN/COMMIT handling for drivers built on a synchronous engine. */
export function createTransactionRunner(exec: (sql: string) => void) {
  let depth = 0;
  return async function transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (depth > 0) return fn();
    exec("BEGIN IMMEDIATE");
    depth++;
    try {
      const result = await fn();
      exec("COMMIT");
      return result;
    } catch (err) {
      exec("ROLLBACK");
      throw err;
    } finally {
      depth--;
    }
  };
}
