import { Hono } from "hono";
import {
  completeLink,
  createLinkToken,
  disconnect,
  getPlaidEnv,
  PLAID_SLOT_LIMIT,
  reconnect,
  SlotConfirmationRequired,
  slotsUsed,
} from "../connections.ts";
import type { CoreDeps } from "../deps.ts";
import { PlaidError } from "../plaid/client.ts";
import {
  listAccounts,
  listCategories,
  listConnections,
  listSyncRuns,
  listTransactions,
  netWorth,
  spendingByCategory,
} from "../queries.ts";
import { syncAll, syncConnection } from "../sync/sync.ts";

export interface AppOptions {
  /**
   * Origins allowed to call the API, e.g. `http://127.0.0.1:5202`. When set,
   * a request whose Host is not one of these, or whose Origin is anything
   * else, is refused. Leave unset for the in-browser demo.
   */
  allowedOrigins?: string[];
  mode?: "local" | "demo";
}

/**
 * The whole HTTP API. The local server serves it over HTTP; the demo calls
 * `app.fetch()` directly in the browser. Routes stay thin: logic lives in
 * core functions that the MCP server calls too.
 */
export function createApp(deps: CoreDeps, options: AppOptions = {}) {
  const app = new Hono();
  const mode = options.mode ?? "local";

  if (options.allowedOrigins) {
    const origins = new Set(options.allowedOrigins);
    const hosts = new Set(options.allowedOrigins.map((o) => new URL(o).host));
    app.use("*", async (c, next) => {
      // Host check blocks DNS rebinding; Origin check blocks other sites'
      // pages from driving the API through the user's browser.
      const host = c.req.header("host");
      if (!host || !hosts.has(host)) return c.json({ error: "Forbidden host" }, 403);
      const origin = c.req.header("origin");
      if (origin && !origins.has(origin)) return c.json({ error: "Forbidden origin" }, 403);
      await next();
    });
  }

  app.onError((err, c) => {
    if (err instanceof SlotConfirmationRequired) {
      return c.json({ error: err.message, code: "SLOT_CONFIRMATION_REQUIRED", slots_used: err.slotsUsed }, 409);
    }
    if (err instanceof PlaidError) {
      return c.json({ error: err.message, code: err.errorCode }, 502);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, mode }));

  app.get("/api/status", async (c) =>
    c.json({
      mode,
      plaid_env: await getPlaidEnv(deps),
      slots_used: await slotsUsed(deps),
      slot_limit: PLAID_SLOT_LIMIT,
      net_worth: await netWorth(deps.db),
    }),
  );

  app.get("/api/connections", async (c) => c.json({ connections: await listConnections(deps.db) }));

  app.post("/api/connections/link-token", async (c) => {
    const body = await readJson(c.req.raw);
    const res = await createLinkToken(deps, {
      kind: body.kind === "investment" ? "investment" : "bank",
      connectionId: typeof body.connection_id === "string" ? body.connection_id : undefined,
    });
    return c.json({ link_token: res.link_token, mode: res.mode, env: res.env });
  });

  app.post("/api/connections/exchange", async (c) => {
    const body = await readJson(c.req.raw);
    if (typeof body.public_token !== "string") return c.json({ error: "public_token is required" }, 400);
    const institution = (body.institution ?? {}) as { id?: string; name?: string };
    const result = await completeLink(deps, {
      publicToken: body.public_token,
      institution: { id: institution.id ?? null, name: institution.name ?? null },
      confirmSlot: body.confirm_slot === true,
    });
    return c.json(result);
  });

  app.post("/api/connections/:id/disconnect", async (c) => {
    await disconnect(deps, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/connections/:id/reconnect", async (c) => c.json(await reconnect(deps, c.req.param("id"))));

  app.post("/api/sync", async (c) => {
    const body = await readJson(c.req.raw);
    const results =
      typeof body.connection_id === "string"
        ? [await syncConnection(deps, body.connection_id, "manual")]
        : await syncAll(deps, "manual");
    return c.json({ results });
  });

  app.get("/api/sync-runs", async (c) => c.json({ runs: await listSyncRuns(deps.db, Number(c.req.query("limit")) || 30) }));

  app.get("/api/accounts", async (c) => c.json({ accounts: await listAccounts(deps.db) }));

  app.get("/api/categories", async (c) => c.json({ categories: await listCategories(deps.db) }));

  app.get("/api/transactions", async (c) =>
    c.json(
      await listTransactions(deps.db, {
        limit: Number(c.req.query("limit")) || 50,
        offset: Number(c.req.query("offset")) || 0,
        accountId: c.req.query("account_id"),
      }),
    ),
  );

  app.get("/api/spending", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) return c.json({ error: "from and to are required" }, 400);
    return c.json({ categories: await spendingByCategory(deps.db, from, to) });
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  return app;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
