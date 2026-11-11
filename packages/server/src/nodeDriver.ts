import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTransactionRunner, type SqlDriver, type SqlValue } from "@finance-hub/core";

export interface NodeDatabase {
  driver: SqlDriver;
  close(): void;
}

/** SqlDriver over Node's built-in SQLite. */
export function openNodeDatabase(path: string, options: { readOnly?: boolean } = {}): NodeDatabase {
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (!options.readOnly && path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  const driver: SqlDriver = {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlValue[] = []) {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    async exec(sql: string) {
      db.exec(sql);
    },
    transaction: createTransactionRunner((sql) => db.exec(sql)),
  };
  return { driver, close: () => db.close() };
}
