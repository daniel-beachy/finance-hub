import { type Ref, useEffect, useState } from "react";
import type { CategoryView, TransactionView } from "../api.ts";
import { money } from "../lib/format.ts";

/** Money out reads plain; money in gets a plus and the accent. Never red. */
export function Amount({ cents, className = "" }: { cents: number; className?: string }) {
  return (
    <span className={`num ${cents > 0 ? "text-accent" : ""} ${className}`}>
      {cents > 0 ? money(cents, { plus: true }) : money(-cents)}
    </span>
  );
}

/** A native select, grouped: quick with a keyboard and right on a phone. */
export function CategorySelect({
  value,
  categories,
  onChange,
  placeholder = "Uncategorized",
  className = "",
  ref,
  label = "Category",
}: {
  value: string | null;
  categories: CategoryView[];
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  ref?: Ref<HTMLSelectElement>;
  label?: string;
}) {
  const groups = new Map<string, CategoryView[]>();
  for (const c of categories) {
    if (c.hidden && c.id !== value) continue;
    groups.set(c.group_name, [...(groups.get(c.group_name) ?? []), c]);
  }
  return (
    <select
      ref={ref}
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className={`field w-full cursor-pointer truncate py-[3px] ${value ? "" : "text-muted"} ${className}`}
    >
      <option value="">{placeholder}</option>
      {[...groups].map(([group, items]) => (
        <optgroup key={group} label={group}>
          {items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** A note that saves when you leave the field or press Enter. */
export function NoteField({
  value,
  onSave,
  ref,
}: {
  value: string | null;
  onSave: (note: string | null) => void;
  ref?: Ref<HTMLInputElement>;
}) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const commit = () => {
    const next = text.trim() || null;
    if (next !== (value ?? null)) onSave(next);
  };
  return (
    <input
      ref={ref}
      className="field w-full"
      placeholder="Add a note: what was this?"
      aria-label="Note"
      value={text}
      maxLength={500}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

const REASONS: Record<string, string> = {
  uncategorized: "No category",
  large: "Large",
  unfamiliar: "New merchant",
  unusual: "Unusual amount",
  duplicate: "Possible duplicate",
};

/** Why a transaction is waiting, plus its flag. Only flags wear the alert colour. */
export function Marks({ tx, reasons = false }: { tx: TransactionView; reasons?: boolean }) {
  return (
    <>
      {(tx.flag === "suspicious" || tx.flag === "disputed") && (
        <span className="chip border-alert bg-alert-wash text-ink">{tx.flag === "disputed" ? "Disputed" : "Flagged"}</span>
      )}
      {tx.pending ? <span className="chip">Pending</span> : null}
      {reasons && !tx.reviewed_at && tx.review_reasons.map((r) => <span key={r} className="chip">{REASONS[r] ?? r}</span>)}
    </>
  );
}

export function accountLabel(tx: Pick<TransactionView, "account_name" | "account_mask">): string {
  return tx.account_mask ? `${tx.account_name} ··${tx.account_mask}` : tx.account_name;
}
