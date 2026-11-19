import { useEffect, useMemo, useRef, useState } from "react";
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

/** The text typed, once typing has paused for `ms`: what the server is asked for. */
function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * The Models tab (C08): what Callers see, Model Gaps, and the Owner's additions,
 * hides and overrides. The server searches, filters and pages the list
 * (thousands of models cost one page): `?q=` searches, `?filter=` filters;
 * selected models are hidden or shown together through the bulk API.
 */
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
  const [editing, setEditing] = useState<Model>();
  const confirm = useConfirm();
  const chat = useChatActions();
  const barSave = useSave({ describe: errorText });
  const [busy, setBusy] = useState<"hide" | "show">();

  const setFilter = (f: ModelFilter) => setParam("filter", f === "all" ? undefined : f);

  const totalKeys = keys.data?.length ?? 0;
  const data = models.data;

  // These run from the row's menu, which has closed, and the row may leave the filter.
  const change = async (m: Model, body: { hidden?: boolean; added?: boolean }, what: string) => {
    try {
      const res = await calls.saveModel(handle, { model: m.model, ...body });
      refresh();
      // Toast: the row's menu has closed (and the row may leave the filter).
      notifyChange(what, res, { onUndone: refresh });
    } catch (e) {
      // Toast: an error with nowhere else to go (the row's menu has closed).
      notify.failure(`Couldn't change ${m.model}`, e);
    }
  };
  const clearGaps = async (m: Model) => {
    try {
      const res = await calls.bulkKeys(handle, "clear-model-gaps", m.model_gaps, m.model);
      refresh();
      // Toast: the row's menu has closed, or the row leaves "With Model Gaps".
      notifyChange(gapsCleared(m, res.succeeded), res, { onUndone: refresh });
    } catch (e) {
      // Toast: an error with nowhere else to go (the menu has closed, or the row is leaving).
      notify.failure("Couldn't clear the Model Gaps", e);
    }
  };

  // Hides or shows the selected models (on every page: the selection holds model IDs); the result shows in the bar.
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
      <MenuItem icon={SlidersHorizontal} onSelect={() => setEditing(m)}>
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
                // Toast: the menu and the confirm have closed, and the row leaves the list.
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

  // With "With Model Gaps" shown, a cleared row leaves the list: then the menu's toast is the only place left.
  const columns = useMemo(
    () => modelColumns({ handle, totalKeys, onLeaves: filter === "gaps" ? (m) => void clearGaps(m) : undefined }),
    [handle, totalKeys, filter], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The filter is the server's; as a column filter it sends the table back to page 1 when it changes.
  const columnFilters = useMemo<ColumnFiltersState>(() => (filter === "all" ? [] : [{ id: "model", value: filter }]), [filter]);
  const chips = [
    ...(query ? [{ label: `Search: ${query}`, onRemove: () => setParam("q") }] : []),
    ...(filter !== "all" ? [{ label: filterChip[filter], onRemove: () => setFilter("all") }] : []),
  ];
  const counts = data?.counts;
  const countOf = (f: ModelFilter) => (counts && f !== "all" ? counts[f] : 0);

  const toolbar = (
    <>
      {/* Phones: search and filter have the first line to themselves (C31); the rest wraps under them. */}
      <div className={phone ? "flex w-full items-center gap-2" : "contents"}>
      <ToolbarSearch
        placeholder={data ? `Search ${formatNumber(data.counts.all)} models` : "Search models"}
        aria-label="Search models"
        value={q}
        onChange={(e) => setParam("q", e.target.value)}
      />
      {phone && (
        // The Select is w-full: its box sets the width.
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
        // Toast: the confirm dialog has closed.
        notify.success(`${r.removed.length} discovered model${r.removed.length === 1 ? "" : "s"} forgotten; ${r.kept} kept`);
      },
    });

  return (
    <section aria-label="Models">
      <DataTable<Model>
        id="provider-models"
        label="Models"
        columns={columns}
        // Waits for the keys too, so "Keys with access" arrives filled in. A new page or filter keeps the rows (dimmed).
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
            <SaveStatus save={barSave} saving={false} className="ml-1" />
            <SaveError save={barSave} />
          </>
        )}
        rowActions={menu}
        onRowClick={setEditing}
        phoneRow={(m) => <ModelLine m={m} />}
        // The details dialog has no menu: on phones the row keeps its ⋯.
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
      <ModelDialog handle={handle} model={editing} onClose={() => setEditing(undefined)} />
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

// The server sorts the list by model ID and cuts it into pages, so no column sorts here.
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

/** Phones (C31): a model in two lines. */
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

/** A model's Model Gaps, with Clear: the result (and Undo) shows in the cell, a failure under it. */
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
      // Toast: the Add model dialog closes on success.
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

/** A model's details: where its facts come from, and the Owner's overrides. */
function ModelDialog({ handle, model: current, onClose }: { handle: string; model?: Model; onClose: () => void }) {
  // Motion: the dialog stays mounted while it leaves, still about the model it showed, so its exit plays.
  const last = useRef(current);
  if (current) last.current = current;
  const model = current ?? last.current;
  const refresh = useRefresh();
  const [f, setF] = useState({ context_length: "", max_output_tokens: "", reasoning: "", chat: "" });
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // A model opened (not one closing): start from its overrides.
  useEffect(() => {
    if (!current) return;
    const o = current.overrides;
    setF({
      context_length: o.context_length ? String(o.context_length) : "",
      max_output_tokens: o.max_output_tokens ? String(o.max_output_tokens) : "",
      reasoning: tri(o.reasoning),
      chat: o.chat ?? "",
    });
    setError(undefined);
  }, [current]);

  if (!model) return null;
  const save = async () => {
    const metadata: Facts = { ...model.overrides };
    const cl = num(f.context_length);
    const mo = num(f.max_output_tokens);
    if ((cl !== undefined && !(cl > 0)) || (mo !== undefined && !(mo > 0))) return setError("Token counts are whole numbers above 0.");
    if (cl) metadata.context_length = cl;
    else delete metadata.context_length;
    if (mo) metadata.max_output_tokens = mo;
    else delete metadata.max_output_tokens;
    if (f.reasoning) metadata.reasoning = f.reasoning === "yes";
    else delete metadata.reasoning;
    if (f.chat) metadata.chat = f.chat as "ok" | "unsupported";
    else delete metadata.chat;
    setPending(true);
    try {
      const res = await calls.saveModel(handle, { model: model.model, metadata });
      refresh();
      // Toast: the Details dialog closes on Save.
      notifyChange(`${model.model} details saved`, res, { onUndone: refresh });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  const from = (k: keyof Facts) =>
    model.overrides[k] !== undefined ? "yours" : model.reported[k] !== undefined ? `${handle}'s list` : model.models_dev[k] !== undefined ? "models.dev" : "";
  const shown = (k: "context_length" | "max_output_tokens") => model.reported[k] ?? model.models_dev[k];

  return (
    <Dialog
      open={!!current}
      onOpenChange={(o) => !o && onClose()}
      title={<span className="font-mono">{model.model}</span>}
      description={[
        model.visible ? "Listed to Callers" : model.hidden ? "Hidden from Callers" : "Not listed",
        model.discovered ? `named by ${model.endpoints.length ? model.endpoints.join(", ") : "discovery"}` : "added by you",
      ].join(", ")}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={() => void save()}>
            Save details
          </Button>
        </>
      }
    >
      <p className="mb-4 text-[14px] text-fg-muted">
        What Callers' model lists say of it. Empty fields use {handle}'s own list, then models.dev. They never change routing.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Context window" hint={from("context_length") && `Now ${ctx(model.metadata.context_length)}, from ${from("context_length")}`}>
          {(p) => <Input {...p} inputMode="numeric" placeholder={shown("context_length") ? String(shown("context_length")) : "tokens"} value={f.context_length} onChange={(e) => setF((x) => ({ ...x, context_length: e.target.value }))} />}
        </Field>
        <Field label="Max output" hint={from("max_output_tokens") && `Now ${ctx(model.metadata.max_output_tokens)}, from ${from("max_output_tokens")}`}>
          {(p) => <Input {...p} inputMode="numeric" placeholder={shown("max_output_tokens") ? String(shown("max_output_tokens")) : "tokens"} value={f.max_output_tokens} onChange={(e) => setF((x) => ({ ...x, max_output_tokens: e.target.value }))} />}
        </Field>
        <Field label="Reasons before answering" hint={model.metadata.reasoning !== undefined && !f.reasoning ? `Now ${model.metadata.reasoning ? "yes" : "no"}` : undefined}>
          {() => <Select value={f.reasoning} onValueChange={(v) => setF((x) => ({ ...x, reasoning: v }))} items={[{ value: "", label: "Not set" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />}
        </Field>
        <Field label="Chat" hint="Embedding, speech and image models don't chat.">
          {() => <Select value={f.chat} onValueChange={(v) => setF((x) => ({ ...x, chat: v }))} items={[{ value: "", label: "Not set" }, { value: "ok", label: "Chats" }, { value: "unsupported", label: "Doesn't chat" }]} />}
        </Field>
      </div>
      {model.model_gaps.length > 0 && (
        <p className="mt-5 text-[14px] text-fg-muted">
          Model Gap on {model.model_gaps.join(", ")}: these keys aren't tried for {model.model} until the gap ends or is cleared.
        </p>
      )}
      {error && <p className="mt-3 text-[13px] text-danger-text">{error}</p>}
    </Dialog>
  );
}
