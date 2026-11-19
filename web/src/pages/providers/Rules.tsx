import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Pencil, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { api, isApiError, seg } from "@/api/client";
import { formatNumber } from "@/lib/format";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { useConfirm } from "@/ui/Confirm";
import { DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { Dialog } from "@/ui/Dialog";
import { Field, Input, SearchInput } from "@/ui/Input";
import { MenuItem } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { SaveError, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import type { Outcome, Replay, Rule, RuleFields } from "./api";
import { calls, errorText, OUTCOMES, useRefresh, useRules } from "./api";
import { Checkbox, Pill, Select, Switch } from "./controls";
import { SAMPLE_RULES } from "./samples";

/** The Rules tab (C09): which Failure Rules decide this Provider's failures, in order, and how often each did today. */
export function RulesTab({ handle, adding, setAdding }: { handle: string; adding: boolean; setAdding: (o: boolean) => void }) {
  const rules = useRules(handle);
  const refresh = useRefresh();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Rule>();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const setQ = (v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set("q", v);
        else n.delete("q");
        return n;
      },
      { replace: true },
    );

  // Asks first, naming the rule; the result (with Undo) toasts, since the confirm has closed.
  const askDelete = (r: Rule) =>
    confirm.ask({
      title: r.overrides ? `Restore the built-in ${r.name}?` : `Delete ${r.name}?`,
      body: r.overrides ? "Your version goes and the built-in rule decides again. Undo brings yours back." : "Failures it matched fall to the next rule. Undo brings it back.",
      confirmLabel: r.overrides ? "Restore built-in" : "Delete rule",
      onConfirm: async () => {
        const res = await calls.deleteRule(r.name);
        refresh();
        // Toast: the confirm dialog has closed; Undo after a delete.
        notifyChange(r.overrides ? `${r.name} restored` : `${r.name} deleted`, res, { onUndone: refresh });
      },
    });

  const menu = (r: Rule) => (
    <RowMenu name={r.name}>
      <MenuItem icon={Pencil} onSelect={() => setEditing(r)}>
        {r.source === "builtin" ? "Change (as your rule)…" : "Edit…"}
      </MenuItem>
      {r.source === "owner" && (
        <MenuItem icon={r.overrides ? RotateCcw : Trash2} danger onSelect={() => askDelete(r)}>
          {r.overrides ? "Restore the built-in rule…" : "Delete…"}
        </MenuItem>
      )}
    </RowMenu>
  );

  return (
    <section aria-label="Failure Rules">
      <p className="mb-4 text-[15px] text-fg-muted">
        When {handle} fails, the first matching rule decides what happens to the Upstream Key and the Request. Your rules run before built-in ones.
      </p>
      <DataTable<Rule>
        id="provider-rules"
        label="Failure Rules"
        columns={columns}
        data={rules.data}
        sample={SAMPLE_RULES}
        getRowId={(r) => r.name}
        rowName={(r) => r.name}
        error={rules.isError ? rules.error : undefined}
        errorTitle="Couldn't load the rules"
        onRetry={() => void rules.refetch()}
        toolbar={
          <SearchInput
            className="min-w-0 flex-1 md:max-w-[320px] md:flex-none"
            placeholder="Search rules"
            aria-label="Search rules"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        }
        search={q}
        searchFn={searchRules}
        filterChips={q ? [{ label: `Search: ${q}`, onRemove: () => setQ("") }] : []}
        onClearFilters={() => setQ("")}
        noResultsTitle="No rules match"
        rowActions={menu}
        onRowClick={setEditing}
        phoneRow={(r) => <RuleLine r={r} />}
        phoneActions={(r) => <RuleSwitch r={r} />}
        empty={<EmptyState icon={ShieldAlert} title="No rules" description="Add one to decide what a failure from this Provider means." />}
        footer={({ shown, total }) => (shown === total ? `${total} rule${total === 1 ? "" : "s"}, in the order they're tried` : `${shown} of ${total} rules`)}
      />

      {confirm.dialog}
      <RuleDialog handle={handle} open={adding} onOpenChange={setAdding} />
      <RuleDialog handle={handle} rule={editing} open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} />
    </section>
  );
}

const matchesText = (r: Rule) => [...(r.code ?? []), ...(r.body ? [r.body] : [])].join(", ");

const searchRules = (r: Rule, needle: string) =>
  !needle || [r.name, r.description ?? "", matchesText(r), (r.status ?? []).join(" "), r.key_effect, r.request_effect].some((s) => s.toLowerCase().includes(needle));

// Rules keep the order they are tried in (the first match decides), so no column sorts.
const col = columnsFor<Rule>();
const columns = col.columns([
  col.accessor("name", {
    header: "Name",
    enableSorting: false,
    meta: { className: "text-[15px] font-medium", opens: true },
    cell: ({ row }) => (
      <span title={row.original.description} className={cn(!row.original.enabled && "text-fg-muted")}>
        {row.original.name}
      </span>
    ),
  }),
  col.accessor((r) => (r.status ?? []).join(", "), {
    id: "status",
    header: "Status",
    enableSorting: false,
    meta: { className: "font-mono text-[13px]" },
    cell: ({ row }) => (row.original.status?.length ? row.original.status.join(", ") : "Any"),
  }),
  col.accessor(matchesText, {
    id: "body",
    header: "Body contains",
    enableSorting: false,
    meta: { className: "max-w-[220px] truncate" },
    cell: ({ row }) => (matchesText(row.original) ? <span className="font-mono text-[13px]">{matchesText(row.original)}</span> : <span className="text-fg-muted">Any</span>),
  }),
  col.accessor("key_effect", { header: "Upstream Key", enableSorting: false, meta: { className: "whitespace-nowrap" } }),
  col.accessor("request_effect", { header: "Request", enableSorting: false, meta: { className: "whitespace-nowrap" } }),
  col.accessor("hits", { header: "Hits today", enableSorting: false, meta: { align: "right" }, cell: ({ row }) => formatNumber(row.original.hits) }),
  col.display({
    id: "source",
    header: "Source",
    meta: { className: "pl-4", width: "pl-4" /* the header lines up with the pills */ },
    cell: ({ row }) => <Pill>{row.original.source === "builtin" ? "Built-in" : "Custom"}</Pill>,
  }),
  col.display({ id: "on", header: "On", cell: ({ row }) => <RuleSwitch r={row.original} /> }),
]);

/** Phones (C31): a rule in two lines, with its switch. */
function RuleLine({ r }: { r: Rule }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-[16px] font-medium", !r.enabled && "text-fg-muted")}>{r.name}</span>
          <Pill>{r.source === "builtin" ? "Built-in" : "Custom"}</Pill>
        </span>
        <span className="block truncate text-[14px] text-fg-muted">
          {matchText(r)} · {r.key_effect} · {formatNumber(r.hits)} today
        </span>
      </span>
    </>
  );
}

/** A rule's On switch: shows its new state while it saves (and the result is read out); a failure puts it back and shows under it. */
function RuleSwitch({ r }: { r: Rule }) {
  const refresh = useRefresh();
  const saving = useSave({ refresh, describe: errorText });
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Switch
        checked={r.enabled}
        pending={saving.pending}
        onChange={(on) => void saving.run(() => calls.switchRule(r.name, on), { message: `${r.name} switched ${on ? "on" : "off"}`, undoable: false })}
        label={`${r.name} on`}
      />
      <SaveError save={saving} className="max-w-56 text-[12.5px] leading-snug" />
    </span>
  );
}

function matchText(r: Rule): string {
  const parts = [r.status?.length ? r.status.join("/") : "any status", ...(r.code ?? []), ...(r.body ? [r.body] : [])];
  return parts.join(" ");
}

const list = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function RuleDialog({ handle, rule, open, onOpenChange }: { handle: string; rule?: Rule; open: boolean; onOpenChange: (o: boolean) => void }) {
  const refresh = useRefresh();
  const empty = { name: "", status: "", code: "", body: "", outcome: "cooling_key" as Outcome, cooling: "", description: "", only: true };
  const [f, setF] = useState(empty);
  const [replay, setReplay] = useState<Replay>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<"check" | "save">();

  useEffect(() => {
    if (!open) return;
    setReplay(undefined);
    setError(undefined);
    setF(
      rule
        ? {
            name: rule.name,
            status: (rule.status ?? []).join(", "),
            code: (rule.code ?? []).join(", "),
            body: rule.body ?? "",
            outcome: rule.outcome,
            cooling: rule.cooling_seconds ? String(rule.cooling_seconds) : "",
            description: rule.description ?? "",
            only: rule.provider === handle,
          }
        : empty,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule]);

  const fields = (): RuleFields => ({
    status: list(f.status),
    code: list(f.code),
    body: f.body.trim(),
    outcome: f.outcome,
    cooling_seconds: f.outcome.startsWith("cooling") && f.cooling.trim() ? Number(f.cooling) : 0,
    description: f.description.trim(),
    provider: f.only ? handle : rule?.provider && rule.provider !== handle ? rule.provider : "",
    host: rule?.host,
  });

  // Owner rules change in place; a built-in rule is changed by adding an owner rule of its name.
  const send = (dry: boolean) =>
    rule && rule.source === "owner" ? calls.updateRule(rule.name, fields(), dry) : calls.createRule({ name: f.name.trim(), ...fields() }, dry);

  const run = async (dry: boolean) => {
    if (!f.name.trim()) return setError("Name the rule, e.g. rate-quota.");
    if (!f.status.trim() && !f.code.trim() && !f.body.trim()) return setError("Say what it matches: a status, an error code or text in the body.");
    setPending(dry ? "check" : "save");
    setError(undefined);
    try {
      // POST /api/rules updates (or overrides) a rule of that name, so a new rule's name must be free.
      if (!rule) {
        const name = f.name.trim();
        const taken = await api.get<Rule>(`/api/rules/${seg(name)}`).then(
          (r) => r,
          (e) => (isApiError(e) && e.status === 404 ? undefined : Promise.reject(e)),
        );
        if (taken)
          return setError(
            taken.source === "builtin"
              ? `${name} is a built-in rule. Pick another name, or use Change on ${name} to replace it.`
              : `A rule is already named ${name}${taken.provider && taken.provider !== handle ? ` (for ${taken.provider})` : ""}. Pick another name.`,
          );
      }
      const res = await send(dry);
      if (dry) setReplay(res.replay);
      else {
        refresh();
        // Toast: the rule dialog closes on Save.
        notifyChange(rule ? `${f.name.trim()} saved` : `${f.name.trim()} added`, res, { onUndone: refresh });
        onOpenChange(false);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(undefined);
    }
  };

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setReplay(undefined);
    setF((x) => ({ ...x, [k]: e.target.value }));
  };
  const outcome = OUTCOMES.find((o) => o.value === f.outcome);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={rule ? (rule.source === "builtin" ? `Change ${rule.name}` : `Edit ${rule.name}`) : "Add rule"}
      description={rule?.source === "builtin" ? "Saving adds your own rule of this name, which replaces the built-in one until you restore it." : rule?.description}
      width={580}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={pending === "check"} onClick={() => void run(true)}>
            Check against last week
          </Button>
          <Button variant="primary" loading={pending === "save"} onClick={() => void run(false)}>
            {rule ? "Save rule" : "Add rule"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(false);
        }}
      >
        <Field label="Name" hint={rule ? undefined : "Letters, digits, dots, dashes and underscores."}>
          {(p) => <Input {...p} mono autoFocus={!rule} disabled={!!rule} spellCheck={false} placeholder="rate-quota" value={f.name} onChange={set("name")} />}
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Status" hint="429, 5xx, network or timeout; commas between.">
            {(p) => <Input {...p} mono placeholder="429" value={f.status} onChange={set("status")} />}
          </Field>
          <Field label="Error code" hint="error.code or type; billing_* matches a prefix.">
            {(p) => <Input {...p} mono placeholder="Throttling.RateQuota" value={f.code} onChange={set("code")} />}
          </Field>
        </div>
        <Field label="Body contains" hint="A regular expression, case-insensitive.">
          {(p) => <Input {...p} mono placeholder="quota exceeded" value={f.body} onChange={set("body")} />}
        </Field>
        <div className="grid gap-4 md:grid-cols-[1fr_160px]">
          <Field label="Then" hint={outcome?.hint}>
            {() => <Select value={f.outcome} onValueChange={(v) => set("outcome")({ target: { value: v } })} items={OUTCOMES} />}
          </Field>
          {f.outcome.startsWith("cooling") && (
            <Field label="Cool for" hint="Seconds, when the reply names no reset time.">
              {(p) => <Input {...p} inputMode="numeric" placeholder="60" value={f.cooling} onChange={set("cooling")} />}
            </Field>
          )}
        </div>
        <Field label="Description" hint="Optional: what it recognises and why.">
          {(p) => <Input {...p} value={f.description} onChange={set("description")} />}
        </Field>
        <label className="flex items-center gap-3 text-[15px]">
          <Checkbox
            label={`Only for ${handle}`}
            checked={f.only}
            onChange={(on) => {
              setReplay(undefined);
              setF((x) => ({ ...x, only: on }));
            }}
          />
          Only for {handle}
        </label>
        {replay && (
          <p className="rounded-lg bg-subtle px-4 py-3 text-[14px]">
            {replay.attempts === 0
              ? "No failed Attempts in the last 7 days to check it against."
              : replay.changed === 0
                ? `The last 7 days' ${formatNumber(replay.attempts)} failed Attempts would be decided the same way.`
                : `${formatNumber(replay.changed)} of the last 7 days' ${formatNumber(replay.attempts)} failed Attempts would be decided differently.`}
          </p>
        )}
        {error && <p className="text-[13px] text-danger-text">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
