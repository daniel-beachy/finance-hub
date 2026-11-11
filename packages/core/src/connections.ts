import { first } from "./db/driver.ts";
import { DEFAULT_OWNER_ID, getSetting } from "./db/seed.ts";
import type { CoreDeps } from "./deps.ts";
import { DAYS_REQUESTED, type LinkKind, type LinkTokenResponse } from "./plaid/client.ts";
import { type PlaidEnv, tokenNameForConnection } from "./secrets.ts";
import { plaidClientFor, type SyncResult, syncConnection } from "./sync/sync.ts";

/** Plaid's Trial plan allows this many production Items, ever. */
export const PLAID_SLOT_LIMIT = 10;

export class SlotConfirmationRequired extends Error {
  readonly slotsUsed: number;
  constructor(slotsUsed: number) {
    super(
      `Linking a real institution uses one of ${PLAID_SLOT_LIMIT} lifetime Plaid connections ` +
        `(${slotsUsed} used). Confirm to continue.`,
    );
    this.name = "SlotConfirmationRequired";
    this.slotsUsed = slotsUsed;
  }
}

export async function getPlaidEnv(deps: CoreDeps): Promise<PlaidEnv> {
  return getSetting<PlaidEnv>(deps.db, "plaid_env", "sandbox");
}

/**
 * Production Items ever created here, including disconnected ones: Plaid
 * never gives a slot back.
 */
export async function slotsUsed(deps: CoreDeps): Promise<number> {
  const row = await first<{ n: number }>(
    deps.db,
    "SELECT COUNT(*) AS n FROM connections WHERE source = 'plaid' AND plaid_env = 'production'",
  );
  return row?.n ?? 0;
}

export async function createLinkToken(
  deps: CoreDeps,
  opts: { kind?: LinkKind; connectionId?: string; hosted?: boolean },
): Promise<LinkTokenResponse & { mode: "new" | "update"; env: PlaidEnv }> {
  if (opts.connectionId) {
    // Update mode re-authenticates the existing Item and uses no new slot.
    const conn = await first<{ plaid_env: PlaidEnv }>(
      deps.db,
      "SELECT plaid_env FROM connections WHERE id = ? AND source = 'plaid'",
      [opts.connectionId],
    );
    if (!conn) throw new Error(`No Plaid connection with id ${opts.connectionId}`);
    const accessToken = await deps.secrets.get(tokenNameForConnection(opts.connectionId));
    if (!accessToken) throw new Error("The access token for this connection is missing from the secret store");
    const client = await plaidClientFor(deps, conn.plaid_env);
    const res = await client.linkTokenCreate({ userId: DEFAULT_OWNER_ID, accessToken, hosted: opts.hosted });
    return { ...res, mode: "update", env: conn.plaid_env };
  }
  const env = await getPlaidEnv(deps);
  const client = await plaidClientFor(deps, env);
  const res = await client.linkTokenCreate({
    userId: DEFAULT_OWNER_ID,
    kind: opts.kind ?? "bank",
    daysRequested: DAYS_REQUESTED,
    hosted: opts.hosted,
  });
  return { ...res, mode: "new", env };
}

export interface LinkResult {
  connectionId: string;
  sync: SyncResult;
}

/**
 * Turn a Link public token into a connection. In production this spends a
 * lifetime slot, so the caller must pass `confirmSlot`.
 */
export async function completeLink(
  deps: CoreDeps,
  input: {
    publicToken: string;
    institution?: { id?: string | null; name?: string | null };
    confirmSlot?: boolean;
  },
): Promise<LinkResult> {
  const env = await getPlaidEnv(deps);
  if (env === "production") {
    const used = await slotsUsed(deps);
    if (used >= PLAID_SLOT_LIMIT) throw new Error(`All ${PLAID_SLOT_LIMIT} Plaid connections are used.`);
    if (!input.confirmSlot) throw new SlotConfirmationRequired(used);
  }
  const client = await plaidClientFor(deps, env);
  const connectionId = deps.newId();
  const exchanged = await client.publicTokenExchange(input.publicToken);
  // Store the token before anything else can fail. The Item now exists on
  // Plaid's side and the token is the only way to reach it.
  await deps.secrets.set(tokenNameForConnection(connectionId), exchanged.access_token);
  await deps.db.run(
    `INSERT INTO connections (id, source, plaid_env, institution_id, institution_name, plaid_item_id,
       days_requested, status, created_at)
     VALUES (?, 'plaid', ?, ?, ?, ?, ?, 'ok', ?)`,
    [
      connectionId,
      env,
      input.institution?.id ?? null,
      input.institution?.name ?? "Unknown institution",
      exchanged.item_id,
      DAYS_REQUESTED,
      deps.now().toISOString(),
    ],
  );
  const sync = await syncConnection(deps, connectionId, "manual");
  return { connectionId, sync };
}

/**
 * Stop syncing a connection. Deliberately does not call Plaid's /item/remove
 * and keeps the access token: a removed Item is a slot lost for nothing.
 */
export async function disconnect(deps: CoreDeps, connectionId: string): Promise<void> {
  await deps.db.run("UPDATE connections SET status = 'removed' WHERE id = ?", [connectionId]);
}

export async function reconnect(deps: CoreDeps, connectionId: string): Promise<SyncResult> {
  await deps.db.run("UPDATE connections SET status = 'ok', last_error = NULL WHERE id = ?", [connectionId]);
  return syncConnection(deps, connectionId, "manual");
}
