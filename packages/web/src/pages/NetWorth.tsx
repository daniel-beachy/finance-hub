import { useState } from "react";
import { Link } from "react-router";
import type { AccountView, NetWorthData } from "../api.ts";
import { LineChart } from "../components/charts.tsx";
import { Card, Empty, ErrorNote, PageHeader } from "../components/Shell.tsx";
import { money, shortDate, txLink } from "../lib/format.ts";
import { useGet } from "../lib/hooks.ts";

const RANGES = [
  { label: "6M", months: 6 },
  { label: "1Y", months: 12 },
  { label: "2Y", months: 24 },
  { label: "All", months: 240 },
];

const TYPES: [string, string][] = [
  ["depository", "Cash"],
  ["investment", "Investments"],
  ["credit", "Credit cards"],
  ["loan", "Loans"],
];

export function NetWorth() {
  const [months, setMonths] = useState(12);
  const { data, error } = useGet<NetWorthData>(`/api/net-worth?months=${months}`);
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { history, now, today } = data;
  const first = history[0];
  const change = first ? now.net_cents - first.net_cents : 0;
  const known = new Set(TYPES.map(([type]) => type));
  const sections = [...TYPES, ["other", "Other"] as [string, string]]
    .map(([type, label]) => ({
      label,
      accounts: data.accounts.filter((a) => (type === "other" ? !known.has(a.type) : a.type === type)),
    }))
    .filter((s) => s.accounts.length > 0);
  const point = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString("en-US", date === today ? { month: "short", day: "numeric" } : { month: "short", year: "2-digit" });

  return (
    <>
      <PageHeader title="Net worth" sub={`As of ${shortDate(today)}`}>
        <div className="flex rounded-[7px] border border-line bg-panel p-0.5 text-[13px]">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              aria-pressed={months === r.months}
              className={`num cursor-pointer rounded-[5px] px-2.5 py-0.5 ${months === r.months ? "bg-accent-wash font-medium text-accent" : "text-muted"}`}
              onClick={() => setMonths(r.months)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <Card>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2 px-4 pt-4">
          <div>
            <div className="num font-serif text-[38px] leading-none tracking-tight">{money(now.net_cents, { whole: true })}</div>
            {first && history.length > 1 && (
              <p className="mt-1.5 text-[13px] text-muted">
                <span className="num text-ink">{money(change, { whole: true, plus: true })}</span> since {shortDate(first.date, today)}
              </p>
            )}
          </div>
          <dl className="flex gap-8 text-[13px]">
            <div>
              <dt className="eyebrow">Assets</dt>
              <dd className="num mt-0.5 text-[17px]">{money(now.assets_cents, { whole: true })}</dd>
            </div>
            <div>
              <dt className="eyebrow">Debts</dt>
              <dd className="num mt-0.5 text-[17px]">{money(-now.liabilities_cents, { whole: true })}</dd>
            </div>
          </dl>
        </div>
        <div className="px-2 pt-4 pb-3 md:px-4">
          {history.length > 1 ? (
            <LineChart points={history.map((p) => ({ label: point(p.date), value: p.net_cents }))} height={240} />
          ) : (
            <Empty>The chart fills in as balances are recorded over time.</Empty>
          )}
        </div>
      </Card>

      <div className="mt-4 grid items-start gap-4 md:grid-cols-2">
        {sections.map((s) => (
          <Card key={s.label} title={s.label} action={<span className="num text-ink">{money(total(s.accounts), { whole: true })}</span>}>
            <ul className="pt-1.5 pb-1.5">
              {s.accounts.map((a) => (
                <li key={a.id}>
                  <Link to={txLink({ account_id: a.id })} className="flex items-baseline justify-between gap-3 px-4 py-1.5 hover:bg-raised">
                    <span className="min-w-0 truncate">
                      {a.name}
                      {a.mask && <span className="text-faint"> ··{a.mask}</span>}
                      {a.subtype && <span className="ml-2 text-xs text-faint">{a.subtype}</span>}
                    </span>
                    <span className="num shrink-0">{money(a.current_cents)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}

function total(accounts: AccountView[]): number {
  return accounts.reduce((n, a) => n + (a.current_cents ?? 0), 0);
}
