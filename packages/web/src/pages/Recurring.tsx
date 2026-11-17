import { useState } from "react";
import { Link } from "react-router";
import type { RecurringData, RecurringView } from "../api.ts";
import { Card, Empty, ErrorNote, PageHeader } from "../components/Shell.tsx";
import { Amount } from "../components/tx.tsx";
import { money, shortDate, txLink } from "../lib/format.ts";
import { useGet, useRecurringEdit } from "../lib/hooks.ts";

const CADENCE: Record<RecurringView["cadence"], string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export function Recurring() {
  const { data, error } = useGet<RecurringData>("/api/recurring");
  const [showInactive, setShowInactive] = useState(false);
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { today, series, upcoming } = data;
  const active = series.filter((s) => s.status === "active");
  const subscriptions = active.filter((s) => s.is_subscription);
  const bills = active.filter((s) => !s.is_subscription);
  const inactive = series.filter((s) => s.status !== "active");
  const yearly = -active.reduce((n, s) => n + s.yearly_cents, 0);
  const subsYearly = -subscriptions.reduce((n, s) => n + s.yearly_cents, 0);
  const next30 = -upcoming.reduce((n, u) => n + u.amount_cents, 0);

  return (
    <>
      <PageHeader
        title="Recurring"
        sub={`${active.length} active · ${money(yearly, { whole: true })} a year, ${money(subsYearly, { whole: true })} of it subscriptions`}
      />

      <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
        <Card title="Next 30 days" action={<span className="num">{money(next30, { whole: true })}</span>}>
          {upcoming.length === 0 ? (
            <Empty>Nothing expected in the next 30 days.</Empty>
          ) : (
            <ul className="pt-1.5 pb-1.5">
              {upcoming.map((u) => (
                <li key={`${u.series_id}-${u.date}`} className="flex items-center gap-3 px-4 py-1.5">
                  <span className="num w-14 shrink-0 text-xs text-faint">{u.late ? <span className="text-alert">Late</span> : u.date === today ? "Today" : shortDate(u.date, today)}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{u.label}</span>
                  <Amount cents={u.amount_cents} className="text-[13px]" />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="grid content-start gap-4">
          <SeriesList title="Subscriptions" series={subscriptions} today={today} empty="No subscriptions found yet." />
          <SeriesList title="Bills" series={bills} today={today} empty="No recurring bills found yet." />
        </div>
      </div>

      {inactive.length > 0 && (
        <div className="mt-4">
          <button type="button" className="btn" aria-expanded={showInactive} onClick={() => setShowInactive((v) => !v)}>
            {showInactive ? "Hide" : "Show"} {inactive.length} ended or ignored
          </button>
          {showInactive && (
            <div className="mt-3">
              <SeriesList title="Ended or ignored" series={inactive} today={today} empty="" />
            </div>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-muted">
        A charge counts as recurring after three at a steady pace from the same merchant on the same account. Anything you change here stays as you set it.
      </p>
    </>
  );
}

function SeriesList({ title, series, today, empty }: { title: string; series: RecurringView[]; today: string; empty: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title={title} action={series.length ? `${series.length}` : undefined}>
      {series.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="pt-1 pb-1.5">
          {series.map((s) => (
            <li key={s.id} className="border-b border-line-soft last:border-0">
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left hover:bg-raised"
                aria-expanded={open === s.id}
                onClick={() => setOpen(open === s.id ? null : s.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">
                    {s.label}
                    {s.late && <span className="chip ml-2 !border-alert !text-alert">Late</span>}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {CADENCE[s.cadence]}
                    {s.status === "active" && s.next_expected_date && ` · next ${shortDate(s.next_expected_date, today)}`}
                    {s.status !== "active" && ` · ${s.status === "ended" ? "ended" : "ignored"}, last ${shortDate(s.last_date ?? "", today)}`}
                    {s.previous_amount_cents !== null && s.amount_cents < s.previous_amount_cents && ` · up from ${money(-s.previous_amount_cents)}`}
                  </span>
                </span>
                <span className="text-right">
                  <Amount cents={s.amount_cents} className="block text-[13.5px]" />
                  <span className="num block text-xs text-faint">{money(-s.yearly_cents, { whole: true })}/yr</span>
                </span>
              </button>
              {open === s.id && <Detail series={s} today={today} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Detail({ series: s, today }: { series: RecurringView; today: string }) {
  const { data } = useGet<{ charges: { id: string; posted_date: string; amount_cents: number }[] }>(`/api/recurring/${s.id}/charges`);
  const edit = useRecurringEdit();
  const set = (patch: { status?: "active" | "ended" | "ignored"; is_subscription?: boolean }, message: string) =>
    edit.mutate({ id: s.id, ...patch, message });
  return (
    <div className="bg-raised px-4 pt-2 pb-3 text-[13px]">
      <p className="text-muted">
        {s.charge_count} charges on {s.account_name}
        {s.account_mask ? ` ••${s.account_mask}` : ""} since {shortDate(s.first_date ?? "", today)}
        {s.category_name ? `, filed under ${s.category_name}` : ""}.{" "}
        <Link className="underline decoration-line underline-offset-2" to={txLink({ q: s.label })}>
          See transactions
        </Link>
      </p>
      {data && (
        <ul className="mt-1.5 grid grid-cols-2 gap-x-6 sm:grid-cols-3">
          {data.charges.slice(0, 9).map((c) => (
            <li key={c.id} className="flex justify-between gap-3 py-0.5 text-xs">
              <span className="num text-muted">{shortDate(c.posted_date, today)}</span>
              <Amount cents={c.amount_cents} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 flex flex-wrap gap-2">
        {s.status === "active" ? (
          <>
            <button type="button" className="btn" onClick={() => set({ status: "ended" }, `${s.label} marked ended`)}>
              Mark cancelled
            </button>
            <button type="button" className="btn" onClick={() => set({ status: "ignored" }, `${s.label} ignored`)}>
              Not recurring
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => set({ status: "active" }, `${s.label} back to automatic`)}>
            Back to automatic
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => set({ is_subscription: !s.is_subscription }, s.is_subscription ? `${s.label} is a bill` : `${s.label} is a subscription`)}
        >
          {s.is_subscription ? "It's a bill" : "It's a subscription"}
        </button>
      </div>
    </div>
  );
}
