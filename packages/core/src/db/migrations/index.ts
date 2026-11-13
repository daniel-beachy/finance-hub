import { init } from "./0001_init.ts";
import { fileImport } from "./0002_file_import.ts";

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Migrations are TypeScript modules holding SQL text, not .sql files, so the
 * same list loads in Node, in the browser demo and on a Worker with no
 * filesystem. Never edit a migration that has shipped; add a new one.
 */
export const migrations: Migration[] = [
  { id: 1, name: "0001_init", sql: init },
  { id: 2, name: "0002_file_import", sql: fileImport },
];
