import { useEffect, useState } from "react";
import { MoreHorizontal, Pencil, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { ConfirmDialog, Dialog } from "@/ui/Dialog";
import { Field, Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/Menu";
import { EmptyState, ErrorState } from "@/ui/States";
import { Table, TableSkeleton, TBody, TD, TH, THead, TR } from "@/ui/Table";
import { notify, notifyChange } from "@/ui/toast";
import type { Outcome, Replay, Rule, RuleFields } from "./api";
import { calls, errorText, OUTCOMES, useRefresh, useRules } from "./api";
import { Checkbox, Pill, Select, Switch } from "./controls";

/** The Rules tab (C09): which Failure Rules decide this Provider's failures, in order, and how often each did today. */
export function RulesTab({ handle, adding, setAdding }: { handle: string; adding: boolean; setAdding: (o: boolean) => void }) {
  const rules = useRules(handle);
  const refresh = useRefresh();
  const phone = useIsPhone();
  const [editing, setEditing] = useState<Rule>();
  const [deleting, setDeleting] = useState<Rule>();

  const flip = async (r: Rule, on: boolean) => {
    try {
      const res = await calls.switchRule(r.name, on);
      refresh();
      notifyChange(`${r.name} switched ${on ? "on" : "off"}`, res, { onUndone: refresh });
    } catch (e) {
      notify.failure(`Couldn't switch ${r.name}`, e);
    }
  };

  const menu = (r: Rule) => (
    <Menu>
      <MenuTrigger asChild>
        <IconButton icon={MoreHorizontal} label={`More for ${r.name}`} size="sm" />
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={Pencil} onSelect={() => setEditing(r)}>
          {r.source === "builtin" ? "Change (as your rule)…" : "Edit…"}
        </MenuItem>
        {r.source === "owner" && (
          <MenuItem icon={r.overrides ? RotateCcw : Trash2} danger={!r.overrides} onSelect={() => setDeleting(r)}>
            {r.overrides ? "Restore the built-in rule…" : "Delete…"}
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );

  const list = rules.data ?? [];
  return (
    <section aria-label="Failure Rules">
      <p className="mb-4 text-[15px] text-fg-muted">
        When {handle} fails, the first matching rule decides what happens to the Upstream Key and the Request. Your rules run before built-in ones.
      </p>
      {rules.isPending ? (
        <TableSkeleton columns={["Name", "Status", "Body contains", "Upstream Key", "Request", "Hits today"]} rows={6} />
      ) : rules.isError ? (
        <ErrorState title="Couldn't load the rules" error={rules.error} onRetry={() => void rules.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="No rules" description="Add one to decide what a failure from this Provider means." />
      ) : phone ? (
        <ul className="divide-y divide-border border-y border-border">
          {list.map((r) => (
            <li key={r.name} className="flex items-center gap-3 py-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(r)}>
                <span className="flex items-center gap-2">
                  <span className={cn("truncate text-[16px] font-medium", !r.enabled && "text-fg-muted")}>{r.name}</span>
                  <Pill>{r.source === "builtin" ? "Built-in" : "Custom"}</Pill>
                </span>
                <span className="block truncate text-[14px] text-fg-muted">
                  {matchText(r)} · {r.key_effect} · {formatNumber(r.hits)} today
                </span>
              </button>
              <Switch checked={r.enabled} onChange={(on) => void flip(r, on)} label={`${r.name} on`} />
            </li>
          ))}
        </ul>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Name</TH>
              <TH>Status</TH>
              <TH>Body contains</TH>
              <TH>Upstream Key</TH>
              <TH>Request</TH>
              <TH align="right">Hits today</TH>
              <TH className="pl-4">Source</TH>
              <TH>On</TH>
              <TH className="w-10">
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {list.map((r) => (
              <TR key={r.name} interactive onClick={() => setEditing(r)} className={cn(!r.enabled && "text-fg-muted")}>
                <TD className="text-[15px] font-medium" title={r.description}>
                  {r.name}
                </TD>
                <TD mono>{r.status?.length ? r.status.join(", ") : "Any"}</TD>
                <TD className="max-w-[220px] truncate">
                  {r.body || r.code?.length ? <span className="font-mono text-[13px]">{[...(r.code ?? []), ...(r.body ? [r.body] : [])].join(", ")}</span> : <span className="text-fg-muted">Any</span>}
                </TD>
                <TD className="whitespace-nowrap">{r.key_effect}</TD>
                <TD className="whitespace-nowrap">{r.request_effect}</TD>
                <TD align="right">{formatNumber(r.hits)}</TD>
                <TD className="pl-4">
                  <Pill>{r.source === "builtin" ? "Built-in" : "Custom"}</Pill>
                </TD>
                <TD onClick={(e) => e.stopPropagation()}>
                  <Switch checked={r.enabled} onChange={(on) => void flip(r, on)} label={`${r.name} on`} />
                </TD>
                <TD align="right" onClick={(e) => e.stopPropagation()}>
                  {menu(r)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <RuleDialog handle={handle} open={adding} onOpenChange={setAdding} />
      <RuleDialog handle={handle} rule={editing} open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={deleting?.overrides ? `Restore the built-in ${deleting.name}?` : `Delete ${deleting?.name}?`}
        body={deleting?.overrides ? "Your version goes and the built-in rule decides again. Undo brings yours back." : "Failures it matched fall to the next rule. Undo brings it back."}
        confirmLabel={deleting?.overrides ? "Restore built-in" : "Delete rule"}
        onConfirm={async () => {
          if (!deleting) return;
          const res = await calls.deleteRule(deleting.name);
          refresh();
          notifyChange(deleting.overrides ? `${deleting.name} restored` : `${deleting.name} deleted`, res, { onUndone: refresh });
        }}
      />
    </section>
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
      const res = await send(dry);
      if (dry) setReplay(res.replay);
      else {
        refresh();
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
            {(p) => (
              <Select {...p} value={f.outcome} onChange={set("outcome")}>
                {OUTCOMES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
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
