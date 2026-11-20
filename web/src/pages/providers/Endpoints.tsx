import { useMemo, useState } from "react";
import { Pencil, Plug, Trash2 } from "lucide-react";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { useConfirm } from "@/ui/Confirm";
import { useCopy } from "@/ui/CopyButton";
import { DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { Dialog } from "@/ui/Dialog";
import { Field, Input } from "@/ui/Input";
import { MenuItem, MenuSeparator } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { notifyChange } from "@/ui/toast";
import type { AuthStyle, Endpoint, Provider, Shape, UpstreamKey } from "./api";
import { AUTH_STYLES, calls, errorText, natural, shapeLabel, SHAPES, useKeys, useRefresh } from "./api";
import { Reveal } from "@/ui/Reveal";
import { appearClass, ringRoom, Select } from "./controls";
import { SAMPLE_ENDPOINTS } from "./samples";
import { rec } from "@/sheets/RecordLink";
import { startEditing } from "@/sheets/records/editing";
import { useMaybeSheets } from "@/sheets/stack";

/** The Endpoints tab (C07): where a Provider's API lives, in which Shape, and which keys go there. */
export function EndpointsTab({
  handle,
  provider,
  adding,
  setAdding,
}: {
  handle: string;
  provider?: Provider;
  adding: boolean;
  setAdding: (o: boolean) => void;
}) {
  const keys = useKeys(handle);
  const refresh = useRefresh();
  const confirm = useConfirm();
  const sheets = useMaybeSheets();
  const eps = provider?.endpoints ?? [];
  // An Endpoint opens in its sheet, which edits it too (UI ticket 27); Edit… opens it on its fields.
  const open = (e: Endpoint, edit = false) => {
    const r = rec.endpoint(handle, e.name);
    if (edit) startEditing(r);
    sheets?.open(r);
  };

  // Each Endpoint with the keys that go there, so the table's cells and sorts read one row.
  const rows = useMemo<EndpointRow[] | undefined>(() => {
    if (!provider || keys.isPending) return undefined; // Waits for the keys too, so the Keys column arrives filled in.
    const all = keys.data ?? [];
    return provider.endpoints.map((e) => ({ ...e, keys: keys.data ? all.filter((k: UpstreamKey) => k.endpoints.length === 0 || k.endpoints.includes(e.name)).length : undefined, allKeys: all.length }));
  }, [provider, keys.isPending, keys.data]);

  // Asks first, naming the Endpoint; the row is gone afterwards, so the result (with Undo) toasts.
  const askDelete = (e: Endpoint) =>
    confirm.ask({
      title: `Delete ${e.name}?`,
      body: `Iroha stops sending Requests to ${e.url}. Keys limited to it alone stop being used. Undo brings it back.`,
      confirmLabel: "Delete endpoint",
      onConfirm: async () => {
        const res = await calls.deleteEndpoint(handle, e.name);
        refresh();
        // Its sheet, if open, closes with it.
        const at = sheets?.stack.findIndex((s) => s.record.kind === "endpoint" && s.record.provider === handle && s.record.endpoint === e.name) ?? -1;
        if (at >= 0) sheets?.close(at);
        // Toast: the confirm dialog has closed and the row is gone; Undo after a delete.
        notifyChange(`Endpoint ${e.name} deleted`, res, { onUndone: refresh });
      },
    });

  return (
    <section aria-label="Endpoints">
      <DataTable<EndpointRow>
        id="provider-endpoints"
        label="Endpoints"
        columns={columns}
        data={rows}
        sample={SAMPLE_ENDPOINT_ROWS}
        getRowId={(e) => e.id}
        rowName={(e) => e.name}
        rowActions={(e) => <EndpointMenu e={e} onEdit={(x) => open(x, true)} onDelete={askDelete} />}
        onRowClick={(e) => open(e)}
        phoneRow={(e) => <EndpointLine e={e} />}
        empty={
          <EmptyState
            icon={Plug}
            title="No Endpoints"
            description={`Add the URL of ${handle}'s API. Iroha sends Requests there with the Upstream Keys.`}
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add endpoint
              </Button>
            }
          />
        }
        footer={({ total }) => `${total} Endpoint${total === 1 ? "" : "s"}`}
      />

      {confirm.dialog}
      <AddEndpointDialog handle={handle} existing={eps} open={adding} onOpenChange={setAdding} />
    </section>
  );
}

/** An Endpoint with how many Upstream Keys go there (`undefined` until the keys load). */
type EndpointRow = Endpoint & { keys?: number; allKeys: number };

const SAMPLE_ENDPOINT_ROWS: EndpointRow[] = SAMPLE_ENDPOINTS.map((e) => ({ ...e, keys: 24, allKeys: 24 }));

const keysText = (e: EndpointRow) => {
  if (e.keys === undefined) return "–";
  if (e.keys === e.allKeys) return e.allKeys ? "All keys" : "No keys";
  return `${e.keys} key${e.keys === 1 ? "" : "s"}`;
};

const col = columnsFor<EndpointRow>();
const columns = col.columns([
  col.accessor("name", {
    header: "Name",
    sortFn: (a, b) => natural(a.original.name, b.original.name),
    meta: { width: "w-[16%]", className: "text-[15px] font-medium", opens: true },
    cell: ({ row }) => <span className="truncate">{row.original.name}</span>,
  }),
  col.accessor("url", {
    header: "URL",
    sortFn: (a, b) => a.original.url.localeCompare(b.original.url) || natural(a.original.name, b.original.name),
    meta: { className: "max-w-0 truncate font-mono text-[13px] text-fg-muted" },
    cell: ({ row }) => <span title={row.original.url}>{row.original.url}</span>,
  }),
  col.accessor((e) => shapeLabel(e.shape), {
    id: "shape",
    header: "Shape",
    sortFn: (a, b) => shapeLabel(a.original.shape).localeCompare(shapeLabel(b.original.shape)) || natural(a.original.name, b.original.name),
    meta: { width: "w-[18%]" },
  }),
  col.accessor((e) => e.keys ?? -1, {
    id: "keys",
    header: "Keys",
    sortFn: (a, b) => (a.original.keys ?? -1) - (b.original.keys ?? -1) || natural(a.original.name, b.original.name),
    meta: { width: "w-[12%]" },
    cell: ({ row }) => keysText(row.original),
  }),
]);

/** Phones (C31): an Endpoint in two lines. */
function EndpointLine({ e }: { e: EndpointRow }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-[16px] font-medium">{e.name}</span>
        <span className="shrink-0 text-[14px] text-fg-muted">{shapeLabel(e.shape)}</span>
      </span>
      <span className="block truncate font-mono text-[13px] text-fg-muted">{e.url}</span>
    </span>
  );
}

const linesToMap = (text: string, sep: RegExp) => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(sep);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
};
const HEADER_LINE = /^\s*([^:]+?)\s*:\s*(.*)$/;
const RENAME_LINE = /^\s*(\S+)\s*(?:->|=>|→)\s*(\S+)\s*$/;

/** An Endpoint's fields as the form holds them (none: a new one). */
export const endpointFields = (endpoint?: Endpoint) => ({
  name: endpoint?.name ?? "",
  url: endpoint?.url ?? "",
  shape: endpoint?.shape ?? ("openai-chat" as Shape),
  auth_style: endpoint?.auth_style ?? ("bearer" as AuthStyle),
  auth_param: endpoint?.auth_param ?? "",
  discovery_url: endpoint?.discovery_url ?? "",
  headers: Object.entries(endpoint?.static_headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n"),
  renames: Object.entries(endpoint?.renames ?? {})
    .map(([k, v]) => `${k} -> ${v}`)
    .join("\n"),
});

export type EndpointForm = ReturnType<typeof endpointFields>;

/**
 * What's wrong with the form, or the body to send. Used by the Add endpoint
 * dialog and by an Endpoint's sheet (UI ticket 27), which edits it in place.
 */
export function endpointBody(f: EndpointForm, handle: string, existing: Endpoint[], endpoint?: Endpoint): { error: string } | { body: Partial<Endpoint> } {
  if (!f.url.trim()) return { error: "The URL is required: the Endpoint's URL with its version path." };
  // Creating with a taken name would update that Endpoint instead.
  const clash = existing.find((e) => e.name === f.name.trim() && e.id !== endpoint?.id);
  if (f.name.trim() && clash) return { error: `${handle} already has an Endpoint named ${clash.name}. Pick another name${endpoint ? "" : ", or edit that one"}.` };
  const body: Partial<Endpoint> = {
    url: f.url.trim(),
    shape: f.shape,
    auth_style: f.auth_style,
    auth_param: f.auth_style === "header" || f.auth_style === "query" ? f.auth_param.trim() : undefined,
    discovery_url: f.discovery_url.trim(),
    static_headers: linesToMap(f.headers, HEADER_LINE),
    renames: linesToMap(f.renames, RENAME_LINE),
  };
  if (f.name.trim()) body.name = f.name.trim();
  return { body };
}

const textareaClass =
  "w-full rounded-lg border border-border-strong bg-bg px-3 py-2 font-mono text-[13px] outline-none focus:border-info focus:ring-2 focus:ring-info/20";

/** The Endpoint's fields; the caller holds `f` and wraps them in its form. `wide` lays pairs side by side. */
export function EndpointFields({ f, setF, isNew, wide = true }: { f: EndpointForm; setF: (u: (f: EndpointForm) => EndpointForm) => void; isNew: boolean; wide?: boolean }) {
  const set = (k: keyof EndpointForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const pair = wide ? "md:grid-cols-2" : "";
  return (
    <>
      <Field label="URL" hint="The Endpoint's URL including its version path; Iroha appends /chat/completions and the like.">
        {(p) => <Input {...p} mono autoFocus={isNew} spellCheck={false} placeholder="https://api.example.com/v1" value={f.url} onChange={set("url")} />}
      </Field>
      <div className={cn("grid gap-4", pair)}>
        <Field label="Name" hint={isNew ? "Optional; named from the host when empty." : undefined}>
          {(p) => <Input {...p} mono spellCheck={false} placeholder="intl" value={f.name} onChange={set("name")} />}
        </Field>
        <Field label="Shape">
          {() => <Select value={f.shape} onValueChange={(v) => set("shape")({ target: { value: v } })} items={SHAPES} />}
        </Field>
      </div>
      {/* No row gap: on phones the name's gap is inside its panel, so it opens and folds with it. */}
      <div className={cn("grid gap-x-4", pair)}>
        <Field label="Key sent as">
          {() => <Select value={f.auth_style} onValueChange={(v) => set("auth_style")({ target: { value: v } })} items={AUTH_STYLES} />}
        </Field>
        <Reveal open={f.auth_style === "header" || f.auth_style === "query"} label="Name of the key's header or parameter" className={ringRoom}>
          <div className={wide ? "pt-4 md:pt-0" : "pt-4"}>
            <Field label={f.auth_style === "header" ? "Header name" : "Parameter name"}>
              {(p) => <Input {...p} mono spellCheck={false} placeholder={f.auth_style === "header" ? "api-key" : "key"} value={f.auth_param} onChange={set("auth_param")} />}
            </Field>
          </div>
        </Reveal>
      </div>
      <Field label="Model list URL" hint={'Empty reads <URL>/models; "none" never asks.'}>
        {(p) => <Input {...p} mono spellCheck={false} value={f.discovery_url} onChange={set("discovery_url")} />}
      </Field>
      <Field label="Extra headers" hint="One per line, as Name: value. Sent on every Attempt.">
        {(p) => <textarea {...p} rows={2} spellCheck={false} value={f.headers} onChange={set("headers")} className={textareaClass} />}
      </Field>
      <Field label="Model renames" hint="One per line, as caller-model -> sent-model.">
        {(p) => <textarea {...p} rows={2} spellCheck={false} value={f.renames} onChange={set("renames")} className={textareaClass} />}
      </Field>
    </>
  );
}

/** Add endpoint. An existing Endpoint is edited in its sheet (UI ticket 27). */
function AddEndpointDialog({
  handle,
  existing,
  open,
  onOpenChange,
}: {
  handle: string;
  existing: Endpoint[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const refresh = useRefresh();
  const [f, setF] = useState(() => endpointFields());
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // Opening starts the form afresh in the same render, so the dialog's first
  // frame already shows its fields.
  const [startedFrom, setStartedFrom] = useState(false);
  if (startedFrom !== open) {
    setStartedFrom(open);
    if (open) {
      setError(undefined);
      setF(endpointFields());
    }
  }

  const submit = async () => {
    const checked = endpointBody(f, handle, existing);
    if ("error" in checked) return setError(checked.error);
    setPending(true);
    setError(undefined);
    try {
      const res = await calls.createEndpoint(handle, checked.body);
      refresh();
      const what = `Endpoint ${res.endpoint.name} added`;
      // Toast: the dialog closes on Save.
      notifyChange(res.keyless_key ? `${what}, with a keyless key` : what, res, { onUndone: refresh });
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add endpoint"
      width={560}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="endpoint-form" loading={pending}>
            Add endpoint
          </Button>
        </>
      }
    >
      <form
        id="endpoint-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <EndpointFields f={f} setF={setF} isNew />
        {error && <p className={cn("text-[13px] text-danger-text", appearClass)}>{error}</p>}
      </form>
    </Dialog>
  );
}

function EndpointMenu({ e, onEdit, onDelete }: { e: EndpointRow; onEdit: (e: Endpoint) => void; onDelete: (e: Endpoint) => void }) {
  // "Copy URL" closes the menu, so the trigger it closes back to shows the result.
  const copied = useCopy();
  return (
    <RowMenu name={e.name} copy={copied.state}>
      <MenuItem icon={Pencil} onSelect={() => onEdit(e)}>
        Edit…
      </MenuItem>
      <MenuItem icon={Plug} onSelect={() => void copied.copy(e.url, "URL")}>
        Copy URL
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Trash2} danger onSelect={() => onDelete(e)}>
        Delete…
      </MenuItem>
    </RowMenu>
  );
}
