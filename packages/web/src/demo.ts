import {
  createApp,
  createIdFactory,
  createMemoryArchive,
  createMemorySecretStore,
  createWasmDriver,
  getSetting,
} from "@finance-hub/core";
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

/**
 * The public demo: the real API, running in the page against a synthetic
 * database. Edits live in memory and reset on reload. Nothing is sent
 * anywhere after the page has loaded.
 */
async function boot() {
  const [SQL, file] = await Promise.all([
    initSqlJs({ locateFile: () => wasmUrl }),
    fetch(`${import.meta.env.BASE_URL}demo.sqlite`).then((r) => {
      if (!r.ok) throw new Error("The demo data could not be loaded.");
      return r.arrayBuffer();
    }),
  ]);
  const db = createWasmDriver(new SQL.Database(new Uint8Array(file)));
  // Pin the clock to the data's last day so "this month" is never empty.
  const asOf = await getSetting<string | null>(db, "demo_as_of", null);
  const now = asOf ? () => new Date(`${asOf}T12:00:00`) : () => new Date();
  return createApp(
    {
      db,
      secrets: createMemorySecretStore(),
      archive: createMemoryArchive(),
      now,
      newId: createIdFactory(() => Date.now(), Math.random),
    },
    { mode: "demo" },
  );
}

let app: ReturnType<typeof boot> | null = null;

export async function demoFetch(path: string, init?: RequestInit): Promise<Response> {
  app ??= boot();
  return (await app).fetch(new Request(`http://demo.invalid${path}`, init));
}
