import { plural } from "@/lib/format";
import { type ReactNode, useId, useState } from "react";
import { Pencil } from "lucide-react";
import { errorText } from "@/api/client";
import type { BulkResult } from "@/api/types";
import { Button, TextButton } from "./Button";
import { Checkbox } from "./Checkbox";
import { cn } from "./cn";
import { appearClass } from "./motion";
import { Dialog } from "./Dialog";
import { Input } from "./Input";
import { type Done, type Save } from "./SaveStatus";
import { Select, type SelectOption } from "./Select";

// Edit many rows at once (UI ticket 30; research in the ticket's Comments).
// "Edit…" in a table's bulk bar opens a dialog with one field per value the
// rows can share. A value the selected rows disagree on shows as mixed: a dash
// in a checkbox, "Mixed" in a select or a text field, a dash with "2 of 5" on
// an option of a set. Only the fields the Owner changed reach `onApply`; every
// other value stays as each row has it. The result (with Undo for the whole
// change) shows at `at`, the bar's useSave; a failed call keeps the dialog
// open with its error.

/** The row's noun, one and many: ["key", "keys"]. */
export type Noun = [one: string, many: string];

const countOf = (n: number, noun: Noun) => plural(n, ...noun);

/** The value every row shares, or mixed (no rows count as mixed). */
export type Common<V> = { mixed: true } | { mixed: false; value: V };

export function commonValue<T, V>(rows: T[], get: (r: T) => V): Common<V> {
  if (rows.length === 0) return { mixed: true };
  const first = get(rows[0]);
  return rows.every((r) => Object.is(get(r), first)) ? { mixed: false, value: first } : { mixed: true };
}

/** A set field's change: options to add to every row and to take off every row; the rest stay as each row has them. */
export type SetChange = { add: string[]; remove: string[] };

/** What the Owner changed, by field ID: a yes-no, a select's or a text field's value, or a set's change. */
export type BulkChanges = Record<string, boolean | string | SetChange>;

type FieldBase = { id: string; label: string; hint?: ReactNode };
export type SetOption = { value: string; label: string; detail?: ReactNode };

/** A field the selected rows can share. Names and secrets never are. */
export type BulkField<T> =
  | (FieldBase & { kind: "boolean"; get: (r: T) => boolean; /** The word for true in "Mixed: on for 2 of 5 keys". */ on?: string })
  | (FieldBase & { kind: "select"; get: (r: T) => string; options: SelectOption[] })
  | (FieldBase & { kind: "text"; get: (r: T) => string; placeholder?: string; mono?: boolean; inputMode?: "text" | "numeric" })
  | (FieldBase & { kind: "set"; get: (r: T) => string[]; options: SetOption[] });

type Draft = Record<string, boolean | string | Record<string, boolean>>;

/**
 * The bulk bar's "Edit…" and its dialog. `onApply` gets only what changed
 * and resolves with the result to show at `at` (see `bulkDone`); a throw keeps
 * the dialog open with the error.
 */
export function BulkEdit<T>({
  rows,
  noun,
  fields,
  at,
  onApply,
  size = "md",
}: {
  rows: T[];
  noun: Noun;
  fields: BulkField<T>[];
  at: Save;
  onApply: (changes: BulkChanges) => Promise<Done>;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const n = rows.length;
  const changes = changesOf(draft);
  const changed = Object.keys(changes).length > 0;

  const start = () => {
    setDraft({});
    setError(undefined);
    setOpen(true);
  };
  const put = (id: string, v: Draft[string] | undefined) =>
    setDraft((d) => {
      const next = { ...d };
      if (v === undefined) delete next[id];
      else next[id] = v;
      return next;
    });

  const apply = async () => {
    if (!changed || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const done = await onApply(changes);
      setOpen(false);
      at.show(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button icon={Pencil} size={size} disabled={n === 0} onClick={start}>
        Edit…
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Edit ${countOf(n, noun)}`}
        description={`What you change here is set on every selected ${noun[0]}. Everything you leave alone stays as each ${noun[0]} has it.`}
        width={540}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={pending} disabled={!changed} focusableWhenDisabled onClick={() => void apply()}>
              Apply to {countOf(n, noun)}
            </Button>
          </>
        }
      >
        <div className="flex flex-col">
          {fields.map((f) => (
            <FieldRow key={f.id} field={f} rows={rows} noun={noun} value={draft[f.id]} onChange={(v) => put(f.id, v)} />
          ))}
        </div>
        {error && (
          <p role="alert" className={cn("mt-3 text-[13px] text-danger-text", appearClass)}>
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}

/** Only real changes: a set with nothing added or removed is no change. */
function changesOf(draft: Draft): BulkChanges {
  const out: BulkChanges = {};
  for (const [id, v] of Object.entries(draft)) {
    if (typeof v === "object") {
      const add = Object.keys(v).filter((k) => v[k]);
      const remove = Object.keys(v).filter((k) => !v[k]);
      if (add.length || remove.length) out[id] = { add, remove };
    } else out[id] = v;
  }
  return out;
}

function FieldRow<T>({
  field: f,
  rows,
  noun,
  value,
  onChange,
}: {
  field: BulkField<T>;
  rows: T[];
  noun: Noun;
  value: Draft[string] | undefined;
  /** undefined: untouched again. */
  onChange: (v: Draft[string] | undefined) => void;
}) {
  const labelId = useId();
  const hintId = useId();
  const n = rows.length;
  const changed = value !== undefined && (typeof value !== "object" || Object.keys(value).length > 0);
  const reset = changed && (
    <>
      <span className="text-[12.5px] font-medium text-info">Changed</span>
      <TextButton tone="quiet" className="ml-auto text-[13px]" aria-label={`Keep ${f.label} as each ${noun[0]} has it`} onClick={() => onChange(undefined)}>
        Keep as is
      </TextButton>
    </>
  );
  const head = (label: ReactNode) => (
    <div className="flex min-h-6 items-center gap-2">
      {label}
      {reset}
    </div>
  );
  const hint = f.hint && (
    <p id={hintId} className="mt-1.5 text-[13px] text-fg-muted">
      {f.hint}
    </p>
  );
  const box = "border-t border-border py-4 first:border-t-0 first:pt-0 last:pb-0";

  if (f.kind === "boolean") {
    const common = commonValue(rows, f.get);
    const on = rows.filter(f.get).length;
    const shown: boolean | "mixed" = typeof value === "boolean" ? value : common.mixed ? "mixed" : common.value;
    const word = f.on ?? "on";
    const caption =
      typeof value === "boolean"
        ? `${cap(value ? word : `not ${word}`)} for ${n === 1 ? `the ${noun[0]}` : `all ${countOf(n, noun)}`}`
        : common.mixed
          ? `Mixed: ${word} for ${on} of ${countOf(n, noun)}`
          : undefined;
    return (
      <section className={box}>
        {head(
          <label className="flex items-center gap-3">
            <Checkbox label={f.label} checked={shown} onChange={(v) => onChange(common.mixed || v !== common.value ? v : undefined)} />
            <span className="text-[15px] font-medium">{f.label}</span>
          </label>,
        )}
        {caption && <p className={cn("ml-[30px] mt-1 text-[13px]", value === undefined ? "text-fg-muted" : "text-fg")}>{caption}</p>}
        {hint && <div className="ml-[30px]">{hint}</div>}
      </section>
    );
  }

  if (f.kind === "select") {
    const common = commonValue(rows, f.get);
    const shown = typeof value === "string" ? value : common.mixed ? null : common.value;
    return (
      <section className={box}>
        {head(
          <span id={labelId} className="text-[15px] font-medium">
            {f.label}
          </span>,
        )}
        <div className="mt-2 md:max-w-[280px]">
          <Select aria-label={f.label} value={shown} placeholder="Mixed" items={f.options} onValueChange={(v) => onChange(!common.mixed && v === common.value ? undefined : v)} />
        </div>
        {common.mixed && value === undefined && <p className="mt-1.5 text-[13px] text-fg-muted">{spread(rows, f.get, f.options)}</p>}
        {hint}
      </section>
    );
  }

  if (f.kind === "text") {
    const common = commonValue(rows, f.get);
    const shown = typeof value === "string" ? value : common.mixed ? "" : common.value;
    return (
      <section className={box}>
        {head(
          <label htmlFor={labelId} className="text-[15px] font-medium">
            {f.label}
          </label>,
        )}
        <div className="mt-2 md:max-w-[280px]">
          <Input
            id={labelId}
            mono={f.mono}
            inputMode={f.inputMode}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={f.hint ? hintId : undefined}
            placeholder={common.mixed ? "Mixed" : f.placeholder}
            value={shown}
            onChange={(e) => {
              const v = e.target.value;
              // Back to what every row has, or emptied while mixed: untouched.
              onChange((common.mixed ? v === "" : v === common.value) ? undefined : v);
            }}
          />
        </div>
        {hint}
      </section>
    );
  }

  // A set: one checkbox per option, each a delta on every row.
  const sets = rows.map((r) => f.get(r));
  const picked = typeof value === "object" ? value : {};
  return (
    <section className={box} aria-labelledby={labelId}>
      {head(
        <span id={labelId} className="text-[15px] font-medium">
          {f.label}
        </span>,
      )}
      {hint}
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
        {f.options.map((o) => {
          const has = sets.filter((s) => s.includes(o.value)).length;
          const was: boolean | "mixed" = has === n && n > 0 ? true : has === 0 ? false : "mixed";
          const shown = o.value in picked ? picked[o.value] : was;
          return (
            <li key={o.value}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5">
                <Checkbox
                  label={o.label}
                  checked={shown}
                  onChange={(v) => {
                    const next = { ...picked };
                    if (v === was) delete next[o.value];
                    else next[o.value] = v;
                    onChange(Object.keys(next).length ? next : undefined);
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium">{o.label}</span>
                  {o.detail && <span className="block truncate font-mono text-[12.5px] text-fg-muted">{o.detail}</span>}
                </span>
                {shown === "mixed" && <span className="shrink-0 text-[13px] tabular text-fg-muted">{`${has} of ${n}`}</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Mixed: Gold on 2, Silver on 1", from the rows. */
function spread<T>(rows: T[], get: (r: T) => string, options: SelectOption[]) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(get(r), (counts.get(get(r)) ?? 0) + 1);
  const label = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  return `Mixed: ${[...counts].map(([v, k]) => `${label(v)} on ${k}`).join(", ")}`;
}

/**
 * A bulk call's result for the bar: how many rows changed, and, when some
 * failed, which (by `names[index]`) and why, in red; Undo (the call's one
 * Audit Entry) reverts the rows that did change.
 */
export function bulkDone(res: BulkResult<unknown>, names: string[], noun: Noun): Done {
  const changed = res.items.filter((i) => i.ok && i.outcome !== "unchanged").length;
  const same = res.items.filter((i) => i.ok && i.outcome === "unchanged").length;
  const failed = res.items.filter((i) => !i.ok);
  const entry = res.audit_entry || undefined;
  if (failed.length === 0) {
    if (changed === 0) {
      const all = names.length === 1 ? names[0] : names.length === 2 ? `both ${noun[1]}` : `all ${countOf(names.length, noun)}`;
      return { message: `Nothing changed: ${all} already had that` };
    }
    return { message: `${countOf(changed, noun)} changed${same ? `, ${same} already so` : ""}`, entry };
  }
  // A row deleted meanwhile is named by the list; the server's not_found
  // message would repeat it by its ID.
  const why = (i: (typeof failed)[number]) => (i.error?.code === "not_found" ? "no longer exists" : i.error?.message);
  const named = failed.slice(0, 3).map((i) => `${names[i.index] ?? `#${i.index + 1}`}${why(i) ? ` (${why(i)})` : ""}`);
  const more = failed.length > 3 ? ` and ${failed.length - 3} more` : "";
  const head = changed ? `${countOf(changed, noun)} changed` : "Nothing changed";
  return { message: `${head}${same ? `, ${same} already so` : ""}; not changed: ${named.join(", ")}${more}`, tone: "bad", entry };
}
