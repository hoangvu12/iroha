import { useState } from "react";
import { Pencil, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { DialogTitle } from "@ui-sdk/react/dialog";
import { formatNumber, timeAgo } from "@/lib/format";
import { calls, errorText, type Replay, type Rule, useRefresh, useRules } from "@/pages/providers/api";
import { deleteQuestion, ReplayNote, RuleFormFields, type RuleForm, ruleForm, ruleProblem, RuleSwitch, sendRule } from "@/pages/providers/Rules";
import { RuleStep, scopeWords } from "@/pages/providers/RulesFlow";
import { Pill } from "@/pages/providers/controls";
import { Button } from "@/ui/Button";
import { useConfirm } from "@/ui/Confirm";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import { rec, RecordLink } from "../RecordLink";
import { recordKey, writeStack } from "../records";
import { Fact, Facts, none, SheetActions, SheetBar, SheetBody, SheetLoading, SheetProblem, SheetSection, SheetTitle } from "../Sheet";
import type { SheetBodyProps } from "../SheetStack";
import { useSheets } from "../stack";
import { useEditing } from "./editing";

/**
 * A Failure Rule as it applies to one Provider (UI ticket 33: it was the
 * Rules tab's edit dialog): the rule in words as the Flow view draws it, its
 * place in the order, today's hits on the Provider, then Edit in place.
 * Read from the Provider's rule list (`GET /api/rules?provider=`), which
 * the Rules tab already holds: that list alone has the order and the hits
 * on this Provider.
 */
export default function RuleSheet({ record }: SheetBodyProps<"rule">) {
  const { provider, rule } = record;
  const rules = useRules(provider);
  const page = `/providers/${encodeURIComponent(provider)}/rules${writeStack("", [rec.rule(provider, rule)])}`;
  const list = rules.data;
  const at = list?.findIndex((r) => r.name === rule) ?? -1;

  if (!list || at < 0)
    return (
      <>
        <SheetBar kind="Failure Rule" page={page} />
        {rules.isError ? (
          <SheetProblem kind="Failure Rule" name={rule} error={rules.error} onRetry={() => void rules.refetch()} />
        ) : list ? (
          <div className="p-6">
            <DialogTitle className="mb-2 text-[17px] font-semibold">
              No Failure Rule {rule} for {provider}
            </DialogTitle>
            <p className="text-[14.5px] text-fg-muted">It may have been deleted, or it applies only to other Providers.</p>
          </div>
        ) : (
          <SheetLoading name={`Failure Rule ${rule}`} />
        )}
      </>
    );

  return (
    <>
      <SheetBar kind="Failure Rule" page={page} />
      <RuleDetails key={rule} r={list[at]} n={at + 1} count={list.length} most={Math.max(0, ...list.map((x) => x.hits))} provider={provider} />
    </>
  );
}

function RuleDetails({ r, n, count, most, provider }: { r: Rule; n: number; count: number; most: number; provider: string }) {
  const sheets = useSheets();
  const confirm = useConfirm();
  const refresh = useRefresh();
  const saving = useSave({ refresh, describe: errorText });
  const [editing, setEditing] = useEditing(rec.rule(provider, r.name));
  const [f, setF] = useState<RuleForm>(() => ruleForm(provider, r));
  const [replay, setReplay] = useState<Replay>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const builtin = r.source === "builtin";

  const edit = () => {
    setF(ruleForm(provider, r));
    setReplay(undefined);
    setError(undefined);
    setEditing(true);
  };
  const set = (patch: Partial<RuleForm>) => {
    setReplay(undefined);
    setF((x) => ({ ...x, ...patch }));
  };

  const check = async () => {
    const problem = ruleProblem(f);
    if (problem) return setError(problem);
    setError(undefined);
    setChecking(true);
    try {
      setReplay((await sendRule(f, provider, r, true)).replay);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  };
  const save = () => {
    const problem = ruleProblem(f);
    if (problem) return setError(problem);
    setError(undefined);
    void saving.run(() => sendRule(f, provider, r, false), { message: `${r.name} saved` }).then((ok) => ok && setEditing(false));
  };

  // Restore keeps the rule (the built-in decides again), so its result shows here; a deleted rule's sheet closes and the result toasts.
  const askDelete = () =>
    confirm.ask({
      ...deleteQuestion(r),
      onConfirm: async () => {
        if (r.overrides) {
          await saving.run(() => calls.deleteRule(r.name), { message: `${r.name} restored` });
          setEditing(false);
          return;
        }
        const res = await calls.deleteRule(r.name);
        void refresh();
        // Toast: the rule's sheet closes with the rule.
        notifyChange(`${r.name} deleted`, res, { onUndone: refresh });
        const at = sheets.stack.findIndex((s) => recordKey(s.record) === recordKey(rec.rule(provider, r.name)));
        if (at >= 0) sheets.close(at);
      },
    });

  const scope = scopeWords(r);
  return (
    <SheetBody>
      <SheetTitle
        kind="Failure Rule"
        logo={
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-fg-muted">
            <ShieldAlert size={20} aria-hidden />
          </span>
        }
        title={r.name}
        subtitle={
          <>
            Rule {n} of {count} for <RecordLink record={rec.provider(provider)}>{provider}</RecordLink>
          </>
        }
        state={r.overrides ? <Pill tone="blue">Replaces built-in</Pill> : <Pill>{builtin ? "Built-in" : "Custom"}</Pill>}
      />
      <SheetActions>
        <RuleSwitch r={r} />
        {!editing && (
          <Button icon={Pencil} onClick={edit}>
            {builtin ? `Change ${r.name}` : `Edit ${r.name}`}
          </Button>
        )}
        {r.source === "owner" && (
          <Button variant="ghost" danger icon={r.overrides ? RotateCcw : Trash2} onClick={askDelete}>
            {r.overrides ? `Restore the built-in ${r.name}…` : `Delete ${r.name}…`}
          </Button>
        )}
        {!editing && <SaveStatus save={saving} saving={false} />}
      </SheetActions>

      {editing ? (
        <SheetSection title={builtin ? "Change" : "Edit"}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {builtin && <p className="text-[14px] text-fg-muted">Saving adds your own rule of this name, which replaces the built-in one until you restore it.</p>}
            <RuleFormFields f={f} set={set} handle={provider} isNew={false} />
            {replay && <ReplayNote replay={replay} />}
            <SaveError save={saving} error={error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button loading={checking} onClick={() => void check()}>
                Check against last week
              </Button>
              <Button type="submit" variant="primary" loading={saving.pending}>
                Save rule
              </Button>
            </div>
          </form>
        </SheetSection>
      ) : (
        <>
          <SheetSection title="In the flow">
            {/* As the Flow view draws it: what it matches, its source and scope, and what a match does. */}
            <RuleStep r={r} n={n} most={most} stacked />
            <SaveError save={saving} className="mt-3" />
          </SheetSection>
          <SheetSection title="Facts">
            <Facts>
              <Fact label="Hits today">{formatNumber(r.hits)}</Fact>
              <Fact label="Last hit">{r.last_hit_at ? timeAgo(r.last_hit_at) : none}</Fact>
              <Fact label="Applies to">{scope ? scope.replace(/^only /, "Only ").replace(/^on /, "Endpoints on ") : "Every Provider"}</Fact>
              <Fact label="Order">
                {n} of {count}
              </Fact>
              {r.overrides && (
                <Fact label="Built-in did" wide>
                  {r.builtin_key_effect ?? r.overrides.outcome}
                </Fact>
              )}
              <Fact label="Description" wide>
                {r.description || none}
              </Fact>
            </Facts>
          </SheetSection>
        </>
      )}
      {confirm.dialog}
    </SheetBody>
  );
}
