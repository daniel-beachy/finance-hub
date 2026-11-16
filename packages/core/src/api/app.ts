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
import { type CoreDeps, localDate } from "../deps.ts";
import { merchantHistory, netWorthHistory, overview, reviewCounts, spendingBreakdown, cashFlowByMonth, monthOf, shiftMonth } from "../insights.ts";
import {
  type AccountChoice,
  assignImportAccount,
  discardInboxFile,
  type InboxFile,
  importStatus,
  processInbox,
  uploadFiles,
} from "../import/importer.ts";
import { InvalidInput, NotFound } from "../errors.ts";
import { listRules } from "../categorize/rules.ts";
import type { TransferKind } from "../categorize/settle.ts";
import {
  categorizeTransactions,
  createRule,
  deleteRule,
  markTransfer,
  type TransactionPatch,
  undo,
  unmarkTransfer,
  updateRule,
  updateTransaction,
} from "../mutations.ts";
import { PlaidError } from "../plaid/client.ts";
import {
  listAccounts,
  listCategories,
  listConnections,
  listSyncRuns,
  listTransactions,
  netWorth,
  type ReviewTab,
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
  /**
   * Runs in the background after a link, a reconnect or a sync from the
   * dashboard. The local server backs up here, so a new connection's one-time
   * history reaches iCloud right away instead of at the next daily sync.
   */
  afterSync?: () => Promise<unknown>;
}

/**
 * The whole HTTP API. The local server serves it over HTTP; the demo calls
 * `app.fetch()` directly in the browser. Routes stay thin: logic lives in
 * core functions that the MCP server calls too.
 */
export function createApp(deps: CoreDeps, options: AppOptions = {}) {
  const app = new Hono();
  const mode = options.mode ?? "local";
  const afterSync = () => {
    options.afterSync?.().catch((err) => console.error("After-sync step failed:", err));
  };

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
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    if (err instanceof InvalidInput) return c.json({ error: err.message }, 400);
    if (err instanceof PlaidError) {
      return c.json({ error: err.message, code: err.errorCode }, 502);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, mode }));

  const today = () => localDate(deps.now());

  app.get("/api/status", async (c) =>
    c.json({
      mode,
      today: today(),
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
    afterSync();
    return c.json(result);
  });

  app.post("/api/connections/:id/disconnect", async (c) => {
    await disconnect(deps, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/connections/:id/reconnect", async (c) => {
    const result = await reconnect(deps, c.req.param("id"));
    afterSync();
    return c.json(result);
  });

  app.post("/api/sync", async (c) => {
    const body = await readJson(c.req.raw);
    const results =
      typeof body.connection_id === "string"
        ? [await syncConnection(deps, body.connection_id, "manual")]
        : await syncAll(deps, "manual");
    afterSync();
    return c.json({ results });
  });

  app.get("/api/sync-runs", async (c) => c.json({ runs: await listSyncRuns(deps.db, Number(c.req.query("limit")) || 30) }));

  app.get("/api/accounts", async (c) => c.json({ accounts: await listAccounts(deps.db) }));

  app.get("/api/categories", async (c) => c.json({ categories: await listCategories(deps.db) }));

  app.get("/api/transactions", async (c) => {
    const q = (name: string) => c.req.query(name) || undefined;
    return c.json(
      await listTransactions(deps.db, {
        limit: Number(c.req.query("limit")) || 50,
        offset: Number(c.req.query("offset")) || 0,
        q: q("q"),
        accountId: q("account_id"),
        categoryId: q("category_id"),
        groupId: q("group_id"),
        kind: q("kind"),
        merchant: q("merchant"),
        from: q("from"),
        to: q("to"),
        review: q("review") as ReviewTab | undefined,
      }),
    );
  });

  app.patch("/api/transactions/:id", async (c) => {
    const body = await readJson(c.req.raw);
    const patch: TransactionPatch = {};
    if (typeof body.category_id === "string") patch.category_id = body.category_id;
    if (typeof body.note === "string" || body.note === null) patch.note = body.note;
    if (typeof body.reviewed === "boolean") patch.reviewed = body.reviewed;
    if (typeof body.flag === "string" || body.flag === null) patch.flag = body.flag as TransactionPatch["flag"];
    if (typeof body.excluded === "boolean") patch.excluded = body.excluded;
    const remember = typeof body.remember === "boolean" ? body.remember : undefined;
    const result = await updateTransaction(deps, c.req.param("id"), patch, "user", { remember });
    return c.json({ transaction: result, batch_id: result.batch_id });
  });

  app.post("/api/transactions/categorize", async (c) => {
    const body = await readJson(c.req.raw);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0 || typeof body.category_id !== "string") {
      return c.json({ error: "ids and category_id are required" }, 400);
    }
    const result = await categorizeTransactions(deps, ids, body.category_id, "user", {
      createRule: body.create_rule === true,
      remember: typeof body.remember === "boolean" ? body.remember : undefined,
    });
    return c.json(result);
  });

  app.get("/api/rules", async (c) => {
    const categories = new Map((await listCategories(deps.db)).map((x) => [x.id, x.name]));
    const rules = (await listRules(deps.db)).map((r) => ({ ...r, category_name: categories.get(r.actions.category_id) ?? null }));
    return c.json({ rules });
  });

  app.post("/api/rules", async (c) => {
    const body = await readJson(c.req.raw);
    if (typeof body.category_id !== "string") return c.json({ error: "category_id is required" }, 400);
    const result = await createRule(
      deps,
      {
        match: body.match,
        category_id: body.category_id,
        priority: body.priority as number | undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        created_from_transaction_id:
          typeof body.created_from_transaction_id === "string" ? body.created_from_transaction_id : null,
      },
      { dryRun: body.dry_run === true },
    );
    return c.json(result);
  });

  app.patch("/api/rules/:id", async (c) => {
    const body = await readJson(c.req.raw);
    const result = await updateRule(
      deps,
      c.req.param("id"),
      {
        match: body.match,
        category_id: typeof body.category_id === "string" ? body.category_id : undefined,
        priority: body.priority as number | undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      },
      { dryRun: body.dry_run === true },
    );
    return c.json(result);
  });

  app.delete("/api/rules/:id", async (c) => {
    const dryRun = c.req.query("dry_run") === "true";
    return c.json(await deleteRule(deps, c.req.param("id"), { dryRun }));
  });

  app.post("/api/transfers/mark", async (c) => {
    const body = await readJson(c.req.raw);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (ids.length !== 2) return c.json({ error: "ids must be two transaction ids" }, 400);
    const kind = typeof body.kind === "string" ? (body.kind as TransferKind) : undefined;
    return c.json(await markTransfer(deps, [ids[0]!, ids[1]!], { kind }));
  });

  app.post("/api/transfers/unmark", async (c) => {
    const body = await readJson(c.req.raw);
    if (typeof body.id !== "string") return c.json({ error: "id is required" }, 400);
    return c.json(await unmarkTransfer(deps, body.id));
  });

  app.post("/api/undo", async (c) => {
    const body = await readJson(c.req.raw);
    const id = typeof body.batch_id === "string" ? body.batch_id : typeof body.change_id === "string" ? body.change_id : null;
    if (!id) return c.json({ error: "batch_id or change_id is required" }, 400);
    return c.json(await undo(deps, id));
  });

  app.get("/api/overview", async (c) => c.json(await overview(deps.db, today())));

  app.get("/api/spending", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) return c.json({ error: "from and to are required" }, 400);
    return c.json(await spendingBreakdown(deps.db, from, to));
  });

  app.get("/api/cash-flow", async (c) => {
    const months = Math.min(Math.max(Number(c.req.query("months")) || 12, 1), 60);
    const end = c.req.query("to")?.slice(0, 7) || monthOf(today());
    return c.json({ months: await cashFlowByMonth(deps.db, shiftMonth(end, -(months - 1)), end) });
  });

  app.get("/api/net-worth", async (c) => {
    const months = Math.min(Math.max(Number(c.req.query("months")) || 24, 1), 240);
    return c.json({
      today: today(),
      now: await netWorth(deps.db),
      history: await netWorthHistory(deps.db, today(), months),
      accounts: await listAccounts(deps.db),
    });
  });

  app.get("/api/review", async (c) => {
    const tab = (c.req.query("tab") || "all") as ReviewTab;
    const { rows } = await listTransactions(deps.db, { review: tab, limit: 200 });
    const items = [];
    for (const transaction of rows) items.push({ transaction, history: await merchantHistory(deps.db, transaction) });
    return c.json({ counts: await reviewCounts(deps.db), items });
  });

  app.get("/api/imports", async (c) => c.json(await importStatus(deps)));

  app.post("/api/imports/upload", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > 25 * 1024 * 1024) {
      return c.json({ error: "Files must be under 20 MB" }, 413);
    }
    const form = await c.req.parseBody({ all: true });
    const field = form.files ?? form.file;
    const list = (Array.isArray(field) ? field : [field]).filter((f): f is File => f instanceof File);
    if (list.length === 0) return c.json({ error: "No files were attached" }, 400);
    const files: InboxFile[] = [];
    for (const f of list) files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    return c.json({ outcomes: await uploadFiles(deps, files) });
  });

  app.post("/api/imports/process", async (c) => c.json({ outcomes: await processInbox(deps) }));

  app.post("/api/imports/assign", async (c) => {
    const body = await readJson(c.req.raw);
    const key = typeof body.key === "string" ? body.key : "";
    let choice: AccountChoice;
    if (typeof body.account_id === "string") choice = { account_id: body.account_id };
    else if (body.create && typeof body.create === "object") choice = { create: body.create as never };
    else return c.json({ error: "account_id or create is required" }, 400);
    const accountId = await assignImportAccount(deps, key, choice);
    return c.json({ account_id: accountId, outcomes: deps.inbox ? await processInbox(deps) : [] });
  });

  app.post("/api/imports/discard", async (c) => {
    const body = await readJson(c.req.raw);
    if (typeof body.name !== "string") return c.json({ error: "name is required" }, 400);
    await discardInboxFile(deps, body.name);
    return c.json({ ok: true });
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
