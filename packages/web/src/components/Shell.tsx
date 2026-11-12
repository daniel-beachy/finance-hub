import { type ReactNode, useEffect, useState } from "react";
import { NavLink } from "react-router";
import { DEMO, type ReviewCounts } from "../api.ts";
import { useGet } from "../lib/hooks.ts";
import { BankIcon, HomeIcon, InboxIcon, ListIcon, MoonIcon, PieIcon, SunIcon, TrendIcon } from "./icons.tsx";

const NAV = [
  { to: "/", label: "Home", short: "Home", icon: HomeIcon },
  { to: "/transactions", label: "Transactions", short: "Activity", icon: ListIcon },
  { to: "/review", label: "Review", short: "Review", icon: InboxIcon },
  { to: "/spending", label: "Spending", short: "Spending", icon: PieIcon },
  { to: "/net-worth", label: "Net worth", short: "Worth", icon: TrendIcon },
  { to: "/accounts", label: "Accounts", short: "Accounts", icon: BankIcon },
] as const;

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("fh-theme", theme);
    } catch {
      // Private browsing: the choice just lasts for this visit.
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

export function Shell({ children }: { children: ReactNode }) {
  const [theme, toggleTheme] = useTheme();
  const waiting = useGet<{ counts: ReviewCounts }>("/api/review?tab=flagged").data?.counts.all ?? 0;

  return (
    <div className="min-h-dvh md:pl-52">
      {/* Desktop: a fixed rail. */}
      <aside className="fixed inset-y-0 left-0 hidden w-52 flex-col border-r border-line bg-panel md:flex">
        <div className="px-5 pt-6 pb-5">
          <div className="font-serif text-[19px] leading-none tracking-tight">Finance Hub</div>
          <div className="mt-1.5 text-xs text-faint">{DEMO ? "Demo household" : "Your ledger"}</div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2.5" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] ${
                  isActive ? "bg-accent-wash font-medium text-accent" : "text-muted hover:bg-raised hover:text-ink"
                }`
              }
            >
              <Icon />
              <span className="flex-1">{label}</span>
              {to === "/review" && waiting > 0 && (
                <span className="num rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-[18px] text-accent-ink">
                  {waiting}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-2.5">
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:bg-raised hover:text-ink"
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </aside>

      {/* Phone: a slim header and a tab bar. */}
      <header className="flex items-center justify-between border-b border-line bg-panel px-4 py-2.5 md:hidden">
        <div className="font-serif text-[17px] tracking-tight">Finance Hub</div>
        <button type="button" onClick={toggleTheme} className="-mr-1.5 rounded-md p-1.5 text-muted" aria-label="Switch theme">
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>

      {DEMO && (
        <div className="border-b border-line bg-accent-wash px-4 py-1.5 text-center text-[12.5px] text-ink md:px-8">
          Demo data. Nothing here is real.{" "}
          <a className="underline underline-offset-2" href="https://github.com/daniel-beachy/finance-hub">
            Source
          </a>
          {" · "}
          <a className="underline underline-offset-2" href="https://daniel-beachy.github.io/">
            Portfolio
          </a>
        </div>
      )}

      <main className="mx-auto max-w-[1080px] px-4 pt-5 pb-24 md:px-8 md:pt-8 md:pb-12">{children}</main>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Main"
      >
        {NAV.map(({ to, short, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[10px] ${isActive ? "text-accent" : "text-muted"}`
            }
          >
            <Icon />
            {short}
            {to === "/review" && waiting > 0 && (
              <span className="absolute top-1 left-1/2 ml-1.5 h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <h1 className="font-serif text-[26px] leading-tight tracking-tight">{title}</h1>
        {sub && <p className="mt-0.5 text-[13px] text-muted">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
          <h2 className="eyebrow">{title}</h2>
          {action && <div className="text-xs text-muted">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-[13px] text-muted">{children}</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p role="alert" className="rounded-md border border-alert bg-alert-wash px-3 py-2 text-[13px]">
      {error instanceof Error ? error.message : "Something went wrong."}
    </p>
  );
}
