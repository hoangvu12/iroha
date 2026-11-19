import { useEffect, useMemo, useState } from "react";
import { Pencil, Plug, Trash2 } from "lucide-react";
import { Button } from "@/ui/Button";
import { useConfirm } from "@/ui/Confirm";
import { useCopy } from "@/ui/CopyButton";
import { DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { Dialog } from "@/ui/Dialog";
import { Field, Input } from "@/ui/Input";
import { MenuItem, MenuSeparator } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { notifyChange } from "@/ui/toast";
import type { AuthStyle, Endpoint, Provider, Shape, UpstreamKey } from "./api";
import { calls, errorText, natural, shapeLabel, SHAPES, useKeys, useRefresh } from "./api";
import { Select } from "./controls";
import { SAMPLE_ENDPOINTS } from "./samples";

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
  const [editing, setEditing] = useState<Endpoint>();
  const eps = provider?.endpoints ?? [];

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
        rowActions={(e) => <EndpointMenu e={e} onEdit={setEditing} onDelete={askDelete} />}
        onRowClick={setEditing}
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
      <EndpointDialog handle={handle} existing={eps} open={adding} onOpenChange={setAdding} />
      <EndpointDialog handle={handle} existing={eps} endpoint={editing} open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} />
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

const AUTH: { value: AuthStyle; label: string }[] = [
  { value: "bearer", label: "Authorization: Bearer <key>" },
  { value: "x-api-key", label: "x-api-key: <key>" },
  { value: "header", label: "A header you name" },
  { value: "query", label: "A query parameter you name" },
  { value: "none", label: "Not sent (no key needed)" },
];

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

function EndpointDialog({
  handle,
  endpoint,
  existing,
  open,
  onOpenChange,
}: {
  handle: string;
  endpoint?: Endpoint;
  existing: Endpoint[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const refresh = useRefresh();
  const [f, setF] = useState({ name: "", url: "", shape: "openai-chat" as Shape, auth_style: "bearer" as AuthStyle, auth_param: "", discovery_url: "", headers: "", renames: "" });
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setF({
      name: endpoint?.name ?? "",
      url: endpoint?.url ?? "",
      shape: endpoint?.shape ?? "openai-chat",
      auth_style: endpoint?.auth_style ?? "bearer",
      auth_param: endpoint?.auth_param ?? "",
      discovery_url: endpoint?.discovery_url ?? "",
      headers: Object.entries(endpoint?.static_headers ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
      renames: Object.entries(endpoint?.renames ?? {})
        .map(([k, v]) => `${k} -> ${v}`)
        .join("\n"),
    });
  }, [open, endpoint]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async () => {
    if (!f.url.trim()) return setError("The URL is required: the Endpoint's URL with its version path.");
    // Creating with a taken name would update that Endpoint instead.
    const clash = existing.find((e) => e.name === f.name.trim() && e.id !== endpoint?.id);
    if (f.name.trim() && clash) return setError(`${handle} already has an Endpoint named ${clash.name}. Pick another name${endpoint ? "" : ", or edit that one"}.`);
    setPending(true);
    setError(undefined);
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
    try {
      const res = endpoint ? await calls.updateEndpoint(handle, endpoint.name, body) : await calls.createEndpoint(handle, body);
      refresh();
      const what = endpoint ? `Endpoint ${res.endpoint.name} saved` : `Endpoint ${res.endpoint.name} added`;
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
      title={endpoint ? `Edit ${endpoint.name}` : "Add endpoint"}
      width={560}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="endpoint-form" loading={pending}>
            {endpoint ? "Save" : "Add endpoint"}
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
        <Field label="URL" hint="The Endpoint's URL including its version path; Iroha appends /chat/completions and the like.">
          {(p) => <Input {...p} mono autoFocus={!endpoint} spellCheck={false} placeholder="https://api.example.com/v1" value={f.url} onChange={set("url")} />}
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" hint={endpoint ? undefined : "Optional; named from the host when empty."}>
            {(p) => <Input {...p} mono spellCheck={false} placeholder="intl" value={f.name} onChange={set("name")} />}
          </Field>
          <Field label="Shape">
            {() => <Select value={f.shape} onValueChange={(v) => set("shape")({ target: { value: v } })} items={SHAPES} />}
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Key sent as">
            {() => <Select value={f.auth_style} onValueChange={(v) => set("auth_style")({ target: { value: v } })} items={AUTH} />}
          </Field>
          {(f.auth_style === "header" || f.auth_style === "query") && (
            <Field label={f.auth_style === "header" ? "Header name" : "Parameter name"}>
              {(p) => <Input {...p} mono spellCheck={false} placeholder={f.auth_style === "header" ? "api-key" : "key"} value={f.auth_param} onChange={set("auth_param")} />}
            </Field>
          )}
        </div>
        <Field label="Model list URL" hint={'Empty reads <URL>/models; "none" never asks.'}>
          {(p) => <Input {...p} mono spellCheck={false} value={f.discovery_url} onChange={set("discovery_url")} />}
        </Field>
        <Field label="Extra headers" hint="One per line, as Name: value. Sent on every Attempt.">
          {(p) => (
            <textarea
              {...p}
              rows={2}
              spellCheck={false}
              value={f.headers}
              onChange={set("headers")}
              className="w-full rounded-lg border border-border-strong bg-bg px-3 py-2 font-mono text-[13px] outline-none focus:border-info focus:ring-2 focus:ring-info/20"
            />
          )}
        </Field>
        <Field label="Model renames" hint="One per line, as caller-model -> sent-model.">
          {(p) => (
            <textarea
              {...p}
              rows={2}
              spellCheck={false}
              value={f.renames}
              onChange={set("renames")}
              className="w-full rounded-lg border border-border-strong bg-bg px-3 py-2 font-mono text-[13px] outline-none focus:border-info focus:ring-2 focus:ring-info/20"
            />
          )}
        </Field>
        {error && <p className="text-[13px] text-danger-text">{error}</p>}
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
