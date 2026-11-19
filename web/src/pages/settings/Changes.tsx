import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { AuditEntry, Change } from "@/api/types";
import { formatNumber } from "@/lib/format";
import { cn } from "@/ui/cn";
import { ScrollArea } from "@/ui/ScrollArea";
import type { ResourceOption } from "./api";
import { shortDate, clockTime } from "./format";

// The before and after of an opened Audit Entry (C29). Each changed field
// is one row: its old value, an arrow, its new value. Lists (a Pool's
// member order) are numbered, with moved items in bold on the After side.

type Labels = Map<string, ResourceOption>;

const MAX_CHANGES = 8;

/** Fields an Audit Entry snapshot carries that are noise to a person. */
const HIDDEN = new Set(["id", "created_at"]);

export function EntryChanges({ entry, labels }: { entry: AuditEntry; labels: Labels }) {
  const shown = entry.changes.slice(0, MAX_CHANGES);
  const more = entry.changes.length - shown.length;
  const many = entry.changes.length > 1;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {shown.map((c) => (
        <div key={`${c.resource}/${c.id}`} className="min-w-0">
          {many && (
            <p className="mb-2 text-[13px] text-fg-muted">
              {labels.get(c.resource)?.label ?? c.resource} <span className="font-medium text-fg">{c.name}</span> {opWord(c.op)}
            </p>
          )}
          <ChangeRows change={c} />
        </div>
      ))}
      {more > 0 && (
        <p className="text-[13px] text-fg-muted">And {more} more records.</p>
      )}
    </div>
  );
}

function opWord(op: Change["op"]) {
  return op === "create" ? "created" : op === "delete" ? "deleted" : "changed";
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function ChangeRows({ change }: { change: Change }) {
  const before = asRecord(change.before);
  const after = asRecord(change.after);
  let fields: string[];
  if (change.op === "update") fields = change.fields ?? [];
  else fields = Object.keys(change.op === "create" ? after : before).filter((f) => !HIDDEN.has(f) && !isBlank((change.op === "create" ? after : before)[f]));

  if (fields.length === 0) return <p className="text-sm text-fg-muted">No field changed that can be shown.</p>;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] items-start gap-x-4 gap-y-3 text-sm">
      <span className="text-[13px] text-fg-muted">Before</span>
      <span />
      <span className="text-[13px] text-fg-muted">After</span>
      {fields.map((f) => (
        <FieldRow key={f} name={f} op={change.op} before={before[f]} after={after[f]} />
      ))}
    </div>
  );
}

function FieldRow({ name, op, before, after }: { name: string; op: Change["op"]; before: unknown; after: unknown }) {
  const label = <p className="mb-0.5 text-[12px] text-fg-subtle">{fieldLabel(name)}</p>;
  const missing = <span className="text-fg-subtle">{op === "create" ? "Didn't exist" : "Gone"}</span>;
  const moved = Array.isArray(before) && Array.isArray(after) ? after.map((v, i) => JSON.stringify(v) !== JSON.stringify(before[i])) : undefined;
  return (
    <>
      <div className="min-w-0">
        {label}
        {op === "create" ? missing : <Value v={before} />}
      </div>
      <ArrowRight size={15} className="mt-5 text-fg-subtle" aria-label="changed to" />
      <div className="min-w-0">
        {label}
        {op === "delete" ? missing : <Value v={after} strong={moved} />}
      </div>
    </>
  );
}

function isBlank(v: unknown) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** "upstream_key_ids" -> "Upstream key ids". */
export function fieldLabel(f: string) {
  const s = f.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function Scalar({ v }: { v: unknown }): ReactNode {
  if (v === null || v === undefined) return <span className="text-fg-subtle">None</span>;
  if (v === "") return <span className="text-fg-subtle">Empty</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") {
    if (ISO.test(v)) return `${shortDate(v)}, ${clockTime(v)}`;
    if (v.startsWith("…")) return <span className="font-mono text-[13px]">{v}</span>;
    return <span className="break-words">{v}</span>;
  }
  return (
    <ScrollArea className="rounded-md bg-muted" viewportClassName="max-h-40">
      <pre className="whitespace-pre-wrap break-all px-2 py-1 font-mono text-[12px] text-fg">{JSON.stringify(v, null, 2)}</pre>
    </ScrollArea>
  );
}

function Value({ v, strong }: { v: unknown; strong?: boolean[] }) {
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) {
    if (v.length === 0) return <span className="text-fg-subtle">Empty</span>;
    return (
      <ol className="flex flex-col gap-1">
        {v.map((x, i) => (
          <li key={i} className="flex gap-3">
            <span className="w-4 shrink-0 tabular text-fg-subtle">{i + 1}</span>
            <span className={cn("min-w-0", strong?.[i] && "font-semibold")}>
              <Scalar v={x} />
            </span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className="min-w-0">
      <Scalar v={v} />
    </div>
  );
}

/** One or two sentences beside the before and after: what Revert would do, or why it can't. */
export function RevertNote({ entry }: { entry: AuditEntry }) {
  let first: string;
  const c = entry.changes[0];
  if (entry.reverted_by) first = "A later change already reverted this one.";
  else if (!entry.revertible) first = entry.not_revertible ?? "This change can't be reverted.";
  else if (entry.revert_of) first = "This change undid an earlier one. Reverting it makes that change again.";
  else if (entry.changes.length > 1) first = `Reverting puts all ${entry.changes.length} records back as they were before.`;
  else if (c?.op === "create") first = `Reverting deletes ${c.name}.`;
  else if (c?.op === "delete") first = `Reverting brings ${c.name} back.`;
  else {
    const f = (c?.fields ?? []).map((x) => fieldLabel(x).toLowerCase());
    first = f.length ? `Reverting puts the ${joinWords(f)} of ${c?.name} back.` : "Reverting puts the record back as it was.";
  }
  return (
    <div className="text-sm">
      <p className="text-fg">{first}</p>
      {entry.revertible && !entry.reverted_by && <p className="mt-1 text-fg-muted">Requests already served stay as they were.</p>}
    </div>
  );
}

function joinWords(xs: string[]) {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
