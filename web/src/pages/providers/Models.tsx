import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Eye, EyeOff, ListPlus, ListX, MessageCircle, MoreHorizontal, Plus, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useChatActions } from "@/app/chat-panel";
import { formatNumber, timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { useUrlParams } from "@/lib/url-state";
import { Button, TextButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { useConfirm } from "@/ui/Confirm";
import { type ColumnFiltersState, DataTable, RowMenu, columnsFor, useTablePaging } from "@/ui/DataTable";
import { Dialog } from "@/ui/Dialog";
import { Field, Input, ToolbarSearch } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuIconTrigger } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { notify, notifyChange } from "@/ui/toast";
import type { Facts, Model, ModelFilter } from "./api";
import { calls, errorText, MODEL_FILTERS, useKeys, useModels, useRefresh } from "./api";
import { Pill, Segmented, Select } from "./controls";
import { SAMPLE_MODEL_LIST } from "./samples";
import { ModelsBulkEdit } from "./BulkEdits";
import { rec } from "@/sheets/RecordLink";
import { useMaybeSheets } from "@/sheets/stack";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const ctx = (n?: number) => (n ? compact.format(n) : "–");

const filterLabel: Record<ModelFilter, string> = {
  all: "All",
  visible: "Listed",
  discovered: "Discovered",
  added: "Added",
  hidden: "Hidden",
  gaps: "With Model Gaps",
};
const filterChip: Record<ModelFilter, string> = { ...filterLabel, all: "All models", visible: "Listed to Callers" };

function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ModelsTab({ handle }: { handle: string }) {
  const { params, setParam, setParams } = useUrlParams();
  const q = params.get("q") ?? "";
  const filter = (MODEL_FILTERS as string[]).includes(params.get("filter") ?? "") ? (params.get("filter") as ModelFilter) : "all";
  const query = useDebounced(q.trim());
  const [pagination, setPagination] = useTablePaging("provider-models");
  const models = useModels(handle, { q: query, filter, offset: pagination.pageIndex * pagination.pageSize, limit: pagination.pageSize });
  const keys = useKeys(handle);
  const refresh = useRefresh();
  const phone = useIsPhone();
  const [adding, setAdding] = useState(false);
  const sheets = useMaybeSheets();
  const open = (m: Model, edit = false) => {
    const r = rec.model(handle, m.model);
    if (edit) sheets?.openEditing(r);
    else sheets?.open(r);
  };
  const confirm = useConfirm();
  const chat = useChatActions();
  const barSave = useSave({ refresh, describe: errorText });
  const [busy, setBusy] = useState<"hide" | "show">();

  const setFilter = (f: ModelFilter) => setParam("filter", f === "all" ? undefined : f);

  const totalKeys = keys.data?.length ?? 0;
  const data = models.data;
  const seen = useRef(new Map<string, Model>());
  for (const m of data?.models ?? []) seen.current.set(m.model, m);

  const change = async (m: Model, body: { hidden?: boolean; added?: boolean }, what: string) => {
    try {
      const res = await calls.saveModel(handle, { model: m.model, ...body });
      refresh();
      notifyChange(what, res, { onUndone: refresh });
    } catch (e) {
      notify.failure(`Couldn't change ${m.model}`, e);
    }
  };
  const clearGaps = useCallback(
    async (m: Model) => {
      try {
        const res = await calls.bulkKeys(handle, "clear-model-gaps", m.model_gaps, m.model);
        refresh();
        notifyChange(gapsCleared(m, res.succeeded), res, { onUndone: refresh });
      } catch (e) {
        notify.failure("Couldn't clear the Model Gaps", e);
      }
    },
    [handle, refresh],
  );

  const hideAll = (names: string[], hidden: boolean) => {
    setBusy(hidden ? "hide" : "show");
    void barSave
      .run(
        async () => {
          const res = await calls.saveModels(handle, names.map((model) => ({ model, hidden })));
          await refresh();
          return res;
        },
        {
          message: (res) => {
            const n = res.succeeded;
            const what = `${n} model${n === 1 ? "" : "s"} ${hidden ? "hidden" : "shown to Callers"}`;
            return res.failed ? { message: `${what}; ${res.failed} refused`, tone: "bad" } : what;
          },
        },
      )
      .finally(() => setBusy(undefined));
  };

  const menu = (m: Model) => (
    <RowMenu name={m.model}>
      <MenuItem icon={SlidersHorizontal} onSelect={() => open(m, true)}>
        Details…
      </MenuItem>
      <MenuItem icon={MessageCircle} onSelect={() => chat.open({ kind: "model", provider: handle, model: m.model })}>
        Test in Chat
      </MenuItem>
      {m.hidden ? (
        <MenuItem icon={Eye} onSelect={() => void change(m, { hidden: false }, `${m.model} shown to Callers`)}>
          Show to Callers
        </MenuItem>
      ) : (
        <MenuItem icon={EyeOff} onSelect={() => void change(m, { hidden: true }, `${m.model} hidden`)}>
          Hide from Callers
        </MenuItem>
      )}
      {m.added && m.discovered ? (
        <MenuItem icon={ListX} onSelect={() => void change(m, { added: false }, `${m.model} no longer pinned`)}>
          Unpin
        </MenuItem>
      ) : m.added ? (
        <MenuItem
          icon={ListX}
          danger
          onSelect={() =>
            confirm.ask({
              title: `Remove ${m.model} from ${handle}?`,
              body: `Callers stop seeing ${m.model} in ${handle}'s model list. Undo brings it back.`,
              confirmLabel: "Remove model",
              onConfirm: async () => {
                const res = await calls.saveModel(handle, { model: m.model, added: false });
                refresh();
                notifyChange(`${m.model} removed`, res, { onUndone: refresh });
              },
            })
          }
        >
          Remove from the list…
        </MenuItem>
      ) : (
        <MenuItem icon={ListPlus} onSelect={() => void change(m, { added: true }, `${m.model} pinned to the list`)}>
          Pin to the list
        </MenuItem>
      )}
      {m.model_gaps.length > 0 && (
        <>
          <MenuSeparator />
          <MenuItem icon={Eraser} onSelect={() => void clearGaps(m)}>
            Clear Model Gaps
          </MenuItem>
        </>
      )}
    </RowMenu>
  );

  const columns = useMemo(
    () => modelColumns({ handle, totalKeys, onLeaves: filter === "gaps" ? (m) => void clearGaps(m) : undefined }),
    [handle, totalKeys, filter, clearGaps],
  );
  const columnFilters = useMemo<ColumnFiltersState>(() => (filter === "all" ? [] : [{ id: "model", value: filter }]), [filter]);
  const chips = [
    ...(query ? [{ label: `Search: ${query}`, onRemove: () => setParam("q") }] : []),
    ...(filter !== "all" ? [{ label: filterChip[filter], onRemove: () => setFilter("all") }] : []),
  ];
  const counts = data?.counts;
  const countOf = (f: ModelFilter) => (counts && f !== "all" ? counts[f] : 0);

  const toolbar = (
    <>
      <div className={phone ? "flex w-full items-center gap-2" : "contents"}>
      <ToolbarSearch
        placeholder={data ? `Search ${formatNumber(data.counts.all)} models` : "Search models"}
        aria-label="Search models"
        value={q}
        onChange={(e) => setParam("q", e.target.value)}
      />
      {phone && (
        <div className="w-32 shrink-0">
          <Select<ModelFilter> aria-label="Show models" value={filter} onValueChange={setFilter} items={MODEL_FILTERS.map((f) => ({ value: f, label: f === "gaps" ? "Gaps" : filterLabel[f] }))} />
        </div>
      )}
      </div>
      {!phone && (
        <Segmented<ModelFilter>
          label="Show models"
          value={filter}
          onChange={setFilter}
          items={MODEL_FILTERS.map((f) => ({
            value: f,
            label: (
              <>
                {filterLabel[f]}
                {countOf(f) > 0 && <span className="ml-1.5 text-fg-muted tabular">{formatNumber(countOf(f))}</span>}
              </>
            ),
          }))}
        />
      )}
      <div className="flex-1" />
      {data?.last_refresh && (
        <span className="text-[14px] text-fg-muted" title={data.last_refresh.summary}>
          {data.last_refresh.outcome === "failed" ? "Refresh failed " : "Updated "}
          {timeAgo(data.last_refresh.at)}
        </span>
      )}
      <ToolbarActions onAdd={() => setAdding(true)} onReset={() => askReset()} />
    </>
  );

  const askReset = () =>
    confirm.ask({
      title: "Forget discovered models?",
      body: `Iroha forgets every model ${handle}'s lists named and reads them again on the next refresh. Models you added, hid or gave details to stay.`,
      confirmLabel: "Forget them",
      onConfirm: async () => {
        const r = await calls.resetModels(handle);
        refresh();
        notify.success(`${r.removed.length} discovered model${r.removed.length === 1 ? "" : "s"} forgotten; ${r.kept} kept`);
      },
    });

  return (
    <section aria-label="Models">
      <DataTable<Model>
        id="provider-models"
        label="Models"
        columns={columns}
        data={keys.isPending ? undefined : data?.models}
        sample={SAMPLE_MODEL_LIST.models}
        getRowId={(m) => m.model}
        rowName={(m) => m.model}
        error={models.isError ? models.error : undefined}
        errorTitle="Couldn't load the models"
        onRetry={() => void models.refetch()}
        toolbar={toolbar}
        search={query}
        columnFilters={columnFilters}
        manualFiltering
        filterChips={chips}
        onClearFilters={() => setParams({ q: undefined, filter: undefined })}
        noResultsTitle="No models match"
        paging={{ mode: "server", pagination, onPaginationChange: setPagination, rowCount: data?.total ?? 0 }}
        dimmed={models.isPlaceholderData}
        bulk={({ ids }) => (
          <>
            <Button icon={EyeOff} onClick={() => hideAll(ids, true)} loading={busy === "hide"} size={phone ? "sm" : "md"}>
              Hide
            </Button>
            <Button icon={Eye} onClick={() => hideAll(ids, false)} loading={busy === "show"} size={phone ? "sm" : "md"}>
              Show
            </Button>
            <ModelsBulkEdit handle={handle} rows={ids.flatMap((id) => seen.current.get(id) ?? [])} at={barSave} size={phone ? "sm" : "md"} />
            <SaveStatus save={barSave} saving={false} className="ml-1" />
            <SaveError save={barSave} />
          </>
        )}
        rowActions={menu}
        onRowClick={(m) => open(m)}
        phoneRow={(m) => <ModelLine m={m} />}
        phoneActions={menu}
        empty={
          <EmptyState
            icon={ListPlus}
            title="No models yet"
            description={
              data?.discovery === "none" ? `${handle} doesn't discover models. Add the ones Callers may ask for.` : "Refresh the list to read it from the Provider, or add models yourself."
            }
            action={<Button onClick={() => setAdding(true)}>Add model</Button>}
          />
        }
        footer={({ shown, from, to }) => (
          <span className="tabular">
            {from}–{to} of {formatNumber(shown)} model{shown === 1 ? "" : "s"}
          </span>
        )}
      />

      {confirm.dialog}
      <AddModelDialog handle={handle} open={adding} onOpenChange={setAdding} />
    </section>
  );
}

function ToolbarActions({ onAdd, onReset }: { onAdd: () => void; onReset: () => void }) {
  return (
    <>
      <Button icon={Plus} onClick={onAdd}>
        Add model
      </Button>
      <Menu>
        <MenuIconTrigger icon={MoreHorizontal} label="More model list actions" bordered />
        <MenuContent>
          <MenuItem icon={RotateCcw} danger onSelect={onReset}>
            Forget discovered models…
          </MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
}

const tags = (m: Model) => (
  <>
    {m.hidden && <Pill>Hidden</Pill>}
    {m.added && !m.discovered && <Pill>Added</Pill>}
    {m.metadata.chat === "unsupported" && <Pill>Not chat</Pill>}
  </>
);

const col = columnsFor<Model>();
function modelColumns({ handle, totalKeys, onLeaves }: { handle: string; totalKeys: number; onLeaves?: (m: Model) => void }) {
  return col.columns([
    col.accessor("model", {
      header: "Model",
      enableSorting: false,
      meta: { opens: true },
      cell: ({ row }) => (
        <span className={cn("flex min-w-0 items-center gap-2", row.original.hidden && "text-fg-muted")}>
          <span className="truncate font-mono text-[14px]">{row.original.model}</span>
          {tags(row.original)}
        </span>
      ),
    }),
    col.accessor((m) => m.metadata.context_length ?? 0, {
      id: "context",
      header: "Context",
      enableSorting: false,
      meta: { align: "right", width: "w-[10%]" },
      cell: ({ row }) => ctx(row.original.metadata.context_length),
    }),
    col.display({
      id: "keys",
      header: "Keys with access",
      meta: { align: "right", width: "w-[14%]" },
      cell: ({ row }) => (totalKeys ? `${totalKeys - row.original.model_gaps.length} of ${totalKeys}` : "–"),
    }),
    col.display({
      id: "gaps",
      header: "Model Gaps",
      meta: { width: "w-[18%] pl-6", className: "pl-6" },
      cell: ({ row }) => <GapsCell handle={handle} m={row.original} onLeaves={onLeaves && (() => onLeaves(row.original))} />,
    }),
  ]);
}

function ModelLine({ m }: { m: Model }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        <span className="truncate font-mono text-[15px]">{m.model}</span>
        {tags(m)}
      </span>
      <span className="block text-[14px] text-fg-muted">
        {ctx(m.metadata.context_length)} context · {m.model_gaps.length ? `Model Gap on ${m.model_gaps.length}` : "no Model Gaps"}
      </span>
    </span>
  );
}

const gapsCleared = (m: Model, n: number) => `Model Gaps for ${m.model} cleared on ${n} key${n === 1 ? "" : "s"}`;

function GapsCell({ handle, m, onLeaves }: { handle: string; m: Model; onLeaves?: () => void }) {
  const refresh = useRefresh();
  const saving = useSave({ refresh, describe: errorText });
  if (saving.done || saving.pending) return <SaveStatus save={saving} />;
  if (!m.model_gaps.length) return <span className="text-fg-muted">None</span>;
  const clear = () =>
    onLeaves ? onLeaves() : void saving.run(() => calls.bulkKeys(handle, "clear-model-gaps", m.model_gaps, m.model), { message: (r) => `Cleared on ${r.succeeded} key${r.succeeded === 1 ? "" : "s"}` });
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex items-center gap-2" title={m.model_gaps.join(", ")}>
        <Pill tone="blue">{m.model_gaps.length === 1 ? "1 key" : `${m.model_gaps.length} keys`}</Pill>
        <TextButton className="text-[14px]" aria-label={`Clear the Model Gaps of ${m.model}`} onClick={clear}>
          Clear
        </TextButton>
      </span>
      <SaveError save={saving} className="text-[12.5px]" />
    </span>
  );
}

function AddModelDialog({ handle, open, onOpenChange }: { handle: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const refresh = useRefresh();
  const [model, setModel] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setModel("");
      setError(undefined);
    }
  };
  const submit = async () => {
    const m = model.trim();
    if (!m) return setError("Type the model ID exactly as the Provider names it.");
    setPending(true);
    try {
      const res = await calls.saveModel(handle, { model: m, added: true });
      refresh();
      notifyChange(`${m} added`, res, { onUndone: refresh });
      close(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Add model"
      description="Callers see it whatever discovery finds. Use it for models the Provider's list leaves out."
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-model" loading={pending}>
            Add model
          </Button>
        </>
      }
    >
      <form
        id="add-model"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Model ID" hint="Case-sensitive; may contain /." error={error}>
          {(p) => <Input {...p} mono autoFocus spellCheck={false} placeholder="qwen3-coder-plus" value={model} onChange={(e) => setModel(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

const tri = (b?: boolean) => (b === undefined ? "" : b ? "yes" : "no");
const num = (s: string) => (s.trim() ? Number(s.replace(/[_,\s]/g, "")) : undefined);

export const tokens = ctx;

export type ModelForm = { context_length: string; max_output_tokens: string; reasoning: string; chat: string };

export function modelForm(m: Model): ModelForm {
  const o = m.overrides;
  return {
    context_length: o.context_length ? String(o.context_length) : "",
    max_output_tokens: o.max_output_tokens ? String(o.max_output_tokens) : "",
    reasoning: tri(o.reasoning),
    chat: o.chat ?? "",
  };
}

export function modelMetadata(m: Model, f: ModelForm): { metadata: Facts } | { error: string } {
  const metadata: Facts = { ...m.overrides };
  const cl = num(f.context_length);
  const mo = num(f.max_output_tokens);
  if ((cl !== undefined && !(cl > 0)) || (mo !== undefined && !(mo > 0))) return { error: "Token counts are whole numbers above 0." };
  if (cl) metadata.context_length = cl;
  else delete metadata.context_length;
  if (mo) metadata.max_output_tokens = mo;
  else delete metadata.max_output_tokens;
  if (f.reasoning) metadata.reasoning = f.reasoning === "yes";
  else delete metadata.reasoning;
  if (f.chat) metadata.chat = f.chat as "ok" | "unsupported";
  else delete metadata.chat;
  return { metadata };
}

export function factSource(m: Model, handle: string, k: keyof Facts): string {
  return m.overrides[k] !== undefined ? "you" : m.reported[k] !== undefined ? `${handle}'s list` : m.models_dev[k] !== undefined ? "models.dev" : "";
}

export function ModelFields({ m, handle, f, setF }: { m: Model; handle: string; f: ModelForm; setF: (u: (f: ModelForm) => ModelForm) => void }) {
  const from = (k: keyof Facts) => factSource(m, handle, k);
  const shown = (k: "context_length" | "max_output_tokens") => m.reported[k] ?? m.models_dev[k];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Context window" hint={from("context_length") && `Now ${ctx(m.metadata.context_length)}, from ${from("context_length")}`}>
        {(p) => <Input {...p} inputMode="numeric" placeholder={shown("context_length") ? String(shown("context_length")) : "tokens"} value={f.context_length} onChange={(e) => setF((x) => ({ ...x, context_length: e.target.value }))} />}
      </Field>
      <Field label="Max output" hint={from("max_output_tokens") && `Now ${ctx(m.metadata.max_output_tokens)}, from ${from("max_output_tokens")}`}>
        {(p) => <Input {...p} inputMode="numeric" placeholder={shown("max_output_tokens") ? String(shown("max_output_tokens")) : "tokens"} value={f.max_output_tokens} onChange={(e) => setF((x) => ({ ...x, max_output_tokens: e.target.value }))} />}
      </Field>
      <Field label="Reasons before answering" hint={m.metadata.reasoning !== undefined && !f.reasoning ? `Now ${m.metadata.reasoning ? "yes" : "no"}` : undefined}>
        {() => <Select value={f.reasoning} onValueChange={(v) => setF((x) => ({ ...x, reasoning: v }))} items={[{ value: "", label: "Not set" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />}
      </Field>
      <Field label="Chat" hint="Embedding, speech and image models don't chat.">
        {() => <Select value={f.chat} onValueChange={(v) => setF((x) => ({ ...x, chat: v }))} items={[{ value: "", label: "Not set" }, { value: "ok", label: "Chats" }, { value: "unsupported", label: "Doesn't chat" }]} />}
      </Field>
    </div>
  );
}
