import type { Database } from "sql.js";
import { createTransactionRunner, type SqlDriver, type SqlValue } from "./driver.ts";

/**
 * Driver over a sql.js database. The caller initializes sql.js, because
 * locating the .wasm file differs between Node and the browser.
 */
export function createWasmDriver(db: Database): SqlDriver {
  db.run("PRAGMA foreign_keys = ON");
  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
    async run(sql: string, params: SqlValue[] = []) {
      db.run(sql, params);
      return { changes: db.getRowsModified() };
    },
    async exec(sql: string) {
      db.exec(sql);
    },
    transaction: createTransactionRunner((sql) => db.run(sql === "BEGIN IMMEDIATE" ? "BEGIN" : sql)),
  };
}
