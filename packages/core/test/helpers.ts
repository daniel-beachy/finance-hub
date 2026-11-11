import initSqlJs from "sql.js";
import {
  type CoreDeps,
  createIdFactory,
  createMemoryArchive,
  createMemorySecretStore,
  createRng,
  createWasmDriver,
  migrate,
  type SqlDriver,
} from "../src/index.ts";

export async function openWasmDb(): Promise<SqlDriver> {
  const SQL = await initSqlJs();
  const db = createWasmDriver(new SQL.Database());
  await migrate(db);
  return db;
}

export interface PlaidCall {
  endpoint: string;
  body: Record<string, any>;
}

type Handler = (body: Record<string, any>, nthCall: number) => unknown;

/** Throw this from a handler to make the fake Plaid return an error response. */
export class FakePlaidFailure {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    this.code = code;
    this.status = status;
  }
}

/** A stand-in for Plaid's HTTP API, scripted per endpoint. */
export function fakePlaid(handlers: Record<string, Handler>) {
  const calls: PlaidCall[] = [];
  const counts = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const endpoint = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    calls.push({ endpoint, body });
    const n = counts.get(endpoint) ?? 0;
    counts.set(endpoint, n + 1);
    const handler = handlers[endpoint];
    if (!handler) return json({ error_code: "NO_HANDLER", error_message: endpoint }, 500);
    try {
      return json(handler(body, n), 200);
    } catch (err) {
      if (err instanceof FakePlaidFailure) {
        return json({ error_type: "TEST", error_code: err.code, error_message: err.code }, err.status);
      }
      throw err;
    }
  };
  return { fetch, calls, endpoints: () => calls.map((c) => c.endpoint) };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function makeDeps(fetchImpl: CoreDeps["fetch"], db?: SqlDriver) {
  const archive = createMemoryArchive();
  const secrets = createMemorySecretStore({
    "plaid-client-id": "test-client",
    "plaid-secret-sandbox": "test-sandbox-secret",
    "plaid-secret-production": "test-production-secret",
  });
  let tick = Date.parse("2026-11-10T15:00:00Z");
  const deps: CoreDeps = {
    db: db ?? (await openWasmDb()),
    secrets,
    archive,
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
    newId: createIdFactory(() => tick, createRng(7).next),
    fetch: fetchImpl,
  };
  return { deps, archive, secrets };
}
