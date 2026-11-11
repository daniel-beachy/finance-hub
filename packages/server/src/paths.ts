import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DataPaths {
  root: string;
  db: string;
  inbox: string;
  imported: string;
  backups: string;
  raw: string;
  logs: string;
}

/** Real data lives outside the repo and outside iCloud. See docs/PLAN.md. */
export function dataPaths(root = process.env.FH_DATA_DIR ?? defaultRoot()): DataPaths {
  return {
    root,
    db: join(root, "finance.db"),
    inbox: join(root, "inbox"),
    imported: join(root, "imported"),
    backups: join(root, "backups"),
    raw: join(root, "raw"),
    logs: join(root, "logs"),
  };
}

function defaultRoot(): string {
  return join(homedir(), "Library", "Application Support", "finance-hub");
}

export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.root, paths.inbox, paths.imported, paths.backups, paths.raw, paths.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
