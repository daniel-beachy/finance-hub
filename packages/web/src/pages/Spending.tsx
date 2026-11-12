import { Link, useSearchParams } from "react-router";
import type { CashFlowMonth, SpendingBreakdown } from "../api.ts";
import { BarList, ColumnChart, FlowChart, type FlowNode } from "../components/charts.tsx";
import { ChevronLeft, ChevronRight } from "../components/icons.tsx";
import { Card, Empty, ErrorNote, PageHeader } from "../components/Shell.tsx";
import { money, monthEnd, monthLabel, percent, periodRange, shiftPeriod, txLink } from "../lib/format.ts";
import { useGet, useStatus } from "../lib/hooks.ts";

export function Spending() {
  const [params, setParams] = useSearchParams();
  const today = useStatus().data?.today;
  const period = params.get("p") ?? today?.slice(0, 7);
  if (!period || !today) return null;
  return <Period period={period} today={today} setPeriod={(p) => setParams({ p }, { replace: true })} />;
}

function Period({ period, today, setPeriod }: { period: string; today: string; setPeriod: (p: string) => void }) {
  const yearly = period.length === 4;
  const { from, to, label } = periodRange(period);
  const current = yearly ? today.slice(0, 4) : today.slice(0, 7);
  const { data, error } = useGet<SpendingBreakdown>(`/api/spending?from=${from}&to=${to}`);
  // The trend ends at the period shown, or covers the year shown.
  const trendEnd = yearly ? `${period}-12` : period;
  const trend = useGet<{ months: CashFlowMonth[] }>(`/api/cash-flow?months=12&to=${trendEnd}`).data?.months ?? [];

  const spending = (data?.categories ?? []).filter((c) => c.kind === "expense" && c.total_cents < 0);
  const income = (data?.categories ?? []).filter((c) => c.kind === "income" && c.total_cents > 0);
  const groups = new Map<string, { id: string; name: string; total: number; items: typeof spending }>();
  for (const c of spending) {
    const g = groups.get(c.group_id) ?? { id: c.group_id, name: c.group_name, total: 0, items: [] };
    g.total -= c.total_cents;
    g.items.push(c);
    groups.set(c.group_id, g);
  }
  const ordered = [...groups.values()].sort((a, b) => b.total - a.total);
  const spent = data?.spending_cents ?? 0;
  const earned = data?.income_cents ?? 0;
  const saved = earned - spent;
  const previous = data?.previous_spending_cents ?? 0;
  const delta = spent - previous;

  const sources: FlowNode[] = income.map((c) => ({ key: c.category_id, label: c.name, value: c.total_cents, to: txLink({ category_id: c.category_id, from, to }) }));
  if (saved < 0) sources.push({ key: "savings", label: "From savings", value: -saved });
  const targets: FlowNode[] = ordered.map((g) => ({ key: g.id, label: g.name, value: g.total, to: txLink({ group_id: g.id, kind: "expense", from, to }) }));
  if (saved > 0) targets.push({ key: "saved", label: "Saved", value: saved });

  return (
    <>
      <PageHeader title="Spending" sub={`${label}${period === current ? " so far" : ""}`}>
        <div className="flex rounded-[7px] border border-line bg-panel p-0.5 text-[13px]">
          {(["Month", "Year"] as const).map((unit) => {
            const on = (unit === "Year") === yearly;
            return (
              <button
                key={unit}
                type="button"
                aria-pressed={on}
                className={`cursor-pointer rounded-[5px] px-2.5 py-0.5 ${on ? "bg-accent-wash font-medium text-accent" : "text-muted"}`}
                onClick={() => !on && setPeriod(unit === "Year" ? period.slice(0, 4) : period === today.slice(0, 4) ? today.slice(0, 7) : `${period}-12`)}
              >
                {unit}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="btn !px-1.5" aria-label="Earlier" onClick={() => setPeriod(shiftPeriod(period, -1))}>
            <ChevronLeft />
          </button>
          <button type="button" className="btn !px-1.5" aria-label="Later" disabled={period >= current} onClick={() => setPeriod(shiftPeriod(period, 1))}>
            <ChevronRight />
          </button>
        </div>
      </PageHeader>

      {error && <ErrorNote error={error} />}

      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[10px] border border-line bg-line">
        {[
          { name: "Spent", value: spent, to: txLink({ kind: "expense", from, to }), sub: period !== current && previous > 0 && delta !== 0 ? `${percent(delta / previous)} ${delta > 0 ? "more" : "less"} than the ${yearly ? "year" : "month"} before` : null },
          { name: "Income", value: earned, to: txLink({ kind: "income", from, to }), sub: null },
          { name: "Net", value: saved, to: null, sub: earned > 0 && saved > 0 ? `${percent(saved / earned)} of income saved` : null },
        ].map((s) => (
          <div key={s.name} className="bg-panel px-4 py-3">
            <div className="eyebrow">{s.name}</div>
            {s.to ? (
              <Link to={s.to} className="num mt-0.5 block font-serif text-[22px] tracking-tight md:text-[28px]">
                {money(s.value, { whole: true })}
              </Link>
            ) : (
              <div className="num mt-0.5 font-serif text-[22px] tracking-tight md:text-[28px]">{money(s.value, { whole: true, plus: true })}</div>
            )}
            {s.sub && <div className="text-xs text-muted">{s.sub}</div>}
          </div>
        ))}
      </div>

      <div className="mt-4 grid items-start gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="By category">
          {data && ordered.length === 0 ? (
            <Empty>No spending in {label}.</Empty>
          ) : (
            <div className="pt-1 pb-2.5">
              {ordered.map((g) => (
                <div key={g.id} className="mt-2.5">
                  <Link to={txLink({ group_id: g.id, kind: "expense", from, to })} className="flex items-baseline justify-between px-4 text-[13px] font-medium hover:text-accent">
                    <span>{g.name}</span>
                    <span className="num">
                      {money(g.total, { whole: true })}
                      <span className="ml-2 inline-block w-8 text-right text-xs font-normal text-faint">{Math.round((g.total / Math.max(spent, 1)) * 100)}%</span>
                    </span>
                  </Link>
                  <BarList
                    total={spent}
                    scale={Math.max(1, ...spending.map((c) => -c.total_cents))}
                    rows={g.items.map((c) => ({ key: c.category_id, label: c.name, sub: `${c.count}`, value: -c.total_cents, to: txLink({ category_id: c.category_id, from, to }) }))}
                  />
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="grid gap-4">
          <Card title="12-month trend">
            <div className="px-4 pt-2 pb-3">
              <ColumnChart
                series={[{ name: "Spending", color: "var(--series-1)" }]}
                selected={yearly ? undefined : period}
                groups={trend.map((m) => ({
                  key: m.month,
                  label: monthLabel(m.month, "narrow").slice(0, 1),
                  title: monthLabel(m.month),
                  values: [m.spending_cents],
                  links: [txLink({ kind: "expense", from: `${m.month}-01`, to: monthEnd(m.month) })],
                }))}
                height={160}
              />
            </div>
          </Card>
          <Card title="Top merchants">
            <div className="pt-2 pb-2.5">
              {data && data.merchants.length === 0 ? (
                <Empty>Nothing yet.</Empty>
              ) : (
                <BarList rows={(data?.merchants ?? []).map((m) => ({ key: m.merchant, label: m.merchant, sub: `${m.count}`, value: -m.total_cents, to: txLink({ merchant: m.merchant, from, to }) }))} />
              )}
            </div>
          </Card>
        </div>
      </div>

      {earned > 0 && targets.length > 0 && (
        <Card title="Where the money went" className="mt-4">
          <div className="px-4 pt-2 pb-3">
            <FlowChart sources={sources} targets={targets} hub="Income" />
          </div>
        </Card>
      )}
    </>
  );
}
