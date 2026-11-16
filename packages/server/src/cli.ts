import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  completeLink,
  createWasmDriver,
  DEMO_DEFAULTS,
  generateDemoData,
  getPlaidEnv,
  type ImportOutcome,
  listConnections,
  listSyncRuns,
  migrate,
  PLAID_SLOT_LIMIT,
  type PlaidEnv,
  plaidClientFor,
  processInbox,
  SECRET_CLIENT_ID,
  secretNameForEnv,
  setSetting,
  settle,
  slotsUsed,
  syncAll,
  syncConnection,
  tokenNameForConnection,
} from "@finance-hub/core";
import initSqlJs from "sql.js";
import { type BackupResult, runBackup } from "./backup.ts";
import { type AppContext, openContext } from "./context.ts";
import { replayToFile, restoreDatabase } from "./recovery.ts";
import {
  defaultPlistOptions,
  installSchedule,
  notify,
  PLIST,
  plistFor,
  SYNC_HOUR,
  SYNC_MINUTE,
  uninstallSchedule,
} from "./schedule.ts";
import { DEFAULT_PORT, startServer } from "./serve.ts";

const HELP = `fh: Finance Hub

  fh init                       Create the data directory and database
  fh setup                      Check Plaid keys in the Keychain; prompt for missing ones
  fh env [sandbox|production]   Show or set which Plaid environment new links use
  fh status                     Connections, slots used and recent sync runs
  fh sync [connection-id]       Sync all connections (or one); a full sync also imports
                                the inbox and runs the backup
  fh import                     Import files waiting in the inbox
  fh categorize                 Re-run the categorizer over everything not set by hand
  fh backup                     Back up the database now (local copy and iCloud Drive)
  fh restore <file> [--yes]     Replace the database with a backup; keeps the old one
  fh replay [--out FILE]        Rebuild Plaid data from the raw archive into a new file
                                and compare it with the live database
  fh install [--print]          Run "fh sync" every day at 06:30 (launchd)
  fh uninstall                  Stop the daily sync
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
    case "import":
      return importCommand();
    case "categorize":
      return categorizeCommand();
    case "backup":
      return backupCommand();
    case "restore":
      return restoreCommand(flags.positional[0], "yes" in flags.named);
    case "replay":
      return replayCommand(flags.named.out);
    case "install":
      return installCommand("print" in flags.named);
    case "uninstall":
      return uninstallCommand();
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

const BOOLEAN_FLAGS = new Set(["yes", "print"]);

function parseFlags(args: string[]): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      named[key] = BOOLEAN_FLAGS.has(key) ? "true" : (args[++i] ?? "");
    }
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
  const scheduled = trigger === "schedule";
  try {
    if (scheduled) console.log(`\n=== Scheduled sync ${new Date().toString()}`);
    const results = connectionId
      ? [await syncConnection(ctx.deps, connectionId, scheduled ? "schedule" : "manual")]
      : await syncAll(ctx.deps, scheduled ? "schedule" : "manual");
    if (results.length === 0) console.log("No connections to sync.");
    for (const r of results) {
      console.log(
        `${r.institution}: ${r.status}  added ${r.added}, modified ${r.modified}, removed ${r.removed}` +
          (r.errorCode ? `  (${r.errorCode})` : ""),
      );
    }
    const failed = results.some((r) => r.status === "error" || r.status === "login_required");
    // The plan runs the inbox, then the backup, as part of every full sync.
    const imported = connectionId ? [] : await processInbox(ctx.deps);
    printOutcomes(imported, false);
    const backup = connectionId ? null : await backupAndReport(ctx);
    if (scheduled) {
      for (const r of results) {
        if (r.status === "login_required") await notify(`${r.institution} needs you to sign in again. Open Finance Hub, Accounts.`);
        else if (r.status === "error") await notify(`${r.institution} didn't sync (${r.errorCode ?? "error"}). It tries again tomorrow.`);
      }
      const waiting = imported.filter((o) => o.status !== "imported" && o.status !== "duplicate").length;
      if (waiting) await notify(`${waiting} file${waiting === 1 ? "" : "s"} in the inbox need${waiting === 1 ? "s" : ""} you. Open Finance Hub, Accounts.`);
      if (backup?.icloudError) await notify(`The iCloud backup copy failed: ${backup.icloudError}`);
      for (const c of await expiringConsents(ctx)) {
        await notify(`${c.institution_name}'s Plaid access expires ${c.consent_expires_at.slice(0, 10)}. Reconnect it in Finance Hub before then.`);
      }
    }
    return failed || imported.some(importFailed) || backup?.icloudError ? 1 : 0;
  } catch (err) {
    if (scheduled) await notify(`The daily sync failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    ctx.close();
  }
}

/** Connections whose Plaid consent ends within two weeks. */
async function expiringConsents(ctx: AppContext) {
  const soon = new Date(Date.now() + 14 * 86_400_000).toISOString();
  return ctx.deps.db.all<{ institution_name: string; consent_expires_at: string }>(
    `SELECT institution_name, consent_expires_at FROM connections
     WHERE source = 'plaid' AND status != 'removed' AND consent_expires_at IS NOT NULL AND consent_expires_at <= ?`,
    [soon],
  );
}

async function backupAndReport(ctx: AppContext): Promise<BackupResult> {
  const result = await runBackup(ctx.deps, ctx.paths);
  console.log(`Backup: ${result.local}`);
  if (result.icloud) {
    const extra = [
      result.icloud.rawCopied && `${result.icloud.rawCopied} new raw files`,
      result.icloud.importedCopied && `${result.icloud.importedCopied} new imported files`,
    ].filter(Boolean);
    console.log(`Copied to ${result.icloud.dir}${extra.length ? ` (${extra.join(", ")})` : ""}`);
  } else {
    console.log(`The iCloud copy failed: ${result.icloudError}`);
  }
  return result;
}

async function categorizeCommand(): Promise<number> {
  const ctx = await openContext();
  try {
    const r = await settle(ctx.deps);
    console.log(
      `${r.changed} transactions changed, ${r.pairs_made} transfer pairs made, ${r.pairs_dissolved} dropped, ` +
        `${r.merchants_created} new merchants. ${r.queued} waiting in Review.`,
    );
    const rows = await ctx.deps.db.all<{ source: string; n: number }>(
      `SELECT COALESCE(category_source, 'uncategorized') AS source, COUNT(*) AS n FROM transactions
       WHERE removed_at IS NULL AND is_split_parent = 0 GROUP BY 1 ORDER BY n DESC`,
    );
    console.log(rows.map((x) => `${x.source} ${x.n}`).join(", "));
    return 0;
  } finally {
    ctx.close();
  }
}

async function backupCommand(): Promise<number> {
  const ctx = await openContext();
  try {
    const result = await backupAndReport(ctx);
    return result.icloudError ? 1 : 0;
  } finally {
    ctx.close();
  }
}

/** Is something listening on the dashboard's port? */
function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function restoreCommand(file: string | undefined, yes: boolean): Promise<number> {
  if (!file) {
    console.error("Give the backup file to restore, e.g. fh restore <data>/backups/finance-2026-11-14.db");
    return 2;
  }
  if (await portInUse(DEFAULT_PORT)) {
    console.error(`Something is running on port ${DEFAULT_PORT}. Stop "fh serve" first.`);
    return 1;
  }
  const ctx = await openContext();
  const paths = ctx.paths;
  ctx.close();
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("Add --yes to restore without a prompt.");
      return 2;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Replace ${paths.db} with ${resolve(file)}? The current database is kept as finance.db.before-restore. Type "restore" to go ahead: `,
    );
    rl.close();
    if (answer.trim() !== "restore") {
      console.log("Nothing changed.");
      return 1;
    }
  }
  const result = await restoreDatabase(paths, file, new Date());
  console.log(`Restored from ${result.restoredFrom}`);
  if (result.keptAs) console.log(`The replaced database is at ${result.keptAs}`);
  return 0;
}

async function replayCommand(out: string | undefined): Promise<number> {
  const ctx = await openContext();
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = out ?? join(ctx.paths.root, "replay", `replay-${stamp}.db`);
    const report = await replayToFile(ctx.paths, ctx.deps.db, target);
    if (report.connections.length === 0) {
      console.log("The raw archive is empty: nothing to replay.");
      return 0;
    }
    for (const c of report.connections) {
      console.log(`${c.connectionId}: ${c.runs} archived syncs, ${c.applied} applied, ${c.skipped} that failed live too`);
    }
    console.log("\nPlaid transactions per account (live / replay):");
    for (const a of report.accounts) {
      const money = (n: number) => (n / 100).toFixed(2);
      console.log(
        `  ${a.matches ? "ok  " : "DIFF"}  ${a.name}: ${a.live.count} / ${a.replay.count} transactions, ` +
          `${money(a.live.sum)} / ${money(a.replay.sum)}`,
      );
    }
    console.log(`\nReplayed database: ${report.out}`);
    console.log("Categories, notes, rules and file imports aren't in the raw archive. The database backups cover those.");
    return report.accounts.every((a) => a.matches) ? 0 : 1;
  } finally {
    ctx.close();
  }
}

async function installCommand(printOnly: boolean): Promise<number> {
  const ctx = await openContext();
  const options = defaultPlistOptions(join(ctx.paths.logs, "sync.log"));
  ctx.close();
  if (printOnly) {
    console.log(plistFor(options));
    return 0;
  }
  await installSchedule(options);
  const time = `${String(SYNC_HOUR).padStart(2, "0")}:${String(SYNC_MINUTE).padStart(2, "0")}`;
  console.log(`Installed ${PLIST}`);
  console.log(`"fh sync" now runs every day at ${time}, or when the Mac wakes if it was asleep then.`);
  console.log(`Log: ${options.log}`);
  console.log('The job runs through /bin/bash, which needs Full Disk Access for the iCloud backup copy.');
  await notify("The daily sync is installed. Notifications like this one tell you when something needs you.");
  return 0;
}

async function uninstallCommand(): Promise<number> {
  const removed = await uninstallSchedule();
  console.log(removed ? "The daily sync is off. Data and backups were not touched." : "The daily sync wasn't installed.");
  return 0;
}

async function importCommand(): Promise<number> {
  const ctx = await openContext();
  try {
    const outcomes = await processInbox(ctx.deps);
    printOutcomes(outcomes, true);
    return outcomes.some(importFailed) ? 1 : 0;
  } finally {
    ctx.close();
  }
}

const importFailed = (o: ImportOutcome) => o.status === "error" || o.status === "unknown";

function printOutcomes(outcomes: ImportOutcome[], sayWhenEmpty: boolean): void {
  if (outcomes.length === 0 && sayWhenEmpty) console.log(`The inbox is empty.`);
  for (const o of outcomes) {
    switch (o.status) {
      case "imported":
        console.log(
          `${o.file}: imported ${o.rows_added} of ${o.rows_total} rows` +
            (o.rows_skipped ? ` (${o.rows_skipped} on or after Plaid's first date skipped)` : "") +
            ` into ${o.accounts.map((a) => a.name).join(", ")}`,
        );
        break;
      case "duplicate":
        console.log(`${o.file}: already imported on ${new Date(o.imported_at).toLocaleDateString()}; moved out of the inbox`);
        break;
      case "needs_account":
        console.log(
          `${o.file}: pick the account in the dashboard (Accounts page) for ` +
            o.accounts.map((a) => `${a.institution} ${a.name ?? ""}${a.mask ? ` ending ${a.mask}` : ""}`.trim()).join(", "),
        );
        break;
      default:
        console.log(`${o.file}: ${o.message} (left in the inbox)`);
    }
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
