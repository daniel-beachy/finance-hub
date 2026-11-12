import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { AccountView, TransactionPage, TransactionView } from "../api.ts";
import { FlagIcon, SearchIcon } from "../components/icons.tsx";
import { Card, Empty, ErrorNote, PageHeader } from "../components/Shell.tsx";
import { accountLabel, Amount, CategorySelect, Marks, NoteField } from "../components/tx.tsx";
import { money, shortDate } from "../lib/format.ts";
import { useCategories, useCategorizeMany, useDebounced, useGet, useStatus, useUpdateTransaction } from "../lib/hooks.ts";

const PAGE = 50;
const FILTERS = ["q", "account_id", "category_id", "group_id", "kind", "merchant", "from", "to", "review"] as const;
const REVIEW_LABELS: Record<string, string> = {
  all: "Waiting for review",
  large: "Large or unusual",
  unfamiliar: "Unfamiliar",
  uncategorized: "Uncategorized",
  flagged: "Flagged",
};

export function Transactions() {
  const [params, setParams] = useSearchParams();
  const today = useStatus().data?.today;
  const categories = useCategories();
  const accounts = useGet<{ accounts: AccountView[] }>("/api/accounts").data?.accounts ?? [];
  const update = useUpdateTransaction();
  const bulk = useCategorizeMany();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
    next.delete("page");
    setParams(next, { replace: true });
  };

  // The search box is typed into freely and applied after a pause.
  const urlQ = params.get("q") ?? "";
  const [search, setSearch] = useState(urlQ);
  const debounced = useDebounced(search, 250);
  useEffect(() => setSearch(urlQ), [urlQ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: applies the settled text only
  useEffect(() => {
    if (debounced !== urlQ && debounced === search) set({ q: debounced || null });
  }, [debounced]);

  const page = Math.max(Number(params.get("page")) || 0, 0);
  const query = new URLSearchParams();
  for (const key of FILTERS) {
    const v = params.get(key);
    if (v) query.set(key, v);
  }
  const filterKey = query.toString();
  query.set("limit", String(PAGE));
  query.set("offset", String(page * PAGE));
  const { data, error } = useGet<TransactionPage>(`/api/transactions?${query}`);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter or page starts a new selection
  useEffect(() => setSelected(new Set()), [filterKey, page]);

  const rows = data?.rows ?? [];
  const pages = data ? Math.ceil(data.total / PAGE) : 0;
  const groupId = params.get("group_id");
  const chips = [
    groupId && { key: "group_id", text: categories.find((c) => c.group_id === groupId)?.group_name ?? "Group" },
    params.get("kind") && { key: "kind", text: params.get("kind") === "income" ? "Income" : "Spending" },
    params.get("merchant") && { key: "merchant", text: params.get("merchant") as string },
    params.get("review") && { key: "review", text: REVIEW_LABELS[params.get("review") as string] ?? "Review" },
  ].filter((c): c is { key: string; text: string } => Boolean(c));
  const filtered = filterKey !== "";
  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  return (
    <>
      <PageHeader
        title="Transactions"
        sub={
          data && (
            <>
              <span className="num">{data.total.toLocaleString()}</span> {data.total === 1 ? "transaction" : "transactions"}
              {filtered && data.total > 0 && (
                <>
                  {" · net "}
                  <span className="num text-ink">{money(data.sum_cents, { plus: true })}</span>
                </>
              )}
            </>
          )
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-2 md:flex md:flex-wrap">
        <label className="field col-span-2 flex items-center gap-2 md:w-64">
          <span className="text-faint">
            <SearchIcon />
          </span>
          <input
            className="w-full bg-transparent outline-none placeholder:text-faint"
            placeholder="Search merchant, note, category"
            aria-label="Search transactions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select className="field md:w-44" aria-label="Account" value={params.get("account_id") ?? ""} onChange={(e) => set({ account_id: e.target.value || null })}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.mask ? ` ··${a.mask}` : ""}
            </option>
          ))}
        </select>
        <div className="md:w-44">
          <CategorySelect
            value={params.get("category_id")}
            categories={categories}
            placeholder="All categories"
            label="Filter by category"
            className="!py-[5px] !text-ink"
            onChange={(id) => set({ category_id: id })}
          />
        </div>
        <input type="date" className="field" aria-label="From date" value={params.get("from") ?? ""} max={params.get("to") ?? undefined} onChange={(e) => set({ from: e.target.value || null })} />
        <input type="date" className="field" aria-label="To date" value={params.get("to") ?? ""} min={params.get("from") ?? undefined} onChange={(e) => set({ to: e.target.value || null })} />
        {filtered && (
          <button type="button" className="btn col-span-2 justify-center" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button key={c.key} type="button" className="chip cursor-pointer !text-ink" onClick={() => set({ [c.key]: null })} aria-label={`Remove filter: ${c.text}`}>
              {c.text} <span className="text-faint">×</span>
            </button>
          ))}
        </div>
      )}

      {error && <ErrorNote error={error} />}

      {selected.size > 0 && (
        <div className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent bg-panel px-4 py-2 shadow-lg">
          <span className="text-[13px]">
            <span className="num font-medium">{selected.size}</span> selected
          </span>
          <div className="w-52">
            <CategorySelect
              value={null}
              categories={categories}
              placeholder="Move to category…"
              label="Move selected to category"
              className="!text-ink"
              onChange={(id) => bulk.mutate({ ids: [...selected], category_id: id }, { onSuccess: () => setSelected(new Set()) })}
            />
          </div>
          <button type="button" className="btn" onClick={() => setSelected(new Set())}>
            Cancel
          </button>
        </div>
      )}

      <Card>
        {data && rows.length === 0 ? (
          <Empty>{filtered ? "No transactions match these filters." : "No transactions yet."}</Empty>
        ) : (
          <ul>
            <li className="hidden grid-cols-[18px_64px_minmax(0,1fr)_150px_184px_104px] items-center gap-x-3 px-4 py-2 md:grid">
              <input
                type="checkbox"
                aria-label="Select all on this page"
                className="accent-(--accent)"
                checked={rows.length > 0 && selected.size === rows.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
              />
              <span className="eyebrow">Date</span>
              <span className="eyebrow">Description</span>
              <span className="eyebrow">Account</span>
              <span className="eyebrow">Category</span>
              <span className="eyebrow text-right">Amount</span>
            </li>
            {rows.map((t) => (
              <Row
                key={t.id}
                tx={t}
                today={today}
                checked={selected.has(t.id)}
                onCheck={() => toggle(t.id)}
                open={open === t.id}
                onOpen={() => setOpen(open === t.id ? null : t.id)}
                categories={categories}
                onPatch={(patch) => update.mutate({ id: t.id, patch })}
              />
            ))}
          </ul>
        )}
      </Card>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-[13px] text-muted">
          <button type="button" className="btn" disabled={page === 0} onClick={() => go(page - 1)}>
            Newer
          </button>
          <span className="num">
            Page {page + 1} of {pages}
          </span>
          <button type="button" className="btn" disabled={page + 1 >= pages} onClick={() => go(page + 1)}>
            Older
          </button>
        </div>
      )}
    </>
  );

  function go(to: number) {
    const next = new URLSearchParams(params);
    to > 0 ? next.set("page", String(to)) : next.delete("page");
    setParams(next);
    window.scrollTo({ top: 0 });
  }
}

function Row({
  tx,
  today,
  checked,
  onCheck,
  open,
  onOpen,
  categories,
  onPatch,
}: {
  tx: TransactionView;
  today: string | undefined;
  checked: boolean;
  onCheck: () => void;
  open: boolean;
  onOpen: () => void;
  categories: ReturnType<typeof useCategories>;
  onPatch: (patch: Parameters<ReturnType<typeof useUpdateTransaction>["mutate"]>[0]["patch"]) => void;
}) {
  const flagged = tx.flag === "suspicious" || tx.flag === "disputed";
  return (
    <li
      className={`grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-line-soft px-4 py-2 md:grid-cols-[18px_64px_minmax(0,1fr)_150px_184px_104px] ${checked ? "bg-accent-wash" : ""}`}
    >
      <input type="checkbox" className="accent-(--accent)" aria-label={`Select ${tx.label}`} checked={checked} onChange={onCheck} />
      <span className="num hidden text-[13px] text-muted md:block">{shortDate(tx.posted_date, today)}</span>
      <button type="button" className="min-w-0 cursor-pointer text-left" onClick={onOpen} aria-expanded={open}>
        <span className="block truncate">
          {tx.label} <Marks tx={tx} />
        </span>
        {tx.note && <span className="block truncate text-xs text-muted">{tx.note}</span>}
      </button>
      <span className="hidden truncate text-[13px] text-muted md:block">{accountLabel(tx)}</span>
      <div className="col-start-2 row-start-2 flex items-center gap-2 md:col-start-auto md:row-start-auto">
        <span className="num shrink-0 text-xs text-faint md:hidden">{shortDate(tx.posted_date, today)}</span>
        <CategorySelect value={tx.category_id} categories={categories} label={`Category for ${tx.label}`} onChange={(id) => onPatch({ category_id: id })} />
      </div>
      <Amount cents={tx.amount_cents} className="col-start-3 row-start-1 text-right md:col-start-auto md:row-start-auto" />
      {open && (
        <div className="col-span-full mt-1 mb-1 grid gap-2 rounded-md bg-raised p-3 md:col-start-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <NoteField value={tx.note} onSave={(note) => onPatch({ note })} />
          <button type="button" className="btn justify-center" onClick={() => onPatch(flagged ? { flag: "resolved" } : { flag: "suspicious" })}>
            <FlagIcon /> {flagged ? "Mark resolved" : "Flag as suspicious"}
          </button>
          <p className="text-xs text-muted md:col-span-2">
            {tx.description_raw} · {accountLabel(tx)}
            {tx.category_source && ` · categorized by ${tx.category_source === "manual" ? "you" : tx.category_source}`}
          </p>
        </div>
      )}
    </li>
  );
}
