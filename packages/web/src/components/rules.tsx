import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CategoryView, type RuleEditResult, type RuleMatch } from "../api.ts";
import { money, shortDate } from "../lib/format.ts";
import { type RuleBody, useDebounced, useRuleEdit, useUndo } from "../lib/hooks.ts";
import { holdUndo, useUndoOffer } from "../lib/undo.ts";
import { CategorySelect } from "./tx.tsx";

/** A rule's match, as a sentence fragment: `merchant is BLUE DOOR PIZZA, money out`. */
export function describeMatch(m: RuleMatch, accountName?: (id: string) => string | undefined): string {
  const parts: string[] = [];
  if (m.merchant_key) parts.push(`merchant is ${m.merchant_key}`);
  if (m.description_contains) parts.push(`description contains “${m.description_contains}”`);
  if (m.description_regex) parts.push(`description matches /${m.description_regex}/`);
  if (m.plaid_pfc_detailed) parts.push(`Plaid says ${m.plaid_pfc_detailed}`);
  if (m.account_id) parts.push(`account is ${accountName?.(m.account_id) ?? m.account_id}`);
  if (m.direction) parts.push(m.direction === "out" ? "money out" : "money in");
  if (m.amount_min_cents !== undefined && m.amount_max_cents !== undefined) {
    parts.push(`${money(m.amount_min_cents)} to ${money(m.amount_max_cents)}`);
  } else if (m.amount_min_cents !== undefined) parts.push(`at least ${money(m.amount_min_cents)}`);
  else if (m.amount_max_cents !== undefined) parts.push(`at most ${money(m.amount_max_cents)}`);
  return parts.join(", ");
}

interface Draft {
  merchant_key: string;
  description_contains: string;
  direction: "" | "in" | "out";
  min: string;
  max: string;
  category_id: string | null;
  priority: string;
}

const toCents = (dollars: string): number | undefined => {
  const n = Number(dollars.replace(/[$,\s]/g, ""));
  return dollars.trim() === "" || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n * 100);
};

function draftFrom(match: RuleMatch, categoryId: string | null, priority = 100): Draft {
  return {
    merchant_key: match.merchant_key ?? "",
    description_contains: match.description_contains ?? "",
    direction: match.direction ?? "",
    min: match.amount_min_cents === undefined ? "" : String(match.amount_min_cents / 100),
    max: match.amount_max_cents === undefined ? "" : String(match.amount_max_cents / 100),
    category_id: categoryId,
    priority: String(priority),
  };
}

/** The match the form describes. Fields the form doesn't show (regex, account) are kept from the rule. */
function matchFrom(d: Draft, keep: RuleMatch): RuleMatch {
  const m: RuleMatch = {};
  if (keep.description_regex) m.description_regex = keep.description_regex;
  if (keep.account_id) m.account_id = keep.account_id;
  if (keep.plaid_pfc_detailed) m.plaid_pfc_detailed = keep.plaid_pfc_detailed;
  if (d.merchant_key.trim()) m.merchant_key = d.merchant_key.trim().toUpperCase();
  if (d.description_contains.trim()) m.description_contains = d.description_contains.trim();
  if (d.direction) m.direction = d.direction;
  const min = toCents(d.min);
  const max = toCents(d.max);
  if (min !== undefined) m.amount_min_cents = min;
  if (max !== undefined) m.amount_max_cents = max;
  return m;
}

/**
 * Create or edit a rule. Before anything is saved it shows how many existing
 * transactions the rule would recategorize, from a dry run of the real edit.
 */
export function RuleEditor({
  ruleId,
  initialMatch,
  initialCategory,
  initialPriority,
  fromTransaction,
  categories,
  onDone,
}: {
  ruleId?: string;
  initialMatch: RuleMatch;
  initialCategory: string | null;
  initialPriority?: number;
  fromTransaction?: string;
  categories: CategoryView[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(initialMatch, initialCategory, initialPriority));
  const edit = useRuleEdit();
  const match = matchFrom(draft, initialMatch);
  const priority = Number(draft.priority);
  const body: RuleBody = {
    match,
    category_id: draft.category_id ?? undefined,
    priority: Number.isInteger(priority) ? priority : undefined,
  };
  if (!ruleId && fromTransaction) body.created_from_transaction_id = fromTransaction;
  const ready = Object.keys(match).length > 0 && draft.category_id !== null;
  const key = useDebounced(JSON.stringify(body), 300);

  const dry = useQuery({
    queryKey: ["rule-dry-run", ruleId ?? "new", key],
    queryFn: () =>
      ruleId
        ? api<RuleEditResult>(`/api/rules/${ruleId}`, { ...JSON.parse(key), dry_run: true }, "PATCH")
        : api<RuleEditResult>("/api/rules", { ...JSON.parse(key), dry_run: true }),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 0,
  });

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const name = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "Uncategorized";
  const settled = key === JSON.stringify(body) && !dry.isFetching;
  const changed = dry.data?.changed ?? 0;

  const save = () =>
    edit.mutate(
      { id: ruleId, body, message: ruleId ? "Rule saved" : "Rule created" },
      { onSuccess: onDone },
    );

  return (
    <div className="grid gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted">
          Merchant is
          <input className="field font-mono text-[12.5px]" value={draft.merchant_key} placeholder="Any merchant" onChange={(e) => set({ merchant_key: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Description contains
          <input className="field" value={draft.description_contains} placeholder="Any text" onChange={(e) => set({ description_contains: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Direction
          <select className="field" value={draft.direction} onChange={(e) => set({ direction: e.target.value as Draft["direction"] })}>
            <option value="">Money in or out</option>
            <option value="out">Money out</option>
            <option value="in">Money in</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-xs text-muted">
            At least $
            <input className="field num" inputMode="decimal" value={draft.min} placeholder="0" onChange={(e) => set({ min: e.target.value })} />
          </label>
          <label className="grid gap-1 text-xs text-muted">
            At most $
            <input className="field num" inputMode="decimal" value={draft.max} placeholder="No limit" onChange={(e) => set({ max: e.target.value })} />
          </label>
        </div>
        <div className="grid gap-1 text-xs text-muted">
          <span aria-hidden="true">Then set category</span>
          <CategorySelect value={draft.category_id} categories={categories} placeholder="Choose a category" label="Rule category" className="!py-[5px] !text-ink" onChange={(id) => set({ category_id: id })} />
        </div>
        <label className="grid gap-1 text-xs text-muted">
          Priority (lower runs first)
          <input className="field num" inputMode="numeric" value={draft.priority} onChange={(e) => set({ priority: e.target.value })} />
        </label>
      </div>

      {(initialMatch.description_regex || initialMatch.account_id || initialMatch.plaid_pfc_detailed) && (
        <p className="text-xs text-muted">Also keeps: {describeMatch({ description_regex: initialMatch.description_regex, account_id: initialMatch.account_id, plaid_pfc_detailed: initialMatch.plaid_pfc_detailed })}</p>
      )}

      <div aria-live="polite" className="rounded-md border border-line-soft bg-panel px-3 py-2 text-[13px]">
        {!ready ? (
          <span className="text-muted">Give the rule at least one condition and a category.</span>
        ) : dry.error ? (
          <span className="text-alert">{dry.error instanceof Error ? dry.error.message : "That rule can't be saved."}</span>
        ) : !dry.data ? (
          <span className="text-muted">Checking existing transactions…</span>
        ) : (
          <div className={settled ? "" : "opacity-60"}>
            <p>
              {changed === 0 ? (
                "No existing transactions would change. New ones will follow this rule."
              ) : (
                <>
                  <span className="num font-medium">{changed.toLocaleString()}</span> existing transaction{changed === 1 ? "" : "s"} would change.
                </>
              )}
            </p>
            {dry.data.sample.length > 0 && (
              <ul className="mt-1.5 grid gap-0.5 text-xs text-muted">
                {dry.data.sample.slice(0, 4).map((s) => (
                  <li key={s.id} className="flex gap-2">
                    <span className="num shrink-0">{shortDate(s.posted_date)}</span>
                    <span className="min-w-0 flex-1 truncate">{s.description_raw}</span>
                    <span className="shrink-0">
                      {name(s.from)} → {name(s.to)}
                    </span>
                  </li>
                ))}
                {changed > 4 && <li>and {(changed - 4).toLocaleString()} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>

      {edit.error && <p role="alert" className="text-[13px] text-alert">{edit.error.message}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!ready || !settled || !!dry.error || edit.isPending} onClick={save}>
          {changed > 0 && settled ? `Save and recategorize ${changed.toLocaleString()}` : ruleId ? "Save rule" : "Create rule"}
        </button>
      </div>
    </div>
  );
}

/** The undo toast. One at a time: the newest edit replaces the last. */
export function UndoToast() {
  const offer = useUndoOffer();
  const undo = useUndo();
  if (!offer) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-[calc(64px+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md items-center gap-3 rounded-lg border border-line bg-raised px-4 py-2.5 text-[13px] shadow-lg md:bottom-6"
      onPointerEnter={() => holdUndo(true)}
      onPointerLeave={() => holdUndo(false)}
      onFocus={() => holdUndo(true)}
      onBlur={() => holdUndo(false)}
    >
      <span className="min-w-0 flex-1 truncate">
        {undo.error ? `Couldn't undo: ${undo.error.message}` : offer.message}
      </span>
      <button type="button" className="btn shrink-0 !py-1" disabled={undo.isPending} onClick={() => undo.mutate(offer.batchId)}>
        Undo
      </button>
    </div>
  );
}
