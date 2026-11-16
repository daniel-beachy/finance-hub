import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import {
  createMcpServer,
  InvalidInput,
  type McpContext,
  processInbox,
  SQL_TIMEOUT_MS,
  syncAll,
} from "@finance-hub/core";
import { runBackup } from "./backup.ts";
import { openContext } from "./context.ts";
import { openNodeDatabase } from "./nodeDriver.ts";

/**
 * `run_sql` on Node: each query runs in a worker thread on its own read-only
 * connection. If it isn't done within the time limit the worker is
 * terminated (SQLite can't be interrupted from the same thread) and a fresh
 * one starts with the next query.
 */
export function createSqlRunner(path: string, timeoutMs = SQL_TIMEOUT_MS) {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: { rows: Record<string, unknown>[]; truncated: boolean }) => void; reject: (e: Error) => void }>();

  const start = () => {
    const w = new Worker(new URL("./sqlWorker.ts", import.meta.url), { workerData: { path } });
    w.on("message", (msg: { id: number; rows?: Record<string, unknown>[]; truncated?: boolean; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new InvalidInput(msg.error));
      else p.resolve({ rows: msg.rows ?? [], truncated: msg.truncated ?? false });
    });
    w.on("error", (err: Error) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      if (worker === w) worker = null;
    });
    w.unref();
    return w;
  };

  return {
    run(sql: string, maxRows: number) {
      worker ??= start();
      const w = worker;
      const id = ++seq;
      return new Promise<{ rows: Record<string, unknown>[]; truncated: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          if (worker === w) worker = null;
          void w.terminate();
          reject(new InvalidInput(`The query took longer than ${timeoutMs / 1000} seconds and was stopped`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        w.postMessage({ id, sql, maxRows });
      });
    },
    async close() {
      await worker?.terminate();
      worker = null;
    },
  };
}

/**
 * `fh mcp`: the MCP server over stdio. One JSON-RPC message per line on
 * stdin, one response per line on stdout. Nothing else may write to stdout,
 * so console output goes to stderr while it runs. Messages are handled one
 * at a time: write tools share one connection and its transactions.
 */
export async function runMcpServer(): Promise<number> {
  console.log = (...args: unknown[]) => console.error(...args);
  const ctx = await openContext();
  const read = openNodeDatabase(ctx.paths.db, { readOnly: true });
  const sql = createSqlRunner(ctx.paths.db);
  const mcpContext: McpContext = {
    read: read.driver,
    deps: ctx.deps,
    runSql: (query, maxRows) => sql.run(query, maxRows),
    syncNow: async () => {
      const results = await syncAll(ctx.deps, "mcp");
      const imported = await processInbox(ctx.deps);
      const backup = await runBackup(ctx.deps, ctx.paths).catch((err) => ({ icloudError: String(err) }));
      return {
        connections: results.map((r) => ({ institution: r.institution, status: r.status, added: r.added, modified: r.modified, removed: r.removed, error: r.errorCode ?? null })),
        files_imported: imported.filter((o) => o.status === "imported").length,
        backup_ok: !("icloudError" in backup && backup.icloudError),
      };
    },
  };
  const server = createMcpServer(mcpContext, { log: (line) => console.error(line) });

  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let response: Record<string, unknown> | null;
      try {
        response = await server.handle(JSON.parse(line));
      } catch (err) {
        response =
          err instanceof SyntaxError
            ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
            : { jsonrpc: "2.0", id: null, error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" } };
      }
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((done) => lines.once("close", done));
  await queue;
  await sql.close();
  read.close();
  ctx.close();
  return 0;
}
