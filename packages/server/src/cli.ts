import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeLink,
  createWasmDriver,
  DEMO_DEFAULTS,
  generateDemoData,
  getPlaidEnv,
  listConnections,
  listSyncRuns,
  migrate,
  PLAID_SLOT_LIMIT,
  type PlaidEnv,
  plaidClientFor,
  SECRET_CLIENT_ID,
  secretNameForEnv,
  setSetting,
  slotsUsed,
  syncAll,
  syncConnection,
  tokenNameForConnection,
} from "@finance-hub/core";
import initSqlJs from "sql.js";
import { openContext } from "./context.ts";
import { DEFAULT_PORT, startServer } from "./serve.ts";

const HELP = `fh: Finance Hub

  fh init                       Create the data directory and database
  fh setup                      Check Plaid keys in the Keychain; prompt for missing ones
  fh env [sandbox|production]   Show or set which Plaid environment new links use
  fh status                     Connections, slots used and recent sync runs
  fh sync [connection-id]       Sync all connections, or one
  fh serve [--port N]           Start the local dashboard and API
  fh sandbox-link [ins_id]      Create a Plaid Sandbox connection (no real bank)
  fh sandbox-break <id>         Force a Sandbox connection to need sign-in again (for testing)
  fh demo-db [--out FILE] [--seed N] [--as-of YYYY-MM-DD]
                                Write the synthetic demo database
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "init":
      return init();
    case "setup":
      return setup();
    case "env":
      return env(flags.positional[0]);
    case "status":
      return status();
    case "sync":
      return sync(flags.positional[0], flags.named.trigger);
    case "serve":
      return serveCommand(Number(flags.named.port) || DEFAULT_PORT);
    case "sandbox-link":
      return sandboxLink(flags.positional[0] ?? "ins_109508");
    case "sandbox-break":
      return sandboxBreak(flags.positional[0]);
    case "demo-db":
      return demoDb(flags.named);
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

function parseFlags(args: string[]): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) named[arg.slice(2)] = args[++i] ?? "";
    else positional.push(arg);
  }
  return { positional, named };
}

async function init(): Promise<number> {
  const ctx = await openContext();
  try {
    const tables = await ctx.deps.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'",
    );
    console.log(`Data directory: ${ctx.paths.root}`);
    console.log(`Database ready: ${ctx.paths.db} (${tables[0]?.n ?? 0} tables)`);
    return 0;
  } finally {
    ctx.close();
  }
}

async function setup(): Promise<number> {
  const ctx = await openContext();
  try {
    const names = [SECRET_CLIENT_ID, secretNameForEnv("sandbox"), secretNameForEnv("production")];
    let missingRequired = false;
    for (const name of names) {
      let present = (await ctx.deps.secrets.get(name)) !== null;
      if (!present && process.stdin.isTTY) {
        const value = await promptHidden(`Paste ${name} (leave blank to skip): `);
        if (value) {
          await ctx.deps.secrets.set(name, value);
          present = true;
        }
      }
      console.log(`${present ? "ok     " : "missing"}  ${name}`);
      if (!present && name !== secretNameForEnv("production")) missingRequired = true;
    }
    const current = await getPlaidEnv(ctx.deps);
    console.log(`\nPlaid environment for new links: ${current}`);
    if (missingRequired) {
      console.log(
        "\nStore a missing key yourself with:\n  security add-generic-password -U -s finance-hub -a <name> -w",
      );
      return 1;
    }
    return 0;
  } finally {
    ctx.close();
  }
}

/** Read a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolvePrompt(value.trim());
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function env(next: string | undefined): Promise<number> {
  const ctx = await openContext();
  try {
    if (next === undefined) {
      console.log(await getPlaidEnv(ctx.deps));
      return 0;
    }
    if (next !== "sandbox" && next !== "production") {
      console.error("Environment must be sandbox or production");
      return 2;
    }
    if (next === "production" && !(await ctx.deps.secrets.get(secretNameForEnv("production")))) {
      console.error("The production secret is not in the Keychain yet. Run: fh setup");
      return 1;
    }
    await setSetting(ctx.deps.db, "plaid_env", next satisfies PlaidEnv);
    console.log(`New links will use Plaid ${next}.`);
    if (next === "production") {
      console.log(`Each real institution uses one of ${PLAID_SLOT_LIMIT} lifetime connections.`);
    }
    return 0;
  } finally {
    ctx.close();
  }
}

async function status(): Promise<number> {
  const ctx = await openContext();
  try {
    console.log(`Plaid environment: ${await getPlaidEnv(ctx.deps)}`);
    console.log(`Plaid connections used: ${await slotsUsed(ctx.deps)} of ${PLAID_SLOT_LIMIT}\n`);
    const connections = await listConnections(ctx.deps.db);
    if (connections.length === 0) console.log("No connections yet.");
    for (const c of connections) {
      const tag = c.plaid_env ? ` [${c.plaid_env}]` : "";
      console.log(`${c.institution_name}${tag}  ${c.status}  last synced ${c.last_synced_at ?? "never"}  (${c.id})`);
      for (const a of c.accounts) {
        const balance = a.current_cents === null ? "" : `  ${(a.current_cents / 100).toFixed(2)}`;
        console.log(`    ${a.name}${a.mask ? ` ••${a.mask}` : ""}  ${a.type}${balance}  ${a.transaction_count} transactions`);
      }
    }
    const runs = await listSyncRuns(ctx.deps.db, 5);
    if (runs.length) console.log("\nRecent sync runs:");
    for (const r of runs) {
      console.log(
        `  ${r.started_at}  ${r.institution_name ?? "?"}  ${r.status}  +${r.added} ~${r.modified} -${r.removed}` +
          (r.error_code ? `  ${r.error_code}` : ""),
      );
    }
    return 0;
  } finally {
    ctx.close();
  }
}

async function sync(connectionId: string | undefined, trigger: string | undefined): Promise<number> {
  const ctx = await openContext();
  try {
    const how = trigger === "schedule" ? "schedule" : "manual";
    const results = connectionId
      ? [await syncConnection(ctx.deps, connectionId, how)]
      : await syncAll(ctx.deps, how);
    if (results.length === 0) console.log("No connections to sync.");
    for (const r of results) {
      console.log(
        `${r.institution}: ${r.status}  added ${r.added}, modified ${r.modified}, removed ${r.removed}` +
          (r.errorCode ? `  (${r.errorCode})` : ""),
      );
    }
    return results.some((r) => r.status === "error" || r.status === "login_required") ? 1 : 0;
  } finally {
    ctx.close();
  }
}

async function serveCommand(port: number): Promise<number> {
  const ctx = await openContext();
  await startServer(ctx, port);
  console.log(`Finance Hub is running at http://127.0.0.1:${port}  (Ctrl+C to stop)`);
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  ctx.close();
  return 0;
}

/**
 * Create a Sandbox Item without the Link UI. Refuses to run unless the
 * environment is sandbox, so it can never spend a real connection.
 */
async function sandboxLink(institutionId: string): Promise<number> {
  const ctx = await openContext();
  try {
    if ((await getPlaidEnv(ctx.deps)) !== "sandbox") {
      console.error("sandbox-link only runs when the Plaid environment is sandbox.");
      return 1;
    }
    const client = await plaidClientFor(ctx.deps, "sandbox");
    const { public_token } = await client.sandboxPublicTokenCreate(institutionId, ["transactions", "investments"]);
    const result = await completeLink(ctx.deps, {
      publicToken: public_token,
      institution: { id: institutionId, name: `Sandbox ${institutionId}` },
    });
    console.log(`Created sandbox connection ${result.connectionId}`);
    console.log(`First sync: ${result.sync.status}, added ${result.sync.added}`);
    if (result.sync.added === 0) {
      console.log('Plaid prepares sandbox transactions in the background. Run "fh sync" again in a few seconds.');
    }
    return 0;
  } finally {
    ctx.close();
  }
}

/** Put a Sandbox Item into ITEM_LOGIN_REQUIRED, to exercise the repair flow. */
async function sandboxBreak(connectionId: string | undefined): Promise<number> {
  const ctx = await openContext();
  try {
    const row = connectionId
      ? (await listConnections(ctx.deps.db)).find((c) => c.id === connectionId)
      : undefined;
    if (row?.plaid_env !== "sandbox") {
      console.error("Give the id of a sandbox connection (see: fh status).");
      return 2;
    }
    const token = await ctx.deps.secrets.get(tokenNameForConnection(row.id));
    if (!token) {
      console.error("No access token stored for that connection.");
      return 1;
    }
    const client = await plaidClientFor(ctx.deps, "sandbox");
    await client.sandboxItemResetLogin(token);
    console.log(`${row.institution_name} now needs sign-in. Run "fh sync" to see it reported.`);
    return 0;
  } finally {
    ctx.close();
  }
}

async function demoDb(named: Record<string, string>): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(named.out ?? join(here, "..", "..", "web", "public", "demo.sqlite"));
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  const db = createWasmDriver(database);
  const asOf = named["as-of"] ?? DEMO_DEFAULTS.asOf;
  // A fixed clock keeps the file byte-identical for the same seed and date.
  await migrate(db, () => new Date(`${asOf}T12:00:00.000Z`));
  const summary = await generateDemoData(db, {
    seed: named.seed ? Number(named.seed) : DEMO_DEFAULTS.seed,
    asOf,
  });
  await db.exec("VACUUM");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, database.export());
  database.close();
  console.log(
    `Wrote ${out}: ${summary.transactions} synthetic transactions across ${summary.accounts} accounts, ` +
      `${summary.from} to ${summary.to}`,
  );
  return 0;
}
