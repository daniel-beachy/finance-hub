import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  completeLink,
  type CoreDeps,
  createIdFactory,
  createMemorySecretStore,
  migrate,
  syncConnection,
} from "@finance-hub/core";
import { FakePlaidFailure, fakePlaid } from "../../core/test/helpers.ts";
import { createFileArchive } from "../src/archive.ts";
import { mirror, pruneIcloud, pruneLocal, runBackup } from "../src/backup.ts";
import { openNodeDatabase } from "../src/nodeDriver.ts";
import { dataPaths, ensureDataDirs } from "../src/paths.ts";
import { replayToFile, restoreDatabase } from "../src/recovery.ts";
import { appleScriptString, plistFor, stableNodePath } from "../src/schedule.ts";

const root = mkdtempSync(join(tmpdir(), "fh-recovery-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A real on-disk data directory with a migrated database and a fixed clock. */
async function dataDir(name: string, at = "2026-11-14T15:00:00Z") {
  const paths = dataPaths(join(root, name));
  ensureDataDirs(paths);
  const db = openNodeDatabase(paths.db);
  await migrate(db.driver);
  let tick = Date.parse(at);
  const deps: CoreDeps = {
    db: db.driver,
    secrets: createMemorySecretStore({ "plaid-client-id": "c", "plaid-secret-sandbox": "s" }),
    archive: createFileArchive(paths.raw),
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
    newId: createIdFactory(),
  };
  const advanceDays = (n: number) => {
    tick += n * 86_400_000;
  };
  return { paths, deps, db, advanceDays };
}

const touch = (dir: string, names: string[]) => {
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, n), "x");
};

describe("backup", () => {
  it("writes a checked dated copy locally and to the backup folder, with the archive and imported files", async () => {
    const { paths, deps, db } = await dataDir("backup");
    await deps.db.run("INSERT INTO settings (key, value) VALUES ('marker', '\"one\"')");
    touch(join(paths.raw, "plaid", "conn-1"), ["a.json.gz", "b.json.gz"]);
    touch(paths.imported, ["2026-11-14T10-00-00-000Z-History.csv"]);
    const backupDir = join(root, "icloud-ok");

    const first = await runBackup(deps, paths, { backupDir });
    expect(first.icloudError).toBeNull();
    expect(readdirSync(paths.backups)).toEqual(["finance-2026-11-14.db"]);
    expect(first.icloud).toMatchObject({ rawCopied: 2, importedCopied: 1 });
    expect(readdirSync(backupDir).sort()).toEqual(["finance-2026-11-14.db", "imported", "raw"]);

    // The copy is a complete, readable database.
    const copy = openNodeDatabase(join(backupDir, "finance-2026-11-14.db"), { readOnly: true });
    expect(await copy.driver.all("SELECT value FROM settings WHERE key = 'marker'")).toEqual([{ value: '"one"' }]);
    copy.close();

    // A second run the same day replaces that day's copy and copies only new files.
    touch(join(paths.raw, "plaid", "conn-1"), ["c.json.gz"]);
    const second = await runBackup(deps, paths, { backupDir });
    expect(second.icloud).toMatchObject({ rawCopied: 1, importedCopied: 0 });
    expect(readdirSync(paths.backups)).toEqual(["finance-2026-11-14.db"]);
    db.close();
  });

  it("raises one alert when the iCloud copy fails, keeps the local copy, and clears it on success", async () => {
    const { paths, deps, db } = await dataDir("backup-fail");
    const notADir = join(root, "a-file");
    writeFileSync(notADir, "x");
    const failed = await runBackup(deps, paths, { backupDir: join(notADir, "sub") });
    expect(failed.icloudError).toBeTruthy();
    expect(existsSync(failed.local)).toBe(true);
    await runBackup(deps, paths, { backupDir: join(notADir, "sub") });
    const open = () => deps.db.all("SELECT message FROM alerts WHERE kind = 'connection' AND dismissed_at IS NULL");
    expect(await open()).toHaveLength(1);
    await runBackup(deps, paths, { backupDir: join(root, "icloud-recovered") });
    expect(await open()).toHaveLength(0);
    db.close();
  });

  it("keeps 14 local copies, and in iCloud 30 days of dailies plus the first copy of each older month", async () => {
    const local = join(root, "prune-local");
    touch(local, Array.from({ length: 20 }, (_, i) => `finance-2026-10-${String(i + 1).padStart(2, "0")}.db`));
    await pruneLocal(local, 14);
    expect(readdirSync(local).sort()[0]).toBe("finance-2026-10-07.db");
    expect(readdirSync(local)).toHaveLength(14);

    const cloud = join(root, "prune-cloud");
    touch(cloud, [
      "finance-2026-08-03.db",
      "finance-2026-08-20.db",
      ".finance-2026-09-01.db.icloud",
      "finance-2026-09-15.db",
      "finance-2026-10-14.db",
      "finance-2026-11-14.db",
      "notes.txt",
    ]);
    await pruneIcloud(cloud, "2026-11-14", 30);
    expect(readdirSync(cloud).sort()).toEqual([
      ".finance-2026-09-01.db.icloud",
      "finance-2026-08-03.db",
      "finance-2026-10-14.db",
      "finance-2026-11-14.db",
      "notes.txt",
    ]);
  });

  it("mirrors without ever deleting from the backup", async () => {
    const from = join(root, "m-from");
    const to = join(root, "m-to");
    touch(join(from, "x"), ["1"]);
    touch(join(to, "old"), ["kept"]);
    expect(await mirror(from, to)).toBe(1);
    expect(await mirror(from, to)).toBe(0);
    expect(existsSync(join(to, "old", "kept"))).toBe(true);
  });
});

describe("restore", () => {
  it("swaps in a backup, keeps the replaced database, and refuses files that aren't Finance Hub databases", async () => {
    const { paths, deps, db } = await dataDir("restore");
    await deps.db.run("INSERT INTO settings (key, value) VALUES ('marker', '\"before\"')");
    const backup = await runBackup(deps, paths, { backupDir: join(root, "icloud-restore") });
    await deps.db.run("UPDATE settings SET value = '\"after\"' WHERE key = 'marker'");
    db.close();

    const junk = join(root, "junk.db");
    writeFileSync(junk, "not a database");
    await expect(restoreDatabase(paths, junk, new Date())).rejects.toThrow();

    const result = await restoreDatabase(paths, backup.local, new Date("2026-11-15T08:00:00Z"));
    expect(result.keptAs).toBe(`${paths.db}.before-restore`);
    const live = openNodeDatabase(paths.db);
    expect(await live.driver.all("SELECT value FROM settings WHERE key = 'marker'")).toEqual([{ value: '"before"' }]);
    live.close();
    const kept = openNodeDatabase(result.keptAs!, { readOnly: true });
    expect(await kept.driver.all("SELECT value FROM settings WHERE key = 'marker'")).toEqual([{ value: '"after"' }]);
    kept.close();

    // A second restore keeps the earlier kept copy too.
    await restoreDatabase(paths, backup.local, new Date("2026-11-15T09:00:00Z"));
    const kept2 = readdirSync(paths.root).filter((n) => n.startsWith("finance.db.before-restore"));
    // Each kept database travels with its own -wal and -shm files, never another's.
    expect(kept2.filter((n) => !/-(wal|shm)$/.test(n))).toHaveLength(2);
    expect(kept2.filter((n) => /^finance\.db\.before-restore-(wal|shm)$/.test(n))).toEqual([]);
  });
});

describe("replay from disk", () => {
  it("rebuilds a linked connection from its gzipped archive and matches the live database", async () => {
    const { readFileSync } = await import("node:fs");
    const recorded = JSON.parse(
      readFileSync(new URL("../../core/test/fixtures/plaid-sandbox.json", import.meta.url), "utf8"),
    );
    let step = 0;
    const plaid = fakePlaid({
      "/item/public_token/exchange": () => ({ access_token: "access-sandbox-x", item_id: recorded.item.item.item_id }),
      "/item/get": () => recorded.item,
      "/accounts/get": () => recorded.accounts,
      "/transactions/sync": () =>
        step === 0
          ? recorded.transactions_sync
          : { added: [], modified: [], removed: [{ transaction_id: recorded.transactions_sync.added[0].transaction_id }], next_cursor: "n2", has_more: false },
      "/investments/holdings/get": () => {
        throw new FakePlaidFailure("PRODUCTS_NOT_SUPPORTED");
      },
    });
    const live = await dataDir("replay");
    live.deps.fetch = plaid.fetch;
    const { connectionId } = await completeLink(live.deps, { publicToken: "p", institution: { name: "Platypus" } });
    step = 1;
    live.advanceDays(1);
    await syncConnection(live.deps, connectionId);

    const report = await replayToFile(live.paths, live.deps.db, join(live.paths.root, "replay", "r.db"));
    expect(report.connections).toMatchObject([{ connectionId, runs: 2, applied: 2 }]);
    expect(report.accounts.length).toBeGreaterThan(0);
    expect(report.accounts.every((a) => a.matches)).toBe(true);
    expect(report.accounts.reduce((n, a) => n + a.live.count, 0)).toBe(recorded.transactions_sync.added.length - 1);
    await expect(replayToFile(live.paths, live.deps.db, report.out)).rejects.toThrow("already exists");
    live.db.close();
  });
});

describe("daily job", () => {
  it("runs fh sync through bash at 06:30 with the data folder", () => {
    const plist = plistFor({ node: "/opt/node/bin/node", bin: "/repo/bin/fh.js", repo: "/repo", log: "/d/logs/sync.log", dataDir: "/d" });
    expect(plist).toContain("<string>/bin/bash</string><string>-c</string>");
    expect(plist).toContain("'/opt/node/bin/node' '/repo/bin/fh.js' sync --trigger schedule; exit $?");
    expect(plist).toContain("<key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer>");
    expect(plist).toContain("<key>FH_DATA_DIR</key><string>/d</string>");
  });

  it("prefers a stable link to node over a versioned Homebrew path", async () => {
    const { symlinkSync } = await import("node:fs");
    const cellar = join(root, "Cellar", "node", "26.8.2", "bin");
    touch(cellar, ["node"]);
    const link = join(root, "bin-node");
    symlinkSync(join(cellar, "node"), link);
    expect(stableNodePath(join(cellar, "node"), [join(root, "missing"), link])).toBe(link);
    expect(stableNodePath(join(cellar, "node"), [join(root, "missing")])).toBe(join(cellar, "node"));
  });

  it("escapes notification text for AppleScript", () => {
    expect(appleScriptString('Chase "needs" you \\ now')).toBe('"Chase \\"needs\\" you \\\\ now"');
  });
});
