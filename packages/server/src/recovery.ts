import { chmodSync, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CoreDeps,
  createIdFactory,
  createMemoryArchive,
  migrate,
  type ReplaySummary,
  replayConnection,
  type SqlDriver,
} from "@finance-hub/core";
import { readArchive } from "./archive.ts";
import { checkDatabase } from "./backup.ts";
import { openNodeDatabase } from "./nodeDriver.ts";
import type { DataPaths } from "./paths.ts";

export interface RestoreResult {
  restoredFrom: string;
  keptAs: string | null;
}

/**
 * Replace the live database with a backup. The file is checked first; the
 * database it replaces is kept as `finance.db.before-restore` (an older one
 * of those is kept too, with a timestamp), so a restore can be undone.
 * The caller confirms with the user and makes sure nothing else has the
 * database open.
 */
export async function restoreDatabase(paths: DataPaths, file: string, now: Date): Promise<RestoreResult> {
  const from = resolve(file);
  if (!existsSync(from)) throw new Error(`No file at ${from}`);
  if (from === resolve(paths.db)) throw new Error("That is the live database");
  await checkDatabase(from);
  const probe = openNodeDatabase(from, { readOnly: true });
  try {
    const tables = await probe.driver.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connections'");
    if (tables.length === 0) throw new Error(`${from} is not a Finance Hub database`);
  } finally {
    probe.close();
  }

  let keptAs: string | null = null;
  if (existsSync(paths.db)) {
    // Fold the write-ahead log into the main file so the kept copy is complete.
    const live = openNodeDatabase(paths.db);
    try {
      await live.driver.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      live.close();
    }
    keptAs = `${paths.db}.before-restore`;
    if (existsSync(keptAs)) await moveDatabase(keptAs, `${keptAs}.${now.toISOString().replace(/[:.]/g, "-")}`);
    await moveDatabase(paths.db, keptAs);
  }
  for (const suffix of SIDE_FILES) await rm(`${paths.db}${suffix}`, { force: true });
  await copyFile(from, paths.db);
  chmodSync(paths.db, 0o600);
  // A backup from before a schema change is brought up to date.
  const db = openNodeDatabase(paths.db);
  try {
    await migrate(db.driver);
  } finally {
    db.close();
  }
  return { restoredFrom: from, keptAs };
}

const SIDE_FILES = ["-wal", "-shm"];

/**
 * Move a database with its write-ahead log and shared-memory files, so a
 * stale log can never end up paired with a different database file.
 */
async function moveDatabase(from: string, to: string): Promise<void> {
  for (const suffix of SIDE_FILES) await rm(`${to}${suffix}`, { force: true });
  await rename(from, to);
  for (const suffix of SIDE_FILES) {
    if (existsSync(`${from}${suffix}`)) await rename(`${from}${suffix}`, `${to}${suffix}`);
  }
}

export interface AccountComparison {
  plaidAccountId: string;
  name: string;
  live: { count: number; sum: number };
  replay: { count: number; sum: number };
  matches: boolean;
}

export interface ReplayReport {
  out: string;
  connections: ReplaySummary[];
  accounts: AccountComparison[];
}

/** Connection ids that have a raw archive folder. */
export async function archivedConnections(paths: DataPaths): Promise<string[]> {
  try {
    return (await readdir(join(paths.raw, "plaid"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Rebuild everything Plaid ever sent into a new database file, from the raw
 * archive alone, and compare it with the live database account by account.
 * Never touches the live database, the network or the Keychain.
 */
export async function replayToFile(paths: DataPaths, live: SqlDriver, out: string): Promise<ReplayReport> {
  const target = resolve(out);
  if (existsSync(target)) throw new Error(`${target} already exists`);
  await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
  const db = openNodeDatabase(target);
  try {
    await migrate(db.driver);
    const deps: CoreDeps = {
      db: db.driver,
      secrets: {
        get: async () => null,
        set: async () => {
          throw new Error("replay never stores secrets");
        },
        delete: async () => {},
      },
      archive: createMemoryArchive(),
      now: () => new Date(),
      newId: createIdFactory(),
      fetch: async () => {
        throw new Error("replay never calls Plaid");
      },
    };
    const meta = new Map(
      (
        await live.all<{ id: string; institution_name: string; created_at: string }>(
          "SELECT id, institution_name, created_at FROM connections WHERE source = 'plaid'",
        )
      ).map((c) => [c.id, c]),
    );
    const connections: ReplaySummary[] = [];
    for (const id of await archivedConnections(paths)) {
      const entries = await readArchive(paths.raw, id);
      const m = meta.get(id);
      connections.push(
        await replayConnection(deps, id, entries, { institutionName: m?.institution_name, createdAt: m?.created_at }),
      );
    }
    const accounts = await compareAccounts(live, db.driver);
    return { out: target, connections, accounts };
  } finally {
    db.close();
  }
}

/** Plaid-fed transactions per account: count and sum, live against replay. */
export async function compareAccounts(live: SqlDriver, replay: SqlDriver): Promise<AccountComparison[]> {
  const sql = `SELECT a.plaid_account_id AS id, a.name,
      COUNT(t.id) AS count, COALESCE(SUM(t.amount_cents), 0) AS sum
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id AND t.source = 'plaid' AND t.removed_at IS NULL
    WHERE a.plaid_account_id IS NOT NULL
    GROUP BY a.id ORDER BY a.name`;
  type Row = { id: string; name: string; count: number; sum: number };
  const after = new Map((await replay.all<Row>(sql)).map((r) => [r.id, r]));
  const rows = await live.all<Row>(sql);
  const seen = new Set(rows.map((r) => r.id));
  const out: AccountComparison[] = rows.map((r) => {
    const x = after.get(r.id) ?? { count: 0, sum: 0 };
    return {
      plaidAccountId: r.id,
      name: r.name,
      live: { count: r.count, sum: r.sum },
      replay: { count: x.count, sum: x.sum },
      matches: r.count === x.count && r.sum === x.sum,
    };
  });
  for (const [id, x] of after) {
    if (!seen.has(id)) {
      out.push({ plaidAccountId: id, name: x.name, live: { count: 0, sum: 0 }, replay: { count: x.count, sum: x.sum }, matches: false });
    }
  }
  return out;
}
