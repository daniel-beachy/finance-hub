import { useState } from "react";
import { Link } from "react-router";
import type { AccountView, RuleView } from "../api.ts";
import { describeMatch, RuleEditor } from "../components/rules.tsx";
import { Card, Empty, ErrorNote, PageHeader } from "../components/Shell.tsx";
import { useCategories, useGet, useRuleEdit } from "../lib/hooks.ts";

const ORIGIN: Record<string, string> = { seed: "Built in", user: "You", claude: "Claude" };

/**
 * Rules run before merchant memory and Plaid's category, lowest priority
 * first. They never touch a transaction set by hand.
 */
export function Rules() {
  const { data, error } = useGet<{ rules: RuleView[] }>("/api/rules");
  const accounts = useGet<{ accounts: AccountView[] }>("/api/accounts").data?.accounts ?? [];
  const categories = useCategories();
  const edit = useRuleEdit();
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const rules = data?.rules ?? [];
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name;
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rules.filter((r) => `${describeMatch(r.match, accountName)} ${r.category_name ?? ""}`.toLowerCase().includes(needle))
    : rules;

  return (
    <>
      <PageHeader
        title="Rules"
        sub={
          data && (
            <>
              <span className="num">{rules.length}</span> {rules.length === 1 ? "rule" : "rules"} · tried in order, the first match sets the category. Nothing you set by hand is
              touched.
            </>
          )
        }
      >
        <button type="button" className="btn btn-primary" onClick={() => setEditing(editing === "new" ? null : "new")}>
          New rule
        </button>
      </PageHeader>

      {error && <ErrorNote error={error} />}

      {editing === "new" && (
        <Card title="New rule" className="mb-4">
          <div className="p-4">
            <RuleEditor initialMatch={{}} initialCategory={null} categories={categories} onDone={() => setEditing(null)} />
          </div>
        </Card>
      )}

      {rules.length > 6 && (
        <input className="field mb-3 w-full md:w-72" placeholder="Filter rules" aria-label="Filter rules" value={q} onChange={(e) => setQ(e.target.value)} />
      )}

      <Card>
        {data && shown.length === 0 ? (
          <Empty>
            {rules.length === 0 ? (
              <>
                No rules yet. Make one from any transaction: open it on the <Link className="underline underline-offset-2" to="/transactions">Transactions</Link> page and choose “Make this a rule”.
              </>
            ) : (
              "No rules match."
            )}
          </Empty>
        ) : (
          <ul>
            <li className="hidden grid-cols-[44px_minmax(0,1fr)_170px_64px_70px_150px] items-center gap-x-3 px-4 py-2 md:grid">
              <span className="eyebrow">Order</span>
              <span className="eyebrow">When</span>
              <span className="eyebrow">Category</span>
              <span className="eyebrow text-right">Hits</span>
              <span className="eyebrow">By</span>
              <span className="eyebrow text-right">Actions</span>
            </li>
            {shown.map((r) => (
              <li key={r.id} className={`border-t border-line-soft px-4 py-2.5 ${r.enabled ? "" : "text-muted"}`}>
                <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1 md:grid-cols-[44px_minmax(0,1fr)_170px_64px_70px_150px]">
                  <span className="num hidden text-[13px] text-muted md:block">{r.priority}</span>
                  <span className="min-w-0">
                    <span className="block break-words">{describeMatch(r.match, accountName)}</span>
                    {!r.enabled && <span className="chip mt-0.5">Off</span>}
                  </span>
                  <span className="truncate text-[13px] text-muted md:text-ink">
                    → {r.category_name ?? r.actions.category_id}
                    <span className="md:hidden">
                      {" "}
                      · <span className="num">{r.hit_count}</span> hits · {ORIGIN[r.origin]}
                    </span>
                  </span>
                  <Link
                    className="num hidden text-right text-[13px] underline-offset-2 hover:underline md:block"
                    to={r.match.merchant_key ? `/transactions?q=${encodeURIComponent(r.match.merchant_key)}` : "/transactions"}
                  >
                    {r.hit_count.toLocaleString()}
                  </Link>
                  <span className="hidden text-[13px] text-muted md:block">{ORIGIN[r.origin] ?? r.origin}</span>
                  <div className="mt-1 flex gap-1.5 md:mt-0 md:justify-end">
                    <button type="button" className="btn !px-2 !py-1 text-xs" onClick={() => setEditing(editing === r.id ? null : r.id)} aria-expanded={editing === r.id}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn !px-2 !py-1 text-xs"
                      disabled={edit.isPending}
                      onClick={() => edit.mutate({ id: r.id, body: { enabled: !r.enabled }, message: r.enabled ? "Rule turned off" : "Rule turned on" })}
                    >
                      {r.enabled ? "Turn off" : "Turn on"}
                    </button>
                    <button
                      type="button"
                      className="btn !px-2 !py-1 text-xs"
                      disabled={edit.isPending}
                      aria-label={`Delete rule: ${describeMatch(r.match, accountName)}`}
                      onClick={() => edit.mutate({ id: r.id, remove: true, message: "Rule deleted" })}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {editing === r.id && (
                  <div className="mt-2 rounded-md bg-raised p-3">
                    <RuleEditor
                      ruleId={r.id}
                      initialMatch={r.match}
                      initialCategory={r.actions.category_id}
                      initialPriority={r.priority}
                      categories={categories}
                      onDone={() => setEditing(null)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">Turning a rule off or deleting it sends its transactions back through merchant memory and Plaid’s category. Every change can be undone.</p>
    </>
  );
}
