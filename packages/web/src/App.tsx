import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Connection, money, type Status, type SyncRun } from "./api.ts";
import { openLink } from "./plaidLink.ts";

/**
 * M1: a bare Accounts page. It links institutions through Plaid Link, shows
 * what synced, and re-authenticates a broken connection. The full dashboard
 * arrives in M5.
 */
export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const [s, c, r] = await Promise.all([
      api<Status>("/api/status"),
      api<{ connections: Connection[] }>("/api/connections"),
      api<{ runs: SyncRun[] }>("/api/sync-runs?limit=10"),
    ]);
    setStatus(s);
    setConnections(c.connections);
    setRuns(r.runs);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setMessage({ kind: "error", text: String(err.message ?? err) }));
  }, [refresh]);

  async function run(label: string, work: () => Promise<string | undefined>) {
    setBusy(label);
    setMessage(null);
    try {
      const text = await work();
      if (text) setMessage({ kind: "ok", text });
    } catch (err) {
      const text = err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong";
      setMessage({ kind: "error", text });
    } finally {
      setBusy(null);
      await refresh().catch(() => {});
    }
  }

  const link = (kind: "bank" | "investment") =>
    run(`link-${kind}`, async () => {
      const production = status?.plaid_env === "production";
      if (production) {
        const left = status.slot_limit - status.slots_used;
        const ok = window.confirm(
          `This uses 1 of your ${status.slot_limit} lifetime Plaid connections (${left} left). ` +
            "It cannot be undone or refunded. Continue?",
        );
        if (!ok) return undefined;
      }
      const { link_token } = await api<{ link_token: string }>("/api/connections/link-token", { kind });
      const outcome = await openLink(link_token);
      if (!outcome) return undefined;
      const result = await api<{ sync: { added: number } }>("/api/connections/exchange", {
        public_token: outcome.publicToken,
        institution: outcome.institution,
        confirm_slot: production,
      });
      return `Linked ${outcome.institution?.name ?? "institution"}. ${result.sync.added} transactions so far.`;
    });

  const reauthenticate = (connection: Connection) =>
    run(`reauth-${connection.id}`, async () => {
      const { link_token } = await api<{ link_token: string }>("/api/connections/link-token", {
        connection_id: connection.id,
      });
      const outcome = await openLink(link_token);
      if (!outcome) return undefined;
      await api(`/api/connections/${connection.id}/reconnect`, {});
      return `${connection.institution_name} is connected again.`;
    });

  const sync = () =>
    run("sync", async () => {
      const { results } = await api<{ results: { status: string; added: number }[] }>("/api/sync", {});
      const added = results.reduce((n, r) => n + r.added, 0);
      const failed = results.filter((r) => r.status !== "ok" && r.status !== "skipped").length;
      return `Synced ${results.length} connection${results.length === 1 ? "" : "s"}: ${added} new transactions` +
        (failed ? `, ${failed} ${failed === 1 ? "needs" : "need"} attention.` : ".");
    });

  const button =
    "rounded-md border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:border-accent disabled:opacity-50";

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Finance Hub</h1>
        {status && (
          <p className="text-sm text-muted">
            Plaid {status.plaid_env} · connections used{" "}
            <span className="num text-ink">
              {status.slots_used} of {status.slot_limit}
            </span>
          </p>
        )}
      </header>

      <section className="mt-6 flex flex-wrap gap-2" aria-label="Actions">
        <button type="button" className={button} disabled={busy !== null} onClick={() => link("bank")}>
          Link a bank or card
        </button>
        <button type="button" className={button} disabled={busy !== null} onClick={() => link("investment")}>
          Link an investment account
        </button>
        <button type="button" className={button} disabled={busy !== null || connections.length === 0} onClick={sync}>
          {busy === "sync" ? "Syncing…" : "Sync now"}
        </button>
      </section>

      {message && (
        <p
          role="status"
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            message.kind === "error" ? "border-warn text-warn" : "border-line text-ink"
          }`}
        >
          {message.text}
        </p>
      )}
      {!message && busy && busy !== "sync" && (
        <p role="status" className="mt-4 text-sm text-muted">
          Opening Plaid. This can take a few seconds.
        </p>
      )}

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Accounts</h2>
      {connections.length === 0 && (
        <p className="mt-3 text-sm text-muted">
          Nothing is linked yet. Link a bank to pull in its accounts and transactions.
        </p>
      )}
      {connections.map((c) => (
        <section key={c.id} className="mt-3 rounded-lg border border-line bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div>
              <h3 className="font-medium">
                {c.institution_name}
                {c.plaid_env === "sandbox" && <span className="ml-2 text-xs text-muted">sandbox</span>}
              </h3>
              <p className="text-xs text-muted">
                {c.status === "ok" ? "Connected" : c.status.replace("_", " ")}
                {c.last_synced_at && ` · synced ${new Date(c.last_synced_at).toLocaleString()}`}
              </p>
            </div>
            {(c.status === "login_required" || c.status === "pending_disconnect") && (
              <button type="button" className={button} disabled={busy !== null} onClick={() => reauthenticate(c)}>
                Sign in again
              </button>
            )}
          </div>
          {c.status === "error" && c.last_error && <p className="px-4 py-2 text-sm text-warn">{c.last_error}</p>}
          <ul>
            {c.accounts.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-4 px-4 py-2 text-sm">
                <span>
                  {a.name}
                  {a.mask && <span className="text-muted"> ··{a.mask}</span>}
                  <span className="ml-2 text-xs text-muted">
                    {a.subtype ?? a.type} · {a.transaction_count} transactions
                  </span>
                </span>
                <span className="num">{money(a.current_cents)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {runs.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Recent syncs</h2>
          <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-panel">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Institution</th>
                  <th className="px-4 py-2 font-medium">Result</th>
                  <th className="px-4 py-2 text-right font-medium">Added</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="num whitespace-nowrap px-4 py-2">{new Date(r.started_at).toLocaleString()}</td>
                    <td className="px-4 py-2">{r.institution_name}</td>
                    <td className={`px-4 py-2 ${r.status === "ok" ? "" : "text-warn"}`}>
                      {r.status === "ok" ? "OK" : (r.error_code ?? r.status)}
                    </td>
                    <td className="num px-4 py-2 text-right">{r.added}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
