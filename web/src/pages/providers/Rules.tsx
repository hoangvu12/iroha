import { useCallback, useState } from "react";
import { Pencil, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { formatNumber, plural } from "@/lib/format";
import { useStoredChoice } from "@/lib/stored-choice";
import { useUrlParams } from "@/lib/url-state";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { useConfirm } from "@/ui/Confirm";
import { DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { Dialog } from "@/ui/Dialog";
import { Field, Input, ToolbarSearch } from "@/ui/Input";
import { MenuItem } from "@/ui/Menu";
import { useIsPhone } from "@/lib/media";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState, ErrorState } from "@/ui/States";
import { SaveError, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import type { Classification, Outcome, Replay, Rule, RuleFields } from "./api";
import { calls, errorText, nameTaken, OUTCOMES, useProvider, useRefresh, useRules } from "./api";
import { Reveal, riseIn } from "@/ui/Reveal";
import { appearClass } from "@/ui/motion";
import { Checkbox, Pill, ringRoom, Segmented, Select, Switch } from "./controls";
import { RulesFlow } from "./RulesFlow";
import { TryFailure } from "./RulesTry";
import { SAMPLE_RULES } from "./samples";
import { rec } from "@/sheets/RecordLink";
import { useMaybeSheets } from "@/sheets/stack";

export function RulesTab({ handle, adding, setAdding }: { handle: string; adding: boolean; setAdding: (o: boolean) => void }) {
  const rules = useRules(handle);
  const refresh = useRefresh();
  const confirm = useConfirm();
  const sheets = useMaybeSheets();
  const open = (r: Rule, edit = false) => {
    const record = rec.rule(handle, r.name);
    if (edit) sheets?.openEditing(record);
    else sheets?.open(record);
  };
  const { params, setParam } = useUrlParams();
  const q = params.get("q") ?? "";
  const setQ = (v: string) => setParam("q", v);
  const [view, setView] = useRulesView();
  const phone = useIsPhone();
  const [flowWidth, flowRef] = useWidth();
  const stacked = phone || (flowWidth !== undefined && flowWidth < 940);
  const provider = useProvider(handle);
  const [tried, setTried] = useState<Classification>();
  const [triedOn, setTriedOn] = useState(rules.data);
  if (triedOn !== rules.data) {
    setTriedOn(rules.data);
    setTried(undefined);
  }

  const askDelete = (r: Rule) =>
    confirm.ask({
      ...deleteQuestion(r),
      onConfirm: async () => {
        const res = await calls.deleteRule(r.name);
        refresh();
        const at = r.overrides ? -1 : (sheets?.stack.findIndex((s) => s.record.kind === "rule" && s.record.provider === handle && s.record.rule === r.name) ?? -1);
        if (at >= 0) sheets?.close(at);
        notifyChange(r.overrides ? `${r.name} restored` : `${r.name} deleted`, res, { onUndone: refresh });
      },
    });

  const menu = (r: Rule) => (
    <RowMenu name={r.name}>
      <MenuItem icon={Pencil} onSelect={() => open(r, true)}>
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
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <p className="text-[15px] text-fg-muted">
          When {handle} fails, the first matching rule decides what happens to the Upstream Key and the Request. Your rules run before built-in ones.
        </p>
        <Segmented<RulesView> label="View" value={view} onChange={setView} items={VIEWS} />
      </div>
      {view === "flow" ? (
        rules.isError && !rules.data ? (
          <ErrorState title="Couldn't load the rules" error={rules.error} onRetry={() => void rules.refetch()} />
        ) : rules.data?.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No rules" description="Add one to decide what a failure from this Provider means." />
        ) : (
          <>
          {rules.data && <TryFailure handle={handle} rules={rules.data} endpoints={provider.data?.endpoints} result={tried} onResult={setTried} />}
          <div
            ref={flowRef}
            className={cn(phone ? "-mx-4 bg-subtle px-4 py-6" : "rounded-xl border border-border bg-subtle px-8 py-8")}
            style={{ backgroundImage: "radial-gradient(var(--border-strong) 1px, transparent 1px)", backgroundSize: "20px 20px" }}
          >
            <Skeleton data={rules.data} sample={SAMPLE_RULES} id={stacked ? "rules-flow:stacked" : "rules-flow"} label="Loading the rules">
              {(list) => <RulesFlow handle={handle} rules={list} onOpen={(r) => open(r)} aside={(r) => <RuleSwitch r={r} />} stacked={stacked} tried={tried} />}
            </Skeleton>
          </div>
          </>
        )
      ) : (
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
            <ToolbarSearch
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
          onRowClick={(r) => open(r)}
          phoneRow={(r) => <RuleLine r={r} />}
          phoneActions={(r) => <RuleSwitch r={r} />}
          empty={<EmptyState icon={ShieldAlert} title="No rules" description="Add one to decide what a failure from this Provider means." />}
          footer={({ shown, total }) => (shown === total ? `${plural(total, "rule")}, in the order they're tried` : `${shown} of ${total} rules`)}
        />
      )}

      {confirm.dialog}
      <AddRuleDialog handle={handle} open={adding} onOpenChange={setAdding} />
    </section>
  );
}

type RulesView = "table" | "flow";
const VIEWS: { value: RulesView; label: string }[] = [
  { value: "table", label: "Table" },
  { value: "flow", label: "Flow" },
];
const useRulesView = () => useStoredChoice<RulesView>("iroha:rules:view", ["table", "flow"], "table");

function useWidth() {
  const [width, setWidth] = useState<number>();
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [width, ref] as const;
}

const matchesText = (r: Rule) => [...(r.code ?? []), ...(r.body ? [r.body] : [])].join(", ");

const searchRules = (r: Rule, needle: string) =>
  !needle || [r.name, r.description ?? "", matchesText(r), (r.status ?? []).join(" "), r.key_effect, r.request_effect].some((s) => s.toLowerCase().includes(needle));

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
    meta: { className: "pl-4", width: "pl-4" },
    cell: ({ row }) => <Pill>{row.original.source === "builtin" ? "Built-in" : "Custom"}</Pill>,
  }),
  col.display({ id: "on", header: "On", cell: ({ row }) => <RuleSwitch r={row.original} /> }),
]);

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

export function RuleSwitch({ r }: { r: Rule }) {
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

export type RuleForm = { name: string; status: string; code: string; body: string; outcome: Outcome; cooling: string; description: string; only: boolean };

export function ruleForm(handle: string, rule?: Rule): RuleForm {
  if (!rule) return { name: "", status: "", code: "", body: "", outcome: "cooling_key", cooling: "", description: "", only: true };
  return {
    name: rule.name,
    status: (rule.status ?? []).join(", "),
    code: (rule.code ?? []).join(", "),
    body: rule.body ?? "",
    outcome: rule.outcome,
    cooling: rule.cooling_seconds ? String(rule.cooling_seconds) : "",
    description: rule.description ?? "",
    only: rule.provider === handle,
  };
}

export function ruleProblem(f: RuleForm): string | undefined {
  if (!f.name.trim()) return "Name the rule, e.g. rate-quota.";
  if (!f.status.trim() && !f.code.trim() && !f.body.trim()) return "Say what it matches: a status, an error code or text in the body.";
}

function ruleFields(f: RuleForm, handle: string, rule?: Rule): RuleFields {
  return {
    status: list(f.status),
    code: list(f.code),
    body: f.body.trim(),
    outcome: f.outcome,
    cooling_seconds: f.outcome.startsWith("cooling") && f.cooling.trim() ? Number(f.cooling) : 0,
    description: f.description.trim(),
    provider: f.only ? handle : rule?.provider && rule.provider !== handle ? rule.provider : "",
    host: rule?.host,
  };
}

export function sendRule(f: RuleForm, handle: string, rule: Rule | undefined, dry: boolean) {
  const fields = ruleFields(f, handle, rule);
  if (!rule) return calls.createRule({ name: f.name.trim(), ...fields }, dry);
  return rule.source === "owner" ? calls.updateRule(rule.name, fields, dry) : calls.putRule(rule.name, fields, dry);
}

export function deleteQuestion(r: Rule) {
  return {
    title: r.overrides ? `Restore the built-in ${r.name}?` : `Delete ${r.name}?`,
    body: r.overrides ? "Your version goes and the built-in rule decides again. Undo brings yours back." : "Failures it matched fall to the next rule. Undo brings it back.",
    confirmLabel: r.overrides ? "Restore built-in" : "Delete rule",
  };
}

export function RuleFormFields({ f, set, handle, isNew }: { f: RuleForm; set: (patch: Partial<RuleForm>) => void; handle: string; isNew: boolean }) {
  const text = (k: "name" | "status" | "code" | "body" | "cooling" | "description") => (e: { target: { value: string } }) => set({ [k]: e.target.value });
  const outcome = OUTCOMES.find((o) => o.value === f.outcome);
  return (
    <>
      <Field label="Name" hint={isNew ? "Letters, digits, dots, dashes and underscores." : undefined}>
        {(p) => <Input {...p} mono autoFocus={isNew} disabled={!isNew} spellCheck={false} placeholder="rate-quota" value={f.name} onChange={text("name")} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Status" hint="429, 5xx, network or timeout; commas between.">
          {(p) => <Input {...p} mono placeholder="429" value={f.status} onChange={text("status")} />}
        </Field>
        <Field label="Error code" hint="error.code or type; billing_* matches a prefix.">
          {(p) => <Input {...p} mono placeholder="Throttling.RateQuota" value={f.code} onChange={text("code")} />}
        </Field>
      </div>
      <Field label="Body contains" hint="A regular expression, case-insensitive.">
        {(p) => <Input {...p} mono placeholder="quota exceeded" value={f.body} onChange={text("body")} />}
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-[1fr_160px]">
        <Field label="Then" hint={outcome?.hint}>
          {() => <Select value={f.outcome} onValueChange={(v) => set({ outcome: v as Outcome })} items={OUTCOMES} />}
        </Field>
        <Reveal open={f.outcome.startsWith("cooling")} label="Cooling time" className={ringRoom}>
          <div className="pt-4 sm:pt-0">
            <Field label="Cool for" hint="Seconds, when the reply names no reset time.">
              {(p) => <Input {...p} inputMode="numeric" placeholder="60" value={f.cooling} onChange={text("cooling")} />}
            </Field>
          </div>
        </Reveal>
      </div>
      <Field label="Description" hint="Optional: what it recognises and why.">
        {(p) => <Input {...p} value={f.description} onChange={text("description")} />}
      </Field>
      <label className="flex items-center gap-3 text-[15px]">
        <Checkbox label={`Only for ${handle}`} checked={f.only} onChange={(on) => set({ only: on })} />
        Only for {handle}
      </label>
    </>
  );
}

export function ReplayNote({ replay }: { replay: Replay }) {
  return (
    <p className={cn("rounded-lg bg-subtle px-4 py-3 text-[14px]", riseIn)}>
      {replay.attempts === 0
        ? "No failed Attempts in the last 7 days to check it against."
        : replay.changed === 0
          ? `The last 7 days' ${formatNumber(replay.attempts)} failed Attempts would be decided the same way.`
          : `${formatNumber(replay.changed)} of the last 7 days' ${formatNumber(replay.attempts)} failed Attempts would be decided differently.`}
    </p>
  );
}

function AddRuleDialog({ handle, open, onOpenChange }: { handle: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const refresh = useRefresh();
  const [f, setF] = useState(() => ruleForm(handle));
  const [replay, setReplay] = useState<Replay>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<"check" | "save">();

  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setReplay(undefined);
      setError(undefined);
      setF(ruleForm(handle));
    }
  }

  const run = async (dry: boolean) => {
    const problem = ruleProblem(f);
    if (problem) return setError(problem);
    setPending(dry ? "check" : "save");
    setError(undefined);
    const name = f.name.trim();
    try {
      const res = await calls.createRule({ name, ...ruleFields(f, handle) }, dry);
      if (dry) setReplay(res.replay);
      else {
        refresh();
        notifyChange(`${name} added`, res, { onUndone: refresh });
        onOpenChange(false);
      }
    } catch (e) {
      setError(nameTaken(e) ? `A rule is already named ${name}. Pick another name, or use Change on ${name} to replace it.` : errorText(e));
    } finally {
      setPending(undefined);
    }
  };

  const set = (patch: Partial<RuleForm>) => {
    setReplay(undefined);
    setF((x) => ({ ...x, ...patch }));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add rule"
      width={580}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={pending === "check"} onClick={() => void run(true)}>
            Check against last week
          </Button>
          <Button variant="primary" loading={pending === "save"} onClick={() => void run(false)}>
            Add rule
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
        <RuleFormFields f={f} set={set} handle={handle} isNew />
        {replay && <ReplayNote replay={replay} />}
        {error && <p className={cn("text-[13px] text-danger-text", appearClass)}>{error}</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
