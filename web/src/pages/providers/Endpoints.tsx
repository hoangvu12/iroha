import { useEffect, useState } from "react";
import { MoreHorizontal, Pencil, Plug, Trash2 } from "lucide-react";
import { useIsPhone } from "@/lib/media";
import { copyText } from "@/pages/settings/format";
import { Button } from "@/ui/Button";
import { ConfirmDialog, Dialog } from "@/ui/Dialog";
import { Field, Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuIconTrigger } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { Skeleton } from "@/ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/ui/Table";
import { notifyChange } from "@/ui/toast";
import type { AuthStyle, Endpoint, Provider, Shape, UpstreamKey } from "./api";
import { calls, errorText, shapeLabel, SHAPES, useKeys, useRefresh } from "./api";
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
  const phone = useIsPhone();
  const [editing, setEditing] = useState<Endpoint>();
  const [deleting, setDeleting] = useState<Endpoint>();
  const eps = provider?.endpoints ?? [];

  const keysFor = (e: Endpoint) => {
    const all = keys.data ?? [];
    const n = all.filter((k: UpstreamKey) => k.endpoints.length === 0 || k.endpoints.includes(e.name)).length;
    if (!keys.data) return "–";
    if (n === all.length) return all.length ? "All keys" : "No keys";
    return `${n} key${n === 1 ? "" : "s"}`;
  };

  const menu = (e: Endpoint) => (
    <Menu>
      <MenuIconTrigger icon={MoreHorizontal} label={`More for ${e.name}`} size="sm" />
      <MenuContent>
        <MenuItem icon={Pencil} onSelect={() => setEditing(e)}>
          Edit…
        </MenuItem>
        <MenuItem icon={Plug} onSelect={() => void copyText(e.url, "URL")}>
          Copy URL
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={() => setDeleting(e)}>
          Delete…
        </MenuItem>
      </MenuContent>
    </Menu>
  );

  return (
    <section aria-label="Endpoints">
      {/* Waits for the keys too, so the Keys column arrives filled in. */}
      <Skeleton
        data={provider && !keys.isPending ? eps : undefined}
        sample={SAMPLE_ENDPOINTS}
        id={phone ? "provider-endpoints:phone" : "provider-endpoints"}
        label="Loading Endpoints"
      >
      {(eps) => eps.length === 0 ? (
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
      ) : phone ? (
        <ul className="divide-y divide-border border-y border-border">
          {eps.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(e)}>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-[16px] font-medium">{e.name}</span>
                  <span className="shrink-0 text-[14px] text-fg-muted">{shapeLabel(e.shape)}</span>
                </span>
                <span className="block truncate font-mono text-[13px] text-fg-muted">{e.url}</span>
              </button>
              {menu(e)}
            </li>
          ))}
        </ul>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH className="w-[16%]">Name</TH>
              <TH>URL</TH>
              <TH className="w-[18%]">Shape</TH>
              <TH className="w-[12%]">Keys</TH>
              <TH className="w-10">
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {eps.map((e) => (
              <TR key={e.id} interactive onClick={() => setEditing(e)}>
                <TD className="text-[15px] font-medium">{e.name}</TD>
                <TD mono className="max-w-0 truncate" title={e.url}>
                  {e.url}
                </TD>
                <TD>{shapeLabel(e.shape)}</TD>
                <TD>{keysFor(e)}</TD>
                <TD align="right" onClick={(ev) => ev.stopPropagation()}>
                  {menu(e)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      </Skeleton>

      <EndpointDialog handle={handle} existing={eps} open={adding} onOpenChange={setAdding} />
      <EndpointDialog handle={handle} existing={eps} endpoint={editing} open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`Delete ${deleting?.name}?`}
        body={`Iroha stops sending Requests to ${deleting?.url}. Keys limited to it alone stop being used. Undo brings it back.`}
        confirmLabel="Delete endpoint"
        onConfirm={async () => {
          if (!deleting) return;
          const res = await calls.deleteEndpoint(handle, deleting.name);
          refresh();
          notifyChange(`Endpoint ${deleting.name} deleted`, res, { onUndone: refresh });
        }}
      />
    </section>
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
