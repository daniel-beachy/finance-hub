import { chmodSync, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type CoreDeps, getSetting, localDate } from "@finance-hub/core";
import { openNodeDatabase } from "./nodeDriver.ts";
import type { DataPaths } from "./paths.ts";

/** Local dated copies kept in `<data>/backups/`. */
export const LOCAL_KEEP = 14;
/** iCloud keeps one copy per day for this many days, then the first copy of each month forever. */
export const ICLOUD_DAILY_DAYS = 30;

export const ICLOUD_DRIVE = join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
export const DEFAULT_BACKUP_DIR = join(ICLOUD_DRIVE, "Backups", "finance-hub");

const DB_NAME = /^finance-(\d{4}-\d{2}-\d{2})\.db$/;

export interface BackupResult {
  local: string;
  icloud: { dir: string; db: string; rawCopied: number; importedCopied: number } | null;
  icloudError: string | null;
}

/**
 * The backup step that follows every full sync, and `fh backup`:
 * 1. `VACUUM INTO` a dated copy in `<data>/backups/`, checked before it
 *    replaces anything, keeping the newest 14.
 * 2. Copy that file, and any new raw-archive and imported files, to the iCloud
 *    backup folder. Only closed, finished files go to iCloud, never the live
 *    database. A failure here raises an alert but never fails the sync.
 */
export async function runBackup(deps: CoreDeps, paths: DataPaths, opts: { backupDir?: string } = {}): Promise<BackupResult> {
  const day = localDate(deps.now());
  const name = `finance-${day}.db`;
  const local = join(paths.backups, name);
  await mkdir(paths.backups, { recursive: true, mode: 0o700 });
  const tmp = join(paths.backups, `.${name}.tmp`);
  await rm(tmp, { force: true });
  await deps.db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
  await checkDatabase(tmp);
  chmodSync(tmp, 0o600);
  await rename(tmp, local);
  await pruneLocal(paths.backups, LOCAL_KEEP);

  const dir = opts.backupDir ?? (await getSetting<string>(deps.db, "backup_dir", DEFAULT_BACKUP_DIR));
  const result: BackupResult = { local, icloud: null, icloudError: null };
  try {
    if (dir === DEFAULT_BACKUP_DIR && !existsSync(ICLOUD_DRIVE)) throw new Error("iCloud Drive isn't set up on this Mac");
    await mkdir(dir, { recursive: true });
    const db = join(dir, name);
    await copyChecked(local, db);
    await pruneIcloud(dir, day, ICLOUD_DAILY_DAYS);
    const rawCopied = await mirror(paths.raw, join(dir, "raw"));
    const importedCopied = await mirror(paths.imported, join(dir, "imported"));
    result.icloud = { dir, db, rawCopied, importedCopied };
    await deps.db.run(
      "UPDATE alerts SET dismissed_at = ? WHERE kind = 'connection' AND data = '\"backup\"' AND dismissed_at IS NULL",
      [deps.now().toISOString()],
    );
  } catch (err) {
    result.icloudError = err instanceof Error ? err.message : String(err);
    const open = await deps.db.all(
      "SELECT id FROM alerts WHERE kind = 'connection' AND data = '\"backup\"' AND dismissed_at IS NULL",
    );
    if (open.length === 0) {
      await deps.db.run(
        "INSERT INTO alerts (id, kind, message, data, created_at) VALUES (?, 'connection', ?, '\"backup\"', ?)",
        [deps.newId(), `The backup copy to iCloud Drive failed: ${result.icloudError}`, deps.now().toISOString()],
      );
    }
  }
  return result;
}

/** Throw unless the file is a healthy SQLite database. */
export async function checkDatabase(file: string): Promise<void> {
  const db = openNodeDatabase(file, { readOnly: true });
  try {
    const rows = await db.driver.all<{ integrity_check: string }>("PRAGMA integrity_check");
    const result = rows.map((r) => r.integrity_check).join("; ");
    if (result !== "ok") throw new Error(`${file} failed its integrity check: ${result}`);
  } finally {
    db.close();
  }
}

/** Keep the newest `keep` dated copies. Names sort by date. */
export async function pruneLocal(dir: string, keep: number): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => DB_NAME.test(n)).sort();
  const drop = names.slice(0, Math.max(0, names.length - keep));
  for (const n of drop) await rm(join(dir, n), { force: true });
  return drop;
}

/**
 * Keep every copy from the last `dailyDays` days, then only the first copy of
 * each older month, so monthly history goes back to the very first backup.
 * Also matches the `.name.icloud` placeholders iCloud leaves for evicted files.
 */
export async function pruneIcloud(dir: string, today: string, dailyDays: number): Promise<string[]> {
  const cutoff = shiftDay(today, -dailyDays);
  const files = (await readdir(dir))
    .map((n) => ({ n, base: n.replace(/^\./, "").replace(/\.icloud$/, "") }))
    .filter((f) => DB_NAME.test(f.base))
    .sort((a, b) => a.base.localeCompare(b.base));
  const seenMonth = new Set<string>();
  const drop: string[] = [];
  for (const f of files) {
    const day = DB_NAME.exec(f.base)![1]!;
    if (day > cutoff) continue;
    const month = day.slice(0, 7);
    if (seenMonth.has(month)) drop.push(f.n);
    else seenMonth.add(month);
  }
  for (const n of drop) await rm(join(dir, n), { force: true });
  return drop;
}

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Copy through a temporary name, check the size, then move into place. */
async function copyChecked(from: string, to: string): Promise<void> {
  const tmp = join(dirname(to), `.${relative(dirname(to), to)}.tmp`);
  await copyFile(from, tmp);
  const [a, b] = await Promise.all([stat(from), stat(tmp)]);
  if (a.size !== b.size) {
    await rm(tmp, { force: true });
    throw new Error(`the copy of ${from} came out the wrong size`);
  }
  await rename(tmp, to);
}

/**
 * Copy files from an append-only folder that the backup doesn't have yet.
 * Never deletes anything in the backup.
 */
export async function mirror(from: string, to: string): Promise<number> {
  if (!existsSync(from)) return 0;
  let copied = 0;
  for (const entry of await readdir(from, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const source = join(entry.parentPath, entry.name);
    const target = join(to, relative(from, source));
    const existing = await stat(target).catch(() => null);
    if (existing && existing.size === (await stat(source)).size) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyChecked(source, target);
    copied++;
  }
  return copied;
}
