import { useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useRef, useState } from "react";
import { type AccountView, api, type ImportOutcome, type ImportStatus, type InboxEntry, type UnmatchedAccount, uploadFiles } from "../api.ts";
import { localDay, shortDate } from "../lib/format.ts";
import { useGet, useStatus } from "../lib/hooks.ts";
import { Card } from "./Shell.tsx";

const TYPES: [UnmatchedAccount["type"], string][] = [
  ["depository", "Checking or savings"],
  ["credit", "Credit card"],
  ["investment", "Investment"],
  ["loan", "Loan"],
  ["other", "Other"],
];

/** One line per file, in words. */
export function describeOutcome(o: ImportOutcome): string {
  switch (o.status) {
    case "imported":
      return (
        `Imported ${o.rows_added} of ${o.rows_total} rows into ${o.accounts.map((a) => a.name).join(", ")}` +
        (o.rows_skipped ? `. ${o.rows_skipped} on or after Plaid's first date were left to Plaid.` : ".") +
        (o.rows_added === 0 && !o.rows_skipped ? " Everything in it was already here." : "")
      );
    case "duplicate":
      return `Already imported on ${new Date(o.imported_at).toLocaleDateString()}. Nothing added.`;
    case "needs_account":
      return "Pick the account below.";
    default:
      return o.message;
  }
}

/** Upload, the inbox and recent imports. Lives on the Accounts page. */
export function Imports({ accounts }: { accounts: AccountView[] }) {
  const client = useQueryClient();
  const { data } = useGet<ImportStatus>("/api/imports");
  const today = useStatus().data?.today;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [results, setResults] = useState<{ file: string; text: string; ok: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<{ outcomes: ImportOutcome[] }>) {
    setBusy(true);
    setError(null);
    try {
      const { outcomes } = await work();
      // Files that stay in the inbox are explained in the inbox list below.
      setResults(
        outcomes
          .filter((o) => o.status === "imported" || o.status === "duplicate")
          .map((o) => ({ file: o.file, text: describeOutcome(o), ok: true })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
      await client.invalidateQueries();
    }
  }

  const upload = (files: File[]) => files.length && run(() => uploadFiles("/api/imports/upload", files));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload([...e.dataTransfer.files]);
  };

  if (data && !data.available) return null;
  const inbox = data?.inbox ?? [];

  return (
    <Card title="Files" action="OFX or QFX from any bank, Fidelity CSV exports" className="mt-4">
      <div className="px-4 pt-3 pb-4">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the buttons inside are the keyboard path */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-wrap items-center justify-between gap-3 rounded-[9px] border border-dashed px-4 py-3.5 text-[13px] ${dragging ? "border-accent bg-accent-wash" : "border-line"}`}
        >
          <span className="text-muted">
            Drop files here, or put them in the inbox folder and import from there.
          </span>
          <span className="flex gap-2">
            <button type="button" className="btn" disabled={busy} onClick={() => run(() => api("/api/imports/process", {}))}>
              Import inbox
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? "Importing…" : "Choose files"}
            </button>
          </span>
          <input
            ref={input}
            type="file"
            multiple
            accept=".csv,.ofx,.qfx,text/csv"
            className="hidden"
            onChange={(e) => {
              void upload([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-md border border-alert bg-alert-wash px-3 py-2 text-[13px]">
            {error}
          </p>
        )}
        {results.length > 0 && (
          <ul role="status" className="mt-3 grid gap-1 text-[13px]">
            {results.map((r) => (
              <li key={r.file} className={`rounded-md border px-3 py-2 ${r.ok ? "border-line bg-panel" : "border-alert bg-alert-wash"}`}>
                <span className="font-medium">{r.file}</span> <span className="text-muted">{r.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {inbox.length > 0 && (
        <div className="border-t border-line-soft">
          <h3 className="eyebrow px-4 pt-3">Waiting in the inbox</h3>
          <ul className="pb-2">
            {inbox.map((entry) => (
              <InboxRow key={entry.file} entry={entry} accounts={accounts} disabled={busy} run={run} />
            ))}
          </ul>
        </div>
      )}

      {data && data.recent.length > 0 && (
        <div className="overflow-x-auto border-t border-line-soft pt-1.5 pb-1.5">
          <h3 className="eyebrow px-4 pt-2 pb-1">Imported</h3>
          <table className="w-full text-left text-[13px]">
            <tbody>
              {data.recent.map((f) => (
                <tr key={f.id}>
                  <td className="num whitespace-nowrap px-4 py-1.5 text-muted">{shortDate(localDay(f.imported_at), today)}</td>
                  <td className="max-w-[16rem] truncate px-4 py-1.5">{f.filename}</td>
                  <td className="px-4 py-1.5 text-muted">{f.account_name ?? "Several accounts"}</td>
                  <td className="num whitespace-nowrap px-4 py-1.5 text-right">
                    {f.rows_added} of {f.rows_total} new
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type Run = (work: () => Promise<{ outcomes: ImportOutcome[] }>) => Promise<void>;

function InboxRow({ entry, accounts, disabled, run }: { entry: InboxEntry; accounts: AccountView[]; disabled: boolean; run: Run }) {
  const discard = () =>
    window.confirm(`Delete ${entry.file} from the inbox? The file itself is removed.`) &&
    run(async () => {
      await api("/api/imports/discard", { name: entry.file });
      return { outcomes: [] };
    });
  return (
    <li className="border-line-soft border-t px-4 py-2.5 text-[13px] first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{entry.file}</span>
        {(entry.status === "unknown" || entry.status === "error") && (
          <button type="button" className="btn !py-0.5 text-xs" disabled={disabled} onClick={discard}>
            Discard
          </button>
        )}
      </div>
      {entry.status === "ready" && (
        <p className="text-muted">Ready: {entry.accounts.map((a) => `${a.rows} rows into ${a.name}`).join(", ")}. Press Import inbox.</p>
      )}
      {(entry.status === "unknown" || entry.status === "error") && <p className="text-muted">{entry.message}</p>}
      {entry.status === "needs_account" &&
        entry.accounts.map((u) => <AccountPicker key={u.key} unmatched={u} accounts={accounts} disabled={disabled} run={run} />)}
    </li>
  );
}

/** Pick which account a file's account is, once. The choice is remembered. */
function AccountPicker({ unmatched: u, accounts, disabled, run }: { unmatched: UnmatchedAccount; accounts: AccountView[]; disabled: boolean; run: Run }) {
  const sameType = accounts.filter((a) => a.type === u.type);
  const [target, setTarget] = useState("new");
  const [name, setName] = useState([u.institution, u.name ?? u.subtype].filter(Boolean).join(" "));
  const [type, setType] = useState(u.type);
  const [subtype, setSubtype] = useState(u.subtype ?? "");
  const label = [u.institution, u.name, u.mask && `ending ${u.mask}`].filter(Boolean).join(" · ");

  const save = () =>
    run(() =>
      api("/api/imports/assign", {
        key: u.key,
        ...(target === "new"
          ? { create: { name: name.trim(), type, subtype: subtype.trim() || null, institution: u.institution, mask: u.mask } }
          : { account_id: target }),
      }),
    );

  return (
    <div className="mt-2 grid gap-2 rounded-[9px] border border-line bg-raised p-3">
      <p>
        <span className="font-medium">{label}</span> <span className="text-muted">· {u.rows} rows. Which account is this?</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <select className="field" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Account">
          <option value="new">New account…</option>
          {(sameType.length ? sameType : accounts).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.mask ? ` ··${a.mask}` : ""} ({a.feed === "plaid" ? "Plaid, older rows only" : a.feed})
            </option>
          ))}
        </select>
        {target === "new" && (
          <>
            <input className="field w-56" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" placeholder="Name" />
            <select className="field" value={type} onChange={(e) => setType(e.target.value as UnmatchedAccount["type"])} aria-label="Type">
              {TYPES.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
            <input className="field w-36" value={subtype} onChange={(e) => setSubtype(e.target.value)} aria-label="Kind" placeholder="e.g. roth, 401k" />
          </>
        )}
        <button type="button" className="btn btn-primary" disabled={disabled || (target === "new" && !name.trim())} onClick={save}>
          Import
        </button>
      </div>
    </div>
  );
}
