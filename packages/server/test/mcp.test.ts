import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdFactory, createMcpServer, createMemoryArchive, createMemorySecretStore, generateDemoData, migrate } from "@finance-hub/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqlRunner } from "../src/mcp.ts";
import { openNodeDatabase } from "../src/nodeDriver.ts";

const dir = mkdtempSync(join(tmpdir(), "fh-mcp-"));
const path = join(dir, "finance.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeAll(async () => {
  const db = openNodeDatabase(path);
  await migrate(db.driver);
  await generateDemoData(db.driver, { months: 2, asOf: "2026-06-30" });
  db.close();
});

describe("run_sql on Node", () => {
  it("runs in a worker on a read-only connection, capped at the row limit", async () => {
    const runner = createSqlRunner(path);
    try {
      const r = await runner.run("SELECT id FROM transactions", 5);
      expect(r.rows).toHaveLength(5);
      expect(r.truncated).toBe(true);
      // Even if a write slipped past the SELECT check, the connection refuses it.
      await expect(runner.run("DELETE FROM transactions", 5)).rejects.toThrow(/readonly|read-only|query_only/i);
      const n = await runner.run("SELECT COUNT(*) AS n FROM transactions", 5);
      expect(Number(n.rows[0]!.n)).toBeGreaterThan(0);
    } finally {
      await runner.close();
    }
  });

  it("stops a query that runs past the time limit, and the next query still works", async () => {
    const runner = createSqlRunner(path, 300);
    try {
      const slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT MAX(x) FROM c";
      const started = Date.now();
      await expect(runner.run(slow, 10)).rejects.toThrow(/longer than/);
      expect(Date.now() - started).toBeLessThan(3000);
      const r = await runner.run("SELECT 1 AS one", 10);
      expect(r.rows).toEqual([{ one: 1 }]);
    } finally {
      await runner.close();
    }
  });

  it("read tools on a read-only connection can't write", async () => {
    const write = openNodeDatabase(path);
    const read = openNodeDatabase(path, { readOnly: true });
    const deps = {
      db: write.driver,
      secrets: createMemorySecretStore(),
      archive: createMemoryArchive(),
      now: () => new Date("2026-06-30T12:00:00Z"),
      newId: createIdFactory(),
    };
    try {
      await expect(read.driver.run("DELETE FROM tags")).rejects.toThrow(/readonly|read-only/i);
      const server = createMcpServer({ read: read.driver, deps });
      const res = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "overview", arguments: {} } })) as any;
      expect(res.result.isError).toBeUndefined();
    } finally {
      read.close();
      write.close();
    }
  });
});

describe("fh mcp over stdio", () => {
  it("answers initialize, tools/list and a tool call, one JSON message per line", async () => {
    const bin = join(import.meta.dirname, "..", "bin", "fh.js");
    const child = spawn(process.execPath, [bin, "mcp"], { env: { ...process.env, FH_DATA_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
    const lines: any[] = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_sql", arguments: { sql: "SELECT COUNT(*) AS n FROM accounts" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_sql", arguments: { sql: "DELETE FROM accounts" } } });
    child.stdin.end();
    const code = await new Promise<number | null>((done) => child.on("close", done));
    expect(code).toBe(0);
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(lines[0].result.serverInfo.name).toBe("finance-hub");
    expect(lines[1].result.tools.length).toBeGreaterThan(15);
    expect(JSON.parse(lines[2].result.content[0].text).rows[0].n).toBe(10);
    expect(lines[3].result.isError).toBe(true);
  }, 30_000);
});
