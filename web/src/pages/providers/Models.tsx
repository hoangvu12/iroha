import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Eraser, Eye, EyeOff, ListPlus, ListX, MoreHorizontal, Plus, RotateCcw, SlidersHorizontal } from "lucide-react";
import { formatNumber, timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { ConfirmDialog, Dialog } from "@/ui/Dialog";
import { Field, Input, SearchInput } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { EmptyState, ErrorState, NoResults } from "@/ui/States";
import { Skeleton } from "@/ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/ui/Table";
import { notify, notifyChange } from "@/ui/toast";
import type { Facts, Model, ModelFilter } from "./api";
import { calls, errorText, MODEL_PAGE, useKeys, useModels, useRefresh } from "./api";
import { Pill, Segmented, Select } from "./controls";
import { SAMPLE_MODEL_LIST } from "./samples";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const ctx = (n?: number) => (n ? compact.format(n) : "–");

/** The Models tab (C08): what Callers see, Model Gaps, and the Owner's additions, hides and overrides. */
export function ModelsTab({ handle }: { handle: string }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [offset, setOffset] = useState(0);
  const models = useModels(handle, { q: query, filter, offset });
  const keys = useKeys(handle);
  const refresh = useRefresh();
  const phone = useIsPhone();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Model>();
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const totalKeys = keys.data?.length ?? 0;
  const data = models.data;

  const change = async (m: Model, body: { hidden?: boolean; added?: boolean }, what: string) => {
    try {
      const res = await calls.saveModel(handle, { model: m.model, ...body });
      refresh();
      notifyChange(what, res, { onUndone: refresh });
    } catch (e) {
      notify.failure(`Couldn't change ${m.model}`, e);
    }
  };
  const clearGaps = async (m: Model) => {
    try {
      const res = await calls.bulkKeys(handle, "clear-model-gaps", m.model_gaps, m.model);
      refresh();
      notifyChange(`Model Gaps for ${m.model} cleared on ${res.succeeded} key${res.succeeded === 1 ? "" : "s"}`, res, { onUndone: refresh });
    } catch (e) {
      notify.failure("Couldn't clear the Model Gaps", e);
    }
  };

  const menu = (m: Model) => (
    <Menu>
      <MenuTrigger asChild>
        <IconButton icon={MoreHorizontal} label={`More for ${m.model}`} size="sm" />
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={SlidersHorizontal} onSelect={() => setEditing(m)}>
          Details…
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
        {m.added ? (
          <MenuItem icon={ListX} onSelect={() => void change(m, { added: false }, m.discovered ? `${m.model} no longer pinned` : `${m.model} removed`)}>
            {m.discovered ? "Unpin" : "Remove from the list"}
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
      </MenuContent>
    </Menu>
  );

  const gapsCell = (m: Model) =>
    m.model_gaps.length ? (
      <span className="inline-flex items-center gap-2" title={m.model_gaps.join(", ")}>
        <Pill tone="blue">{m.model_gaps.length === 1 ? "1 key" : `${m.model_gaps.length} keys`}</Pill>
        <button type="button" className="text-[14px] text-info hover:underline" onClick={(e) => (e.stopPropagation(), void clearGaps(m))}>
          Clear
        </button>
      </span>
    ) : (
      <span className="text-fg-muted">None</span>
    );

  const tags = (m: Model) => (
    <>
      {m.hidden && <Pill>Hidden</Pill>}
      {m.added && !m.discovered && <Pill>Added</Pill>}
      {m.metadata.chat === "unsupported" && <Pill>Not chat</Pill>}
    </>
  );

  return (
    <section aria-label="Models">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput
          className="min-w-0 flex-1 md:max-w-[340px] md:flex-none"
          placeholder={data ? `Search ${formatNumber(data.counts.all)} models` : "Search models"}
          aria-label="Search models"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Segmented<ModelFilter>
          label="Show models"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setOffset(0);
          }}
          items={[
            { value: "all", label: "All" },
            { value: "gaps", label: phone ? "Gaps" : "With Model Gaps" },
            { value: "hidden", label: "Hidden" },
          ]}
        />
        <div className="flex-1" />
        {data?.last_refresh && (
          <span className="text-[14px] text-fg-muted" title={data.last_refresh.summary}>
            {data.last_refresh.outcome === "failed" ? "Refresh failed " : "Updated "}
            {timeAgo(data.last_refresh.at)}
          </span>
        )}
        <Button icon={Plus} onClick={() => setAdding(true)}>
          Add model
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <IconButton icon={MoreHorizontal} label="More model list actions" bordered />
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={RotateCcw} danger onSelect={() => setResetting(true)}>
              Forget discovered models…
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {models.isError ? (
        <ErrorState title="Couldn't load the models" error={models.error} onRetry={() => void models.refetch()} />
      ) : (
      // Waits for the keys too, so "Keys with access" arrives filled in. A new page or filter keeps the rows (dimmed).
      <Skeleton
        data={keys.isPending ? undefined : data}
        sample={SAMPLE_MODEL_LIST}
        id={phone ? "provider-models:phone" : "provider-models"}
        label="Loading models"
      >
      {(data) => data && data.total === 0 && !query && filter === "all" ? (
        <EmptyState
          icon={ListPlus}
          title="No models yet"
          description={
            data.discovery === "none"
              ? `${handle} doesn't discover models. Add the ones Callers may ask for.`
              : "Refresh the list to read it from the Provider, or add models yourself."
          }
          action={<Button onClick={() => setAdding(true)}>Add model</Button>}
        />
      ) : data && data.models.length === 0 ? (
        <NoResults
          title="No models match"
          filters={[
            ...(query ? [{ label: `Search: ${query}`, onRemove: () => setQ("") }] : []),
            ...(filter !== "all" ? [{ label: filter === "gaps" ? "With Model Gaps" : "Hidden", onRemove: () => setFilter("all") }] : []),
          ]}
          onClear={() => {
            setQ("");
            setFilter("all");
          }}
        />
      ) : data && phone ? (
        <ul className={cn("divide-y divide-border border-y border-border", models.isPlaceholderData && "opacity-60")}>
          {data.models.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(m)}>
                <span className="flex items-center gap-2">
                  <span className="truncate font-mono text-[15px]">{m.model}</span>
                  {tags(m)}
                </span>
                <span className="block text-[14px] text-fg-muted">
                  {ctx(m.metadata.context_length)} context · {m.model_gaps.length ? `Model Gap on ${m.model_gaps.length}` : "no Model Gaps"}
                </span>
              </button>
              {menu(m)}
            </li>
          ))}
        </ul>
      ) : data ? (
        <div className={cn(models.isPlaceholderData && "opacity-60")}>
          <Table>
            <THead>
              <tr>
                <TH>Model</TH>
                <TH align="right" className="w-[10%]">
                  Context
                </TH>
                <TH align="right" className="w-[14%]">
                  Keys with access
                </TH>
                <TH className="w-[18%] pl-6">Model Gaps</TH>
                <TH className="w-10">
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {data.models.map((m) => (
                <TR key={m.id} interactive onClick={() => setEditing(m)} className={cn(m.hidden && "text-fg-muted")}>
                  <TD>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-[14px]">{m.model}</span>
                      {tags(m)}
                    </span>
                  </TD>
                  <TD align="right">{ctx(m.metadata.context_length)}</TD>
                  <TD align="right">{totalKeys ? `${totalKeys - m.model_gaps.length} of ${totalKeys}` : "–"}</TD>
                  <TD className="pl-6" onClick={(e) => e.stopPropagation()}>
                    {gapsCell(m)}
                  </TD>
                  <TD align="right" onClick={(e) => e.stopPropagation()}>
                    {menu(m)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : null}
      </Skeleton>
      )}

      {data && data.total > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[14px] text-fg-muted tabular">
            {data.offset + 1}–{data.offset + data.models.length} of {formatNumber(data.total)}
          </span>
          {data.total > MODEL_PAGE && (
            <span className="flex gap-2">
              <IconButton icon={ChevronLeft} label="Previous page" bordered disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - MODEL_PAGE))} />
              <IconButton
                icon={ChevronRight}
                label="Next page"
                bordered
                disabled={offset + MODEL_PAGE >= data.total}
                onClick={() => setOffset((o) => o + MODEL_PAGE)}
              />
            </span>
          )}
        </div>
      )}

      <AddModelDialog handle={handle} open={adding} onOpenChange={setAdding} />
      <ModelDialog handle={handle} model={editing} onClose={() => setEditing(undefined)} />
      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Forget discovered models?"
        body={`Iroha forgets every model ${handle}'s lists named and reads them again on the next refresh. Models you added, hid or gave details to stay.`}
        confirmLabel="Forget them"
        onConfirm={async () => {
          const r = await calls.resetModels(handle);
          refresh();
          notify.success(`${r.removed.length} discovered model${r.removed.length === 1 ? "" : "s"} forgotten; ${r.kept} kept`);
        }}
      />
    </section>
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

/** A model's details: where its facts come from, and the Owner's overrides. */
function ModelDialog({ handle, model, onClose }: { handle: string; model?: Model; onClose: () => void }) {
  const refresh = useRefresh();
  const [f, setF] = useState({ context_length: "", max_output_tokens: "", reasoning: "", chat: "" });
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!model) return;
    const o = model.overrides;
    setF({
      context_length: o.context_length ? String(o.context_length) : "",
      max_output_tokens: o.max_output_tokens ? String(o.max_output_tokens) : "",
      reasoning: tri(o.reasoning),
      chat: o.chat ?? "",
    });
    setError(undefined);
  }, [model]);

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
      open
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
          {(p) => (
            <Select {...p} value={f.reasoning} onChange={(e) => setF((x) => ({ ...x, reasoning: e.target.value }))}>
              <option value="">Not set</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          )}
        </Field>
        <Field label="Chat" hint="Embedding, speech and image models don't chat.">
          {(p) => (
            <Select {...p} value={f.chat} onChange={(e) => setF((x) => ({ ...x, chat: e.target.value }))}>
              <option value="">Not set</option>
              <option value="ok">Chats</option>
              <option value="unsupported">Doesn't chat</option>
            </Select>
          )}
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
