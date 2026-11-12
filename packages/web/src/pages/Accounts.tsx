import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { type AccountView, api, type ConnectionView, DEMO, type SyncRunView } from "../api.ts";
import { Card, Empty, PageHeader } from "../components/Shell.tsx";
import { money, txLink } from "../lib/format.ts";
import { useGet, useStatus } from "../lib/hooks.ts";
import { openLink } from "../plaidLink.ts";

/** Linked institutions, their accounts and the sync log. Linking happens here. */
export function Accounts() {
  const client = useQueryClient();
  const status = useStatus().data;
  const connections = useGet<{ connections: ConnectionView[] }>("/api/connections").data?.connections;
  const accounts = useGet<{ accounts: AccountView[] }>("/api/accounts").data?.accounts ?? [];
  const runs = useGet<{ runs: SyncRunView[] }>("/api/sync-runs?limit=10").data?.runs ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const loose = accounts.filter((a) => !a.connection_id);

  async function run(label: string, work: () => Promise<string | undefined>) {
    setBusy(label);
    setMessage(null);
    try {
      const text = await work();
      if (text) setMessage({ kind: "ok", text });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      setBusy(null);
      await client.invalidateQueries();
    }
  }

  const link = (kind: "bank" | "investment") =>
    run(`link-${kind}`, async () => {
      const production = status?.plaid_env === "production";
      if (production) {
        const left = status.slot_limit - status.slots_used;
        const ok = window.confirm(
          `This uses 1 of your ${status.slot_limit} lifetime Plaid connections (${left} left). It cannot be undone or refunded. Continue?`,
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

  const reauthenticate = (connection: ConnectionView) =>
    run(`reauth-${connection.id}`, async () => {
      const { link_token } = await api<{ link_token: string }>("/api/connections/link-token", { connection_id: connection.id });
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
      return (
        `Synced ${results.length} connection${results.length === 1 ? "" : "s"}: ${added} new transactions` +
        (failed ? `, ${failed} ${failed === 1 ? "needs" : "need"} attention.` : ".")
      );
    });

  return (
    <>
      <PageHeader
        title="Accounts"
        sub={
          DEMO
            ? "Invented accounts. In the real app this page links banks through Plaid."
            : status && (
                <>
                  Plaid {status.plaid_env} · connections used{" "}
                  <span className="num text-ink">
                    {status.slots_used} of {status.slot_limit}
                  </span>
                </>
              )
        }
      >
        {!DEMO && (
          <>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => link("bank")}>
              Link a bank or card
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => link("investment")}>
              Link investments
            </button>
            <button type="button" className="btn btn-primary" disabled={busy !== null || !connections?.length} onClick={sync}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </button>
          </>
        )}
      </PageHeader>

      {message && (
        <p role="status" className={`mb-4 rounded-md border px-3 py-2 text-[13px] ${message.kind === "error" ? "border-alert bg-alert-wash" : "border-line bg-panel"}`}>
          {message.text}
        </p>
      )}
      {!message && busy && busy !== "sync" && (
        <p role="status" className="mb-4 text-[13px] text-muted">
          Opening Plaid. This can take a few seconds.
        </p>
      )}

      {connections && connections.length === 0 && loose.length === 0 && (
        <Card>
          <Empty>Nothing is linked yet. Link a bank to pull in its accounts and transactions.</Empty>
        </Card>
      )}

      <div className="grid gap-4">
        {(connections ?? []).map((c) => (
          <Card key={c.id}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
              <div>
                <h2 className="font-medium">
                  {c.institution_name}
                  {c.plaid_env === "sandbox" && <span className="chip ml-2">sandbox</span>}
                </h2>
                <p className="text-xs text-muted">
                  {c.status === "ok" ? "Connected" : c.status.replace("_", " ")}
                  {c.last_synced_at && ` · synced ${new Date(c.last_synced_at).toLocaleString()}`}
                </p>
              </div>
              {(c.status === "login_required" || c.status === "pending_disconnect") && !DEMO && (
                <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => reauthenticate(c)}>
                  Sign in again
                </button>
              )}
            </div>
            {c.status === "error" && c.last_error && <p className="bg-alert-wash px-4 py-2 text-[13px]">{c.last_error}</p>}
            <AccountList accounts={c.accounts} />
          </Card>
        ))}
        {loose.length > 0 && (
          <Card title="Other accounts">
            <AccountList accounts={loose} />
          </Card>
        )}
      </div>

      {runs.length > 0 && (
        <Card title="Recent syncs" className="mt-4">
          <div className="overflow-x-auto pt-1.5 pb-1.5">
            <table className="w-full text-left text-[13px]">
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="num whitespace-nowrap px-4 py-1.5 text-muted">{new Date(r.started_at).toLocaleString()}</td>
                    <td className="px-4 py-1.5">{r.institution_name}</td>
                    <td className="px-4 py-1.5">
                      {r.status === "ok" ? "OK" : <span className="chip border-alert bg-alert-wash text-ink">{r.error_code ?? r.status}</span>}
                    </td>
                    <td className="num px-4 py-1.5 text-right">{r.added} new</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function AccountList({ accounts }: { accounts: AccountView[] }) {
  return (
    <ul className="py-1.5">
      {accounts.map((a) => (
        <li key={a.id}>
          <Link to={txLink({ account_id: a.id })} className="flex items-baseline justify-between gap-4 px-4 py-1.5 hover:bg-raised">
            <span className="min-w-0 truncate">
              {a.name}
              {a.mask && <span className="text-faint"> ··{a.mask}</span>}
              <span className="ml-2 text-xs text-faint">
                {a.subtype ?? a.type} · {a.transaction_count.toLocaleString()} transactions
              </span>
            </span>
            <span className="num shrink-0">{money(a.current_cents)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
