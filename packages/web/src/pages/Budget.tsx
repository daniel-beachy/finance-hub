import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { BudgetLine, BudgetStatus } from "../api.ts";
import { ChevronLeft, ChevronRight } from "../components/icons.tsx";
import { Card, Empty, ErrorNote, PageHeader } from "../components/Shell.tsx";
import { money, monthEnd, monthLabel, percent, shiftMonth, txLink } from "../lib/format.ts";
import { useBudgetEdit, useCategories, useGet, useStatus } from "../lib/hooks.ts";

export function Budget() {
  const [params, setParams] = useSearchParams();
  const today = useStatus().data?.today;
  const month = params.get("m") ?? today?.slice(0, 7);
  if (!month || !today) return null;
  return <Month month={month} today={today} setMonth={(m) => setParams({ m }, { replace: true })} />;
}

/** Dollars typed by a person to cents, or null when it isn't a number. */
function parseDollars(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

function Month({ month, today, setMonth }: { month: string; today: string; setMonth: (m: string) => void }) {
  const { data, error } = useGet<BudgetStatus>(`/api/budgets?month=${month}`);
  const [editing, setEditing] = useState<string | null>(null);
  const current = today.slice(0, 7);
  const from = `${month}-01`;
  const to = month === current ? today : monthEnd(month);

  const lines = data?.lines ?? [];
  const budgeted = lines.filter((l) => l.budget_cents !== null);
  const outside = lines.filter((l) => l.budget_cents === null && l.spent_cents !== 0).sort((a, b) => b.spent_cents - a.spent_cents);
  const groups = new Map<string, { name: string; lines: BudgetLine[] }>();
  for (const l of budgeted) {
    const g = groups.get(l.group_id) ?? { name: l.group_name, lines: [] };
    g.lines.push(l);
    groups.set(l.group_id, g);
  }
  const t = data?.totals;
  const elapsed = data?.elapsed ?? 0;
  const pace = t ? t.budgeted_spent_cents - t.expected_by_now_cents : 0;

  return (
    <>
      <PageHeader
        title="Budget"
        sub={`${monthLabel(month)}${month === current ? ` · ${percent(elapsed)} of the month gone` : month > current ? " · planning ahead" : ""}`}
      >
        <div className="flex items-center gap-1">
          <button type="button" className="btn !px-1.5" aria-label="Earlier month" onClick={() => setMonth(shiftMonth(month, -1))}>
            <ChevronLeft />
          </button>
          {month !== current && (
            <button type="button" className="btn" onClick={() => setMonth(current)}>
              This month
            </button>
          )}
          <button type="button" className="btn !px-1.5" aria-label="Later month" disabled={month >= shiftMonth(current, 12)} onClick={() => setMonth(shiftMonth(month, 1))}>
            <ChevronRight />
          </button>
        </div>
      </PageHeader>

      {error && <ErrorNote error={error} />}

      {t && (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line md:grid-cols-4">
            <Stat name="Budgeted" value={t.available_cents} sub={t.carried_cents ? `${money(t.carried_cents, { whole: true, plus: true })} carried over` : null} />
            <Stat name="Spent" value={t.budgeted_spent_cents} to={txLink({ kind: "expense", from, to })} sub="in budgeted categories" />
            <Stat name={t.remaining_cents < 0 ? "Over" : "Left"} value={Math.abs(t.remaining_cents)} over={t.remaining_cents < 0} />
            <Stat name="Not budgeted" value={t.unbudgeted_spent_cents} sub={`${money(t.spent_cents, { whole: true })} spent in all`} />
          </div>

          {t.available_cents > 0 && (
            <Card className="mt-4">
              <div className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                  <span>
                    <span className="num font-medium">{money(t.budgeted_spent_cents, { whole: true })}</span>
                    <span className="text-muted"> of {money(t.available_cents, { whole: true })}</span>
                  </span>
                  {month === current && (
                    <span className="text-muted">
                      {Math.abs(pace) < 100 ? "Right on pace" : `${money(Math.abs(pace), { whole: true })} ${pace > 0 ? "ahead of" : "under"} an even pace`}
                    </span>
                  )}
                </div>
                <Meter spent={t.budgeted_spent_cents} available={t.available_cents} tick={month === current ? t.expected_by_now_cents : null} />
              </div>
            </Card>
          )}
        </>
      )}

      {data && budgeted.length === 0 && (
        <Card className="mt-4">
          <Empty>No budgets yet. Pick a category below to set one.</Empty>
        </Card>
      )}

      {[...groups.entries()].map(([id, g]) => (
        <Card key={id} title={g.name} className="mt-4">
          <ul className="pt-1 pb-1.5">
            {g.lines.map((l) => (
              <li key={l.category_id}>
                {editing === l.category_id ? (
                  <Editor line={l} month={month} onDone={() => setEditing(null)} />
                ) : (
                  <Row line={l} from={from} to={to} onEdit={() => setEditing(l.category_id)} />
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}

      {outside.length > 0 && (
        <Card title="Spending outside the budget" className="mt-4">
          <ul className="pt-1 pb-1.5">
            {outside.map((l) =>
              editing === l.category_id ? (
                <li key={l.category_id}>
                  <Editor line={l} month={month} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <li key={l.category_id} className="flex items-center gap-3 px-4 py-1.5">
                  <Link to={txLink({ category_id: l.category_id, from, to })} className="min-w-0 flex-1 truncate text-[13px] hover:underline">
                    {l.name}
                    <span className="ml-2 text-xs text-faint">{l.group_name}</span>
                  </Link>
                  <span className="num text-[13px]">{money(l.spent_cents)}</span>
                  <button type="button" className="btn" onClick={() => setEditing(l.category_id)}>
                    Set budget
                  </button>
                </li>
              ),
            )}
          </ul>
        </Card>
      )}

      {data && <AddBudget month={month} taken={new Set(lines.map((l) => l.category_id))} />}
    </>
  );
}

function Stat({ name, value, sub, to, over }: { name: string; value: number; sub?: string | null; to?: string; over?: boolean }) {
  const cls = `num mt-0.5 block font-serif text-[22px] tracking-tight md:text-[26px] ${over ? "text-alert" : ""}`;
  return (
    <div className="bg-panel px-4 py-3">
      <div className="eyebrow">{name}</div>
      {to ? (
        <Link to={to} className={cls}>
          {money(value, { whole: true })}
        </Link>
      ) : (
        <div className={cls}>{money(value, { whole: true })}</div>
      )}
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Spent against available. Red only when over; the tick is where an even pace would be today. */
function Meter({ spent, available, tick }: { spent: number; available: number; tick: number | null }) {
  const over = spent > available;
  const scale = Math.max(spent, available, 1);
  return (
    <div className="relative mt-2.5 h-2 rounded-full bg-line-soft" role="img" aria-label={`${money(spent)} spent of ${money(available)}`}>
      <div
        className={`h-2 rounded-full ${over ? "bg-alert" : "bg-series-1"}`}
        style={{ width: `${Math.max(0, Math.min(spent / scale, 1)) * 100}%` }}
      />
      {over && <div className="absolute top-0 h-2 w-0.5 bg-panel" style={{ left: `${(available / scale) * 100}%` }} />}
      {tick !== null && tick > 0 && <div className="absolute -top-1 h-4 w-0.5 rounded bg-ink" style={{ left: `${Math.min(tick / scale, 1) * 100}%` }} />}
    </div>
  );
}

function Row({ line: l, from, to, onEdit }: { line: BudgetLine; from: string; to: string; onEdit: () => void }) {
  const over = l.remaining_cents < 0;
  return (
    <div className="group flex items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3 text-[13px]">
          <Link to={txLink({ category_id: l.category_id, from, to })} className="min-w-0 truncate hover:underline">
            {l.name}
            {l.source === "month" && <span className="ml-2 text-xs text-faint">this month only</span>}
          </Link>
          <span className="num shrink-0">
            {money(l.spent_cents, { whole: true })}
            <span className="text-muted"> of {money(l.available_cents, { whole: true })}</span>
          </span>
        </div>
        <Meter spent={l.spent_cents} available={l.available_cents} tick={null} />
        <div className="mt-1 flex justify-between gap-3 text-xs text-muted">
          <span>
            {l.rollover ? (l.carried_cents ? `${money(l.carried_cents, { whole: true, plus: true })} carried from last month` : "Rolls over") : ""}
          </span>
          <span className={over ? "font-medium text-alert" : ""}>
            {over ? `${money(-l.remaining_cents, { whole: true })} over` : `${money(l.remaining_cents, { whole: true })} left`}
          </span>
        </div>
      </div>
      <button type="button" className="btn shrink-0" onClick={onEdit} aria-label={`Edit the ${l.name} budget`}>
        Edit
      </button>
    </div>
  );
}

function Editor({ line: l, month, onDone }: { line: BudgetLine; month: string; onDone: () => void }) {
  const edit = useBudgetEdit();
  const start = l.budget_cents ?? Math.ceil(Math.max(l.spent_cents, 0) / 1000) * 1000;
  const [amount, setAmount] = useState(String(start / 100));
  const [scope, setScope] = useState<"default" | "month">(l.source === "month" ? "month" : "default");
  const [rollover, setRollover] = useState(l.rollover);
  const cents = parseDollars(amount);
  const label = monthLabel(month);

  const save = () => {
    if (cents === null) return;
    edit.mutate(
      { category_id: l.category_id, month: scope === "month" ? month : null, amount_cents: cents, rollover, message: `${l.name} budget saved` },
      { onSuccess: onDone },
    );
  };
  const remove = () =>
    edit.mutate(
      { category_id: l.category_id, month: l.source === "month" ? month : null, amount_cents: null, message: `${l.name} budget removed` },
      { onSuccess: onDone },
    );

  return (
    <form
      className="mx-2 my-1 rounded-lg border border-line bg-raised px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="text-[13px] font-medium">{l.name}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <label className="flex items-center gap-2">
          <span className="text-muted">Amount</span>
          <span className="relative">
            <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">$</span>
            {/* biome-ignore lint/a11y/noAutofocus: the editor opens because the person asked to type an amount */}
            <input className="field num w-28 !pl-5" inputMode="decimal" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} aria-invalid={cents === null} />
          </span>
        </label>
        <fieldset className="flex items-center gap-3">
          <legend className="sr-only">Applies to</legend>
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`scope-${l.category_id}`} checked={scope === "default"} onChange={() => setScope("default")} /> Every month
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`scope-${l.category_id}`} checked={scope === "month"} onChange={() => setScope("month")} /> {label} only
          </label>
        </fieldset>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} /> Carry what's left into next month
        </label>
      </div>
      {edit.error && <p className="mt-2 text-xs text-alert">{edit.error.message}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={cents === null || edit.isPending}>
          Save
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        {l.budget_cents !== null && (
          <button type="button" className="btn ml-auto" onClick={remove} disabled={edit.isPending}>
            {l.source === "month" ? `Remove ${label}'s amount` : "Remove budget"}
          </button>
        )}
      </div>
    </form>
  );
}

function AddBudget({ month, taken }: { month: string; taken: Set<string> }) {
  const categories = useCategories().filter((c) => c.kind === "expense" && !c.hidden && !taken.has(c.id) && c.id !== "uncategorized.uncategorized");
  const [pick, setPick] = useState("");
  const chosen = categories.find((c) => c.id === pick);
  if (categories.length === 0) return null;
  return (
    <Card title="Add a budget" className="mt-4">
      {chosen ? (
        <div className="pb-1">
          <Editor
            line={{
              category_id: chosen.id,
              name: chosen.name,
              group_id: chosen.group_id,
              group_name: chosen.group_name,
              budget_cents: null,
              source: null,
              rollover: false,
              carried_cents: 0,
              available_cents: 0,
              spent_cents: 0,
              remaining_cents: 0,
            }}
            month={month}
            onDone={() => setPick("")}
          />
        </div>
      ) : (
        <div className="px-4 pt-2 pb-3.5">
          <select className="field w-full max-w-xs" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Category to budget">
            <option value="">Choose a category…</option>
            {[...new Set(categories.map((c) => c.group_name))].map((group) => (
              <optgroup key={group} label={group}>
                {categories
                  .filter((c) => c.group_name === group)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}
    </Card>
  );
}
