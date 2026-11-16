import type { RawArchiveEntry } from "../archive.ts";
import { first } from "../db/driver.ts";
import type { CoreDeps } from "../deps.ts";
import {
  type HoldingsResponse,
  type InvestmentTransactionsResponse,
  type PlaidAccount,
  PlaidError,
  type PlaidItem,
  type TransactionsSyncResponse,
} from "../plaid/client.ts";
import { DAYS_REQUESTED } from "../plaid/client.ts";
import type { PlaidEnv } from "../secrets.ts";
import { type PlaidSource, runRecordedSync, type SyncResult } from "./sync.ts";

/** A recorded answer is missing, so this run can't be replayed (the live sync failed here too). */
export class ReplayGap extends Error {
  constructor(endpoint: string) {
    super(`The archive has no ${endpoint} answer for this step`);
    this.name = "ReplayGap";
  }
}

/**
 * Split one connection's archive into sync runs. Every live sync starts with
 * /item/get, so each /item/get entry opens a new run. Entries must already be
 * in the order they were written.
 */
export function splitRuns(entries: RawArchiveEntry[]): RawArchiveEntry[][] {
  const runs: RawArchiveEntry[][] = [];
  for (const entry of entries) {
    if (entry.endpoint === "/item/get" || runs.length === 0) runs.push([]);
    runs[runs.length - 1]!.push(entry);
  }
  return runs;
}

/**
 * Answer a sync's questions from one recorded run. When a request was made
 * more than once in the run (a pagination restart), the latest answer wins,
 * because that is the one the live sync went on to apply.
 */
function recordedSource(run: RawArchiveEntry[]): PlaidSource {
  const latest = (endpoint: string, matches: (request: Record<string, unknown>) => boolean = () => true) => {
    const found = run.filter((e) => e.endpoint === endpoint && matches(e.request ?? {})).at(-1);
    if (!found) throw new ReplayGap(endpoint);
    if (found.error) throw new PlaidError(endpoint, found.error.status, found.error);
    return found.response;
  };
  return {
    itemGet: async () => latest("/item/get") as { item: PlaidItem },
    accountsGet: async () => latest("/accounts/get") as { accounts: PlaidAccount[] },
    transactionsSync: async (cursor) =>
      latest("/transactions/sync", (r) => (r.cursor ?? null) === cursor) as TransactionsSyncResponse,
    investmentsHoldingsGet: async () => latest("/investments/holdings/get") as HoldingsResponse,
    investmentsTransactionsGet: async (_start, _end, offset) =>
      latest("/investments/transactions/get", (r) => (r.offset ?? 0) === offset) as InvestmentTransactionsResponse,
  };
}

export interface ReplaySummary {
  connectionId: string;
  runs: number;
  applied: number;
  skipped: number;
  results: SyncResult[];
}

/**
 * Rebuild one connection from its raw archive, run by run, through the same
 * code a live sync uses. The clock is set to each run's own time, so balances
 * and holdings land on the dates they were fetched. Never touches the network
 * or the secret store.
 */
export async function replayConnection(
  deps: CoreDeps,
  connectionId: string,
  entries: RawArchiveEntry[],
  meta: { institutionName?: string | null; createdAt?: string | null } = {},
): Promise<ReplaySummary> {
  const runs = splitRuns(entries);
  const summary: ReplaySummary = { connectionId, runs: runs.length, applied: 0, skipped: 0, results: [] };
  if (runs.length === 0) return summary;

  const firstItem = entries.find((e) => e.endpoint === "/item/get" && !e.error)?.response as
    | { item: PlaidItem }
    | undefined;
  const exists = await first(deps.db, "SELECT id FROM connections WHERE id = ?", [connectionId]);
  if (!exists) {
    await deps.db.run(
      `INSERT INTO connections (id, source, plaid_env, institution_id, institution_name, plaid_item_id,
         days_requested, status, created_at)
       VALUES (?, 'plaid', ?, ?, ?, ?, ?, 'ok', ?)`,
      [
        connectionId,
        entries[0]!.env as PlaidEnv,
        firstItem?.item.institution_id ?? null,
        meta.institutionName ?? firstItem?.item.institution_name ?? firstItem?.item.institution_id ?? "Replayed connection",
        firstItem?.item.item_id ?? null,
        DAYS_REQUESTED,
        meta.createdAt ?? entries[0]!.fetchedAt,
      ],
    );
  }

  for (const run of runs) {
    const at = Date.parse(run[0]!.fetchedAt);
    let tick = 0;
    // Each step a millisecond later, so timestamps keep their order within a run.
    const runDeps: CoreDeps = { ...deps, now: () => new Date(at + tick++) };
    const result = await runRecordedSync(runDeps, connectionId, recordedSource(run));
    summary.results.push(result);
    if (result.status === "ok") summary.applied++;
    else summary.skipped++;
  }
  return summary;
}
