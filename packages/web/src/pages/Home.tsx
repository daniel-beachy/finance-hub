import { Link } from "react-router";
import type { AlertView, Overview, WeeklyDigest } from "../api.ts";
import { BarList, ColumnChart, Sparkline } from "../components/charts.tsx";
import { Card, Empty, ErrorNote, PageHeader } from "../components/Shell.tsx";
import { Amount, Marks } from "../components/tx.tsx";
import { money, monthEnd, monthLabel, percent, shortDate, txLink } from "../lib/format.ts";
import { useDismissAlerts, useGet } from "../lib/hooks.ts";
import { CloseIcon } from "../components/icons.tsx";

export function Home() {
  const { data, error } = useGet<Overview>("/api/overview");
  const digest = useGet<WeeklyDigest>("/api/digest").data;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { month, net_worth: worth, net_worth_history: history, today } = data;
  const first = history[0];
  const change = first ? worth.net_cents - first.net_cents : 0;
  const from = `${month.month}-01`;
  const diff = month.spending_cents - month.typical_to_date_cents;
  const scale = Math.max(month.typical_month_cents, month.spending_cents, 1);
  const empty = history.length === 0 && data.recent.length === 0;

  return (
    <>
      <PageHeader title="Home" sub={new Date(`${today}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} />
      {empty && (
        <Card className="mb-4">
          <Empty>
            Nothing here yet. <Link className="text-accent underline" to="/accounts">Link an account</Link> to get started.
          </Empty>
        </Card>
      )}

      {digest && digest.alerts.length > 0 && <Alerts alerts={digest.alerts} today={today} />}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Net worth" action={<Link to="/net-worth" className="hover:text-ink">Details</Link>}>
          <div className="px-4 pt-1.5 pb-4">
            <Link to="/net-worth" className="num block font-serif text-[34px] leading-tight tracking-tight">
              {money(worth.net_cents, { whole: true })}
            </Link>
            {first && (
              <p className="text-[13px] text-muted">
                <span className="num text-ink">{money(change, { whole: true, plus: true })}</span> since {shortDate(first.date, today)}
              </p>
            )}
            <div className="mt-3">
              <Sparkline values={history.map((p) => p.net_cents)} height={44} />
            </div>
          </div>
        </Card>

        <Card title={monthLabel(month.month)} action={<Link to="/spending" className="hover:text-ink">Details</Link>}>
          <div className="px-4 pt-1.5 pb-4">
            <Link to={txLink({ kind: "expense", from, to: today })} className="num block font-serif text-[34px] leading-tight tracking-tight">
              {money(month.spending_cents, { whole: true })}
            </Link>
            <p className="text-[13px] text-muted">
              spent so far
              {month.typical_to_date_cents > 0 && (
                <>
                  , <span className="text-ink">{diff === 0 ? "right at" : `${percent(diff / month.typical_to_date_cents)} ${diff > 0 ? "above" : "below"}`}</span> a typical month by now
                </>
              )}
            </p>
            {/* Progress toward a typical full month; the tick marks a typical month-to-date. */}
            <div className="relative mt-4 h-2 rounded-full bg-line-soft">
              <div className="h-2 rounded-full bg-series-1" style={{ width: `${(month.spending_cents / scale) * 100}%` }} />
              {month.typical_to_date_cents > 0 && (
                <div className="absolute -top-1 h-4 w-0.5 rounded bg-ink" style={{ left: `${(month.typical_to_date_cents / scale) * 100}%` }} />
              )}
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>
                Typical by now <span className="num text-ink">{money(month.typical_to_date_cents, { whole: true })}</span>
              </span>
              <span>
                Typical month <span className="num text-ink">{money(month.typical_month_cents, { whole: true })}</span>
              </span>
            </div>
            <p className="mt-3 flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-line-soft pt-2.5 text-[13px] text-muted">
              <span>
                Income this month{" "}
                <Link to={txLink({ kind: "income", from, to: today })} className="num text-ink">
                  {money(month.income_cents, { whole: true })}
                </Link>
              </span>
              <Link to="/budget" className="hover:text-ink">
                {digest?.budget ? (
                  <>
                    Budget <span className="num text-ink">{money(digest.budget.spent_cents, { whole: true })}</span> of{" "}
                    <span className="num">{money(digest.budget.available_cents, { whole: true })}</span>
                    {digest.budget.over.length > 0 && <span className="text-alert"> · {digest.budget.over.length} over</span>}
                  </>
                ) : (
                  "Set a budget"
                )}
              </Link>
            </p>
          </div>
        </Card>

        <Card title="Cash flow, last 6 months">
          <div className="px-4 pt-2 pb-3">
            <ColumnChart
              series={[
                { name: "Income", color: "var(--series-2)" },
                { name: "Spending", color: "var(--series-1)" },
              ]}
              groups={data.cash_flow.map((m) => ({
                key: m.month,
                label: monthLabel(m.month, "narrow"),
                title: monthLabel(m.month),
                values: [m.income_cents, m.spending_cents],
                links: [
                  txLink({ kind: "income", from: `${m.month}-01`, to: monthEnd(m.month) }),
                  txLink({ kind: "expense", from: `${m.month}-01`, to: monthEnd(m.month) }),
                ],
              }))}
              footer={(g) => (
                <div className="mt-1 flex justify-between gap-4 border-t border-line pt-1 text-muted">
                  <span>Saved</span>
                  <span className="num">{money(g.values[0]! - g.values[1]!, { whole: true })}</span>
                </div>
              )}
            />
          </div>
        </Card>

        <Card title="Top categories this month" action={<Link to="/spending" className="hover:text-ink">All</Link>}>
          <div className="pt-2 pb-2.5">
            {data.top_categories.length === 0 ? (
              <Empty>No spending yet this month.</Empty>
            ) : (
              <BarList
                rows={data.top_categories.map((c) => ({
                  key: c.category_id,
                  label: c.name,
                  value: -c.total_cents,
                  to: txLink({ category_id: c.category_id, from, to: today }),
                }))}
              />
            )}
          </div>
        </Card>
      </div>

      {digest && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Card title="Last 7 days" action={<span>{shortDate(digest.from, today)} to {shortDate(digest.to, today)}</span>}>
            <div className="px-4 pt-1.5 pb-3">
              <p className="text-[13px] text-muted">
                <Link to={txLink({ kind: "expense", from: digest.from, to: digest.to })} className="num font-medium text-ink">
                  {money(digest.spending_cents, { whole: true })}
                </Link>{" "}
                spent
                {digest.average_weekly_cents > 0 && (
                  <>
                    , against a weekly average of <span className="num text-ink">{money(digest.average_weekly_cents, { whole: true })}</span> over the 8 weeks before
                  </>
                )}
                .
              </p>
              <ul className="mt-2">
                {digest.groups.slice(0, 5).map((g) => (
                  <li key={g.group_id} className="flex items-baseline justify-between gap-3 py-0.5 text-[13px]">
                    <Link to={txLink({ group_id: g.group_id, kind: "expense", from: digest.from, to: digest.to })} className="min-w-0 truncate hover:underline">
                      {g.name}
                    </Link>
                    <span className="num shrink-0">
                      {money(g.spent_cents, { whole: true })}
                      <span className="ml-2 inline-block w-20 text-right text-xs text-faint">
                        {g.change_cents === 0 ? "as usual" : `${money(Math.abs(g.change_cents), { whole: true })} ${g.change_cents > 0 ? "more" : "less"}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {digest.new_merchants.length > 0 && (
                <p className="mt-2 border-t border-line-soft pt-2 text-xs text-muted">
                  New this week: {digest.new_merchants.slice(0, 4).map((m) => m.merchant).join(", ")}
                  {digest.new_merchants.length > 4 && ` and ${digest.new_merchants.length - 4} more`}
                </p>
              )}
            </div>
          </Card>

          <Card title="Coming up" action={<Link to="/recurring" className="hover:text-ink">All recurring</Link>}>
            {digest.upcoming.length === 0 ? (
              <Empty>No recurring charges due in the next two weeks.</Empty>
            ) : (
              <ul className="pt-1.5 pb-1.5">
                {digest.upcoming.slice(0, 7).map((u) => (
                  <li key={`${u.series_id}-${u.date}`}>
                    <Link to="/recurring" className="flex items-center gap-3 px-4 py-1.5 hover:bg-raised">
                      <span className="num w-12 shrink-0 text-xs text-faint">{u.late ? <span className="text-alert">Late</span> : u.date === today ? "Today" : shortDate(u.date, today)}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px]">{u.label}</span>
                      <Amount cents={u.amount_cents} className="text-[13px]" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {data.review.all > 0 && (
        <Link to="/review" className="card mt-4 flex items-center justify-between gap-3 px-4 py-3 hover:border-faint">
          <span>
            <span className="num font-medium">{data.review.all}</span> {data.review.all === 1 ? "charge is" : "charges are"} waiting for a look
            <span className="ml-2 text-[13px] text-muted">
              {[
                data.review.large && `${data.review.large} large`,
                data.review.unfamiliar && `${data.review.unfamiliar} unfamiliar`,
                data.review.uncategorized && `${data.review.uncategorized} uncategorized`,
                data.review.flagged && `${data.review.flagged} flagged`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <span className="btn btn-primary shrink-0">Review</span>
        </Link>
      )}

      <Card title="Recent" action={<Link to="/transactions" className="hover:text-ink">All transactions</Link>} className="mt-4">
        <ul className="pt-1.5 pb-1.5">
          {data.recent.map((t) => (
            <li key={t.id}>
              <Link to={txLink({ q: t.label })} className="flex items-center gap-3 px-4 py-1.5 hover:bg-raised">
                <span className="num w-12 shrink-0 text-xs text-faint">{shortDate(t.posted_date, today)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {t.label} <Marks tx={t} />
                </span>
                <span className="hidden w-40 truncate text-[13px] text-muted sm:block">{t.category_name ?? "Uncategorized"}</span>
                <Amount cents={t.amount_cents} className="w-24 text-right" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

const ALERT_LABEL: Record<AlertView["kind"], string> = {
  duplicate: "Possible duplicate",
  large: "Large charge",
  new_merchant: "New merchant",
  fee: "Fee",
  price_increase: "Price increase",
  new_subscription: "New subscription",
  missed_recurring: "Missed charge",
  connection: "Connection",
  import: "File import",
};

/** Open alerts. Each links to what it's about and can be dismissed for good. */
function Alerts({ alerts, today }: { alerts: AlertView[]; today: string }) {
  const dismiss = useDismissAlerts();
  const link = (a: AlertView) =>
    a.series_id ? "/recurring" : a.connection_id ? "/accounts" : a.date ? txLink({ from: a.date, to: a.date }) : "/transactions";
  return (
    <Card title="Worth a look" action={`${alerts.length} open`} className="mb-4">
      <ul className="pt-1 pb-1.5">
        {alerts.slice(0, 8).map((a) => (
          <li key={a.id} className="flex items-start gap-3 px-4 py-1.5">
            <Link to={link(a)} className="min-w-0 flex-1 text-[13px] hover:underline">
              <span className={`mr-2 text-xs font-medium ${a.kind === "duplicate" || a.kind === "connection" ? "text-alert" : "text-muted"}`}>
                {ALERT_LABEL[a.kind]}
              </span>
              {a.message}
              {a.date && <span className="ml-2 text-xs text-faint">{shortDate(a.date, today)}</span>}
            </Link>
            <button
              type="button"
              className="-mt-0.5 -mr-1.5 shrink-0 cursor-pointer rounded-md p-1 text-faint hover:bg-raised hover:text-ink"
              aria-label={`Dismiss: ${a.message}`}
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate([a.id])}
            >
              <CloseIcon />
            </button>
          </li>
        ))}
      </ul>
      {alerts.length > 8 && <p className="px-4 pb-3 text-xs text-muted">And {alerts.length - 8} more. Ask Claude for a weekly review to go through them.</p>}
    </Card>
  );
}
