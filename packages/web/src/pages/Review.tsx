import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ReviewCounts, ReviewItem } from "../api.ts";
import { CheckIcon, FlagIcon } from "../components/icons.tsx";
import { Card, Empty, ErrorNote, PageHeader } from "../components/Shell.tsx";
import { accountLabel, Amount, CategorySelect, Marks, NoteField } from "../components/tx.tsx";
import { money, shortDate, txLink } from "../lib/format.ts";
import { type TransactionPatch, useCategories, useGet, useStatus, useUpdateTransaction } from "../lib/hooks.ts";

const TABS: { key: keyof ReviewCounts; label: string }[] = [
  { key: "all", label: "All" },
  { key: "large", label: "Large" },
  { key: "unfamiliar", label: "Unfamiliar" },
  { key: "uncategorized", label: "Uncategorized" },
  { key: "flagged", label: "Flagged" },
];

const KEYS: [string, string][] = [
  ["j k", "move"],
  ["e", "looks right"],
  ["c", "category"],
  ["n", "note"],
  ["f", "flag"],
  ["d", "disputed"],
  ["r", "resolved"],
];

export function Review() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get("tab"))?.key ?? "all";
  const { data, error } = useGet<{ counts: ReviewCounts; items: ReviewItem[] }>(`/api/review?tab=${tab}`);
  const today = useStatus().data?.today;
  const categories = useCategories();
  const update = useUpdateTransaction();
  const [index, setIndex] = useState(0);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);

  const items = data?.items ?? [];
  const at = Math.min(index, Math.max(items.length - 1, 0));
  const current = items[at];
  const flagged = current?.transaction.flag === "suspicious" || current?.transaction.flag === "disputed";

  const patch = (p: TransactionPatch) => current && update.mutate({ id: current.transaction.id, patch: p });
  const actions = {
    confirm: () => patch(flagged ? { flag: "resolved", reviewed: true } : { reviewed: true }),
    flag: () => patch({ flag: "suspicious" }),
    dispute: () => patch({ flag: "disputed" }),
    resolve: () => patch({ flag: "resolved", reviewed: true }),
  };
  const live = useRef({ actions, count: items.length });
  live.current = { actions, count: items.length };

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new tab starts at the top
  useEffect(() => setIndex(0), [tab]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the selection
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) {
        if (e.key === "Escape") el.blur();
        return;
      }
      const { actions: act, count } = live.current;
      const handlers: Record<string, () => void> = {
        j: () => setIndex((i) => Math.min(i + 1, count - 1)),
        k: () => setIndex((i) => Math.max(Math.min(i, count - 1) - 1, 0)),
        e: act.confirm,
        c: () => categoryRef.current?.focus(),
        n: () => noteRef.current?.focus(),
        f: act.flag,
        d: act.dispute,
        r: act.resolve,
      };
      const alias: Record<string, string> = { ArrowDown: "j", ArrowUp: "k", Enter: "e" };
      const run = handlers[alias[e.key] ?? e.key];
      if (!run || (e.key === "Enter" && el.tagName === "BUTTON")) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <PageHeader title="Review" sub="Large, unfamiliar and uncategorized charges wait here until you've had a look." />

      <div className="mb-3 flex gap-1 overflow-x-auto" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams(t.key === "all" ? {} : { tab: t.key }, { replace: true })}
            className={`btn ${tab === t.key ? "!border-accent bg-accent-wash text-accent" : "text-muted"}`}
          >
            {t.label}
            <span className="num text-xs opacity-80">{data?.counts[t.key] ?? ""}</span>
          </button>
        ))}
      </div>

      <p className="mb-3 hidden flex-wrap gap-x-4 gap-y-1 text-xs text-muted md:flex">
        {KEYS.map(([key, what]) => (
          <span key={key}>
            {key.split(" ").map((k) => (
              <kbd key={k} className="kbd mr-1">
                {k}
              </kbd>
            ))}
            {what}
          </span>
        ))}
      </p>

      {error && <ErrorNote error={error} />}

      <Card>
        {data && items.length === 0 ? (
          <Empty>{tab === "all" ? "All clear. Nothing is waiting for a look." : "Nothing in this tab."}</Empty>
        ) : (
          <ul>
            {items.map(({ transaction: t, history }, i) => {
              const active = i === at;
              const isFlagged = t.flag === "suspicious" || t.flag === "disputed";
              return (
                <li
                  key={t.id}
                  ref={active ? currentRef : undefined}
                  aria-current={active}
                  className={`border-line-soft border-t first:border-t-0 ${active ? "bg-raised shadow-[inset_3px_0_0_var(--accent)]" : ""}`}
                >
                  <button type="button" className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left" onClick={() => setIndex(i)}>
                    <span className="num w-12 shrink-0 text-xs text-faint">{shortDate(t.posted_date, today)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{t.label}</span>
                      {t.note && <span className="block truncate text-xs text-muted">{t.note}</span>}
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        <Marks tx={t} reasons />
                      </span>
                    </span>
                    <span className="hidden w-36 truncate text-[13px] text-muted sm:block">{t.category_name ?? "Uncategorized"}</span>
                    <Amount cents={t.amount_cents} className="w-24 shrink-0 text-right" />
                  </button>

                  {active && (
                    <div className="grid gap-3 px-4 pb-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:pl-[76px]">
                      <div className="text-[13px] text-muted">
                        <p>
                          {accountLabel(t)} · {t.description_raw}
                        </p>
                        <p className="mt-1.5 text-ink">
                          {history.count === 0 ? (
                            "First charge from this merchant."
                          ) : (
                            <>
                              <Link className="underline decoration-line underline-offset-2" to={txLink({ merchant: t.label })}>
                                {history.count} earlier {history.count === 1 ? "charge" : "charges"}
                              </Link>
                              {history.first_date && ` since ${shortDate(history.first_date, today)}`}
                              {history.median_cents !== null && `, typically ${money(Math.abs(history.median_cents))}`}.
                            </>
                          )}
                        </p>
                        {history.recent.length > 0 && (
                          <ul className="mt-1.5">
                            {history.recent.map((r) => (
                              <li key={r.id} className="flex justify-between gap-3 py-0.5 text-xs">
                                <span className="num">{shortDate(r.posted_date, today)}</span>
                                <span className="min-w-0 flex-1 truncate">{r.category_name ?? "Uncategorized"}</span>
                                <Amount cents={r.amount_cents} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="grid content-start gap-2">
                        <CategorySelect ref={categoryRef} value={t.category_id} categories={categories} onChange={(id) => patch({ category_id: id })} />
                        <NoteField ref={noteRef} value={t.note} onSave={(note) => patch({ note })} />
                        <div className="flex flex-wrap gap-2">
                          {isFlagged ? (
                            <button type="button" className="btn btn-primary" onClick={actions.resolve}>
                              <CheckIcon /> Resolved
                            </button>
                          ) : (
                            <button type="button" className="btn btn-primary" onClick={actions.confirm}>
                              <CheckIcon /> Looks right
                            </button>
                          )}
                          {t.flag !== "suspicious" && (
                            <button type="button" className="btn" onClick={actions.flag}>
                              <FlagIcon /> Flag
                            </button>
                          )}
                          {t.flag !== "disputed" && (
                            <button type="button" className="btn" onClick={actions.dispute}>
                              Disputed
                            </button>
                          )}
                        </div>
                        {isFlagged && <p className="text-xs text-muted">Flagged charges stay here until you mark them resolved.</p>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
