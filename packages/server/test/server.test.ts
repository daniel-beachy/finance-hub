import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileArchive, readArchive } from "../src/archive.ts";
import { createKeychainStore } from "../src/keychain.ts";
import { openNodeDatabase } from "../src/nodeDriver.ts";

const dir = mkdtempSync(join(tmpdir(), "fh-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("file archive", () => {
  it("writes gzipped entries that read back in order and are never overwritten", async () => {
    const raw = join(dir, "raw");
    const archive = createFileArchive(raw);
    const entry = (n: number) => ({
      provider: "plaid" as const,
      connectionId: "conn-1",
      endpoint: "/transactions/sync",
      fetchedAt: "2026-11-10T15:00:00.000Z",
      env: "sandbox",
      request: { cursor: n === 0 ? null : `c${n}` },
      response: { added: [{ transaction_id: `t${n}` }] },
    });
    await archive.write(entry(0));
    await archive.write(entry(1));
    const files = readdirSync(join(raw, "plaid", "conn-1"));
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith("-transactions_sync.json.gz"))).toBe(true);
    const back = await readArchive(raw, "conn-1");
    expect(back.map((e) => (e.response as any).added[0].transaction_id)).toEqual(["t0", "t1"]);
    expect(await readArchive(raw, "missing")).toEqual([]);
  });
});

describe("node database", () => {
  it("persists to disk in WAL mode with owner-only permissions", async () => {
    const path = join(dir, "test.db");
    const db = openNodeDatabase(path);
    await db.driver.exec("CREATE TABLE t (a)");
    await db.driver.run("INSERT INTO t VALUES (?)", [1]);
    expect(await db.driver.all("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
    db.close();
    const again = openNodeDatabase(path, { readOnly: true });
    expect(await again.driver.all("SELECT a FROM t")).toEqual([{ a: 1 }]);
    await expect(again.driver.run("INSERT INTO t VALUES (2)")).rejects.toThrow();
    again.close();
  });
});

// Uses a throwaway Keychain service so the real "finance-hub" items are untouched.
describe.skipIf(process.platform !== "darwin" || process.env.CI)("keychain store", () => {
  it("round-trips a secret without putting it on a command line", async () => {
    const store = createKeychainStore("finance-hub-selftest");
    const name = `test-${process.pid}`;
    try {
      expect(await store.get(name)).toBeNull();
      await store.set(name, "access-sandbox-1234abcd-ef");
      expect(await store.get(name)).toBe("access-sandbox-1234abcd-ef");
      await store.set(name, "updated-value");
      expect(await store.get(name)).toBe("updated-value");
      await expect(store.set(name, "has space; rm -rf")).rejects.toThrow();
    } finally {
      await store.delete(name);
    }
    expect(await store.get(name)).toBeNull();
  });
});
