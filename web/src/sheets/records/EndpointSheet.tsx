import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Pencil, Trash2 } from "lucide-react";
import { api, seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { formatDate } from "@/lib/format";
import { authStyleLabel, calls, type Endpoint, errorText, natural, shapeLabel, useKeys, useProvider } from "@/pages/providers/api";
import { useSheetRefresh } from "./refresh";
import { KeyStateLabel } from "@/pages/providers/controls";
import { endpointBody, EndpointFields, endpointFields } from "@/pages/providers/Endpoints";
import { Button } from "@/ui/Button";
import { useConfirm } from "@/ui/Confirm";
import { ProviderTile } from "@/ui/LogoTile";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import { rec, RecordLink } from "../RecordLink";
import { recordKey } from "../records";
import {
  CopyIconButton,
  Fact,
  Facts,
  LinkList,
  LinkListLoading,
  LinkRow,
  none,
  SheetActions,
  SheetBar,
  SheetBody,
  SheetLoading,
  SheetProblem,
  SheetSection,
  SheetTitle,
} from "../Sheet";
import type { SheetBodyProps } from "../SheetStack";
import { useSheets } from "../stack";
import { useEditing } from "./editing";

const SHOWN_KEYS = 8;
const endpointQuery = (provider: string, endpoint: string) => ["providers", provider, "endpoints", endpoint];

export default function EndpointSheet({ record, index }: SheetBodyProps<"endpoint">) {
  const { provider, endpoint } = record;
  const q = useQuery({
    queryKey: endpointQuery(provider, endpoint),
    queryFn: ({ signal }) => api.get<Endpoint>(`/api/providers/${seg(provider)}/endpoints/${seg(endpoint)}`, { signal }),
  });
  const page = `/providers/${seg(provider)}/endpoints`;

  if (!q.data)
    return (
      <>
        <SheetBar kind="Endpoint" page={page} />
        {q.isError ? (
          <SheetProblem kind="Endpoint" name={endpoint} error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <SheetLoading name={`Endpoint ${endpoint}`} />
        )}
      </>
    );

  return (
    <>
      <SheetBar kind="Endpoint" page={page} />
      {/* Keyed by the Endpoint's id: a rename keeps the sheet's state, another Endpoint starts afresh. */}
      <EndpointDetails key={q.data.id} e={q.data} provider={provider} index={index} refetch={() => q.refetch()} />
    </>
  );
}

/**
 * An Endpoint's facts, and its fields in their place while it is edited (UI
 * ticket 27: it was a dialog). Save keeps the sheet open, so the result shows
 * in it, with Undo; a rename moves the sheet to the new name.
 */
function EndpointDetails({ e, provider, index, refetch }: { e: Endpoint; provider: string; index: number; refetch: () => Promise<unknown> }) {
  const sheets = useSheets();
  const qc = useQueryClient();
  const keys = useKeys(provider);
  const providerQ = useProvider(provider);
  const chat = useChatActions();
  const confirm = useConfirm();
  const { refresh, refreshAll } = useSheetRefresh(refetch);
  const saving = useSave({ refresh, describe: errorText });
  const [editing, setEditing] = useEditing(rec.endpoint(provider, e.name));
  const [f, setF] = useState(() => endpointFields(e));
  const [error, setError] = useState<string>();

  const edit = () => {
    setF(endpointFields(e));
    setError(undefined);
    setEditing(true);
  };

  const save = () => {
    const checked = endpointBody(f, provider, providerQ.data?.endpoints ?? [], e);
    if ("error" in checked) return setError(checked.error);
    setError(undefined);
    void saving
      .run(
        async () => {
          const res = await calls.updateEndpoint(provider, e.name, checked.body);
          if (res.endpoint.name !== e.name) {
            // The sheet follows the Endpoint to its new name, with no reload of what it shows.
            qc.setQueryData(endpointQuery(provider, res.endpoint.name), res.endpoint);
            sheets.replace(index, rec.endpoint(provider, res.endpoint.name));
          }
          return res;
        },
        { message: (res) => (res.keyless_key ? `Endpoint ${res.endpoint.name} saved, with a keyless key` : `Endpoint ${res.endpoint.name} saved`) },
      )
      .then((ok) => ok && setEditing(false));
  };

  // Asks first; the Endpoint is gone afterwards, so its sheet closes and the result (with Undo) toasts.
  const askDelete = () =>
    confirm.ask({
      title: `Delete ${e.name}?`,
      body: `Iroha stops sending Requests to ${e.url}. Keys limited to it alone stop being used. Undo brings it back.`,
      confirmLabel: "Delete endpoint",
      onConfirm: async () => {
        const res = await calls.deleteEndpoint(provider, e.name);
        void refreshAll();
        // Toast: the Endpoint's sheet closes with it.
        notifyChange(`Endpoint ${e.name} deleted`, res, { onUndone: refreshAll });
        const at = sheets.stack.findIndex((s) => recordKey(s.record) === recordKey(rec.endpoint(provider, e.name)));
        if (at >= 0) sheets.close(at);
      },
    });

  const using = [...(keys.data ?? [])].filter((k) => k.endpoints.length === 0 || k.endpoints.includes(e.name)).sort((a, b) => natural(a.name, b.name));
  const gapped = (keys.data ?? []).filter((k) => k.endpoint_gaps.some((g) => g.endpoint === e.name));

  return (
    <SheetBody>
      <SheetTitle
        kind="Endpoint"
        logo={<ProviderTile handle={provider} size={44} />}
        title={e.name}
        subtitle={
          <>
            Endpoint of <RecordLink record={rec.provider(provider)}>{provider}</RecordLink>
          </>
        }
        state={<span className="text-fg-muted">{shapeLabel(e.shape)}</span>}
      />
      <SheetActions>
        <Button icon={MessageCircle} onClick={() => chat.open({ kind: "provider", provider })}>
          Test {provider} in Chat
        </Button>
        {!editing && (
          <Button icon={Pencil} onClick={edit}>
            Edit {e.name}
          </Button>
        )}
        <Button variant="ghost" danger icon={Trash2} onClick={askDelete}>
          Delete {e.name}…
        </Button>
        {!editing && <SaveStatus save={saving} saving={false} />}
      </SheetActions>

      {editing ? (
        <SheetSection title="Edit">
          <form
            className="flex flex-col gap-4"
            onSubmit={(ev) => {
              ev.preventDefault();
              save();
            }}
          >
            {/* One column: a sheet is narrower than the dialog was. */}
            <EndpointFields f={f} setF={setF} isNew={false} wide={false} />
            <SaveError save={saving} error={error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={saving.pending}>
                Save
              </Button>
            </div>
          </form>
        </SheetSection>
      ) : (
        <SheetSection title="Facts">
          <Facts>
            <Fact label="URL" mono wide>
              <span className="inline-flex max-w-full items-center gap-1">
                <span className="min-w-0 break-all">{e.url}</span>
                <CopyIconButton text={e.url} what="Endpoint URL" />
              </span>
            </Fact>
            <Fact label="Shape">{shapeLabel(e.shape)}</Fact>
            <Fact label="Key sent as">{authStyleLabel(e.auth_style, e.auth_param)}</Fact>
            <Fact label="Model list" mono wide>
              {e.discovery_url || none}
            </Fact>
            <Fact label="Static headers">{Object.keys(e.static_headers ?? {}).length || none}</Fact>
            <Fact label="Model renames">{Object.keys(e.renames ?? {}).length || none}</Fact>
            <Fact label="Added">{formatDate(e.created_at)}</Fact>
          </Facts>
          <SaveError save={saving} className="mt-3" />
        </SheetSection>
      )}

      <SheetSection title="Upstream Keys sent here">
        {keys.isPending ? (
          <LinkListLoading label="Loading Upstream Keys" />
        ) : using.length === 0 ? (
          <p className="text-[14.5px] text-fg-muted">No key is sent to this Endpoint.</p>
        ) : (
          <>
            <LinkList>
              {using.slice(0, SHOWN_KEYS).map((k) => (
                <LinkRow key={k.id} aside={<KeyStateLabel state={k.state} />}>
                  <RecordLink record={rec.key(provider, k.name)} className="font-mono text-[14px]">
                    {k.name}
                  </RecordLink>
                </LinkRow>
              ))}
            </LinkList>
            {using.length > SHOWN_KEYS && <p className="mt-2 text-[14px] text-fg-muted">{using.length - SHOWN_KEYS} more on the Provider's page.</p>}
          </>
        )}
        {gapped.length > 0 && (
          <p className="mt-3 text-[14px] text-fg-muted">
            Endpoint Gap here:{" "}
            {gapped.map((k, i) => (
              <span key={k.id}>
                {i > 0 && ", "}
                <RecordLink record={rec.key(provider, k.name)} className="font-mono">
                  {k.name}
                </RecordLink>
              </span>
            ))}
          </p>
        )}
      </SheetSection>
      {confirm.dialog}
    </SheetBody>
  );
}
