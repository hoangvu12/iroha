import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, ListPlus, ListX, MessageCircle, SlidersHorizontal } from "lucide-react";
import { api, isApiError, seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { timeAgo } from "@/lib/format";
import { calls, errorText, type Model, natural, usePools } from "@/pages/providers/api";
import { useSheetRefresh } from "./refresh";
import { factSource, ModelFields, modelForm, modelMetadata, tokens } from "@/pages/providers/Models";
import { Status } from "@/ui/bits";
import { Button, TextButton } from "@/ui/Button";
import { useConfirm } from "@/ui/Confirm";
import { ProviderTile } from "@/ui/LogoTile";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import { DialogTitle } from "@ui-sdk/react/dialog";
import { rec, RecordLink } from "../RecordLink";
import { recordKey, writeStack } from "../records";
import { Fact, Facts, LinkList, LinkListLoading, LinkRow, none, SheetActions, SheetBar, SheetBody, SheetLoading, SheetProblem, SheetSection, SheetTitle } from "../Sheet";
import type { SheetBodyProps } from "../SheetStack";
import { useSheets } from "../stack";
import { useEditing } from "./editing";

const modelQuery = (provider: string, model: string) => ["providers", provider, "models", "one", model];
const SHOWN_GAPS = 8;

/**
 * A model of a Provider's list (UI ticket 33: it was the Models tab's
 * details dialog): where each fact comes from, the keys refused it, the
 * Pools that use it, and the Owner's choices (hide, pin, details) in place.
 */
export default function ModelSheet({ record }: SheetBodyProps<"model">) {
  const { provider, model } = record;
  const q = useQuery({
    queryKey: modelQuery(provider, model),
    queryFn: ({ signal }) => api.get<Model>(`/api/providers/${seg(provider)}/models/${seg(model)}`, { signal }),
    retry: (n, e) => !(isApiError(e) && e.status === 404) && n < 2,
  });
  const page = `/providers/${seg(provider)}/models${writeStack("", [rec.model(provider, model)])}`;

  if (!q.data)
    return (
      <>
        <SheetBar kind="Model" page={page} />
        {isApiError(q.error) && q.error.status === 404 ? (
          <NotListed provider={provider} model={model} refetch={() => q.refetch()} />
        ) : q.isError ? (
          <SheetProblem kind="Model" name={model} error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <SheetLoading name={`Model ${model}`} />
        )}
      </>
    );

  return (
    <>
      <SheetBar kind="Model" page={page} />
      {/* Keyed by the entry's id: another model swapped into this sheet starts afresh. */}
      <ModelDetails key={q.data.id} m={q.data} provider={provider} refetch={() => q.refetch()} />
    </>
  );
}

/** A model named somewhere (a Request, a Pool member, a Gateway Key's scope) that the Provider's list doesn't hold. */
function NotListed({ provider, model, refetch }: { provider: string; model: string; refetch: () => Promise<unknown> }) {
  const { refresh } = useSheetRefresh(refetch);
  const saving = useSave({ refresh, describe: errorText });
  return (
    <div className="p-6">
      <DialogTitle className="mb-2 break-words text-[17px] font-semibold">
        No model {model} on {provider}
      </DialogTitle>
      <p className="text-[14.5px] text-fg-muted">
        {provider}'s model list doesn't name it. Callers can still ask for it unless {provider} refuses unlisted models; add it so Callers see it in the list.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button icon={ListPlus} loading={saving.pending} onClick={() => void saving.run(() => calls.saveModel(provider, { model, added: true }), { message: `${model} added` })}>
          Add {model} to {provider}'s list
        </Button>
        <SaveStatus save={saving} saving={false} />
      </div>
      <SaveError save={saving} className="mt-2" />
    </div>
  );
}

function ModelDetails({ m, provider, refetch }: { m: Model; provider: string; refetch: () => Promise<unknown> }) {
  const sheets = useSheets();
  const chat = useChatActions();
  const confirm = useConfirm();
  const pools = usePools();
  const { refresh, refreshAll } = useSheetRefresh(refetch);
  const actionSave = useSave({ refresh, describe: errorText });
  const detailsSave = useSave({ refresh, describe: errorText });
  const [editing, setEditing] = useEditing(rec.model(provider, m.model));
  const [f, setF] = useState(() => modelForm(m));
  const [error, setError] = useState<string>();

  const edit = () => {
    setF(modelForm(m));
    setError(undefined);
    setEditing(true);
  };
  const save = () => {
    const checked = modelMetadata(m, f);
    if ("error" in checked) return setError(checked.error);
    setError(undefined);
    void detailsSave
      .run(() => calls.saveModel(provider, { model: m.model, metadata: checked.metadata }), { message: `${m.model} details saved` })
      .then((ok) => ok && setEditing(false));
  };

  const change = (body: { hidden?: boolean; added?: boolean }, message: string) => void actionSave.run(() => calls.saveModel(provider, { model: m.model, ...body }), { message });
  const clearGaps = () =>
    void actionSave.run(() => calls.bulkKeys(provider, "clear-model-gaps", m.model_gaps, m.model), {
      message: (r) => `Model Gaps of ${m.model} cleared on ${r.succeeded} key${r.succeeded === 1 ? "" : "s"}`,
    });

  // Asks first; a model only the Owner added leaves the list, so its sheet closes and the result (with Undo) toasts.
  const askRemove = () =>
    confirm.ask({
      title: `Remove ${m.model} from ${provider}?`,
      body: `Callers stop seeing ${m.model} in ${provider}'s model list. Undo brings it back.`,
      confirmLabel: "Remove model",
      onConfirm: async () => {
        const res = await calls.saveModel(provider, { model: m.model, added: false });
        void refreshAll();
        // Toast: the model's sheet closes as it leaves the list.
        notifyChange(`${m.model} removed`, res, { onUndone: refreshAll });
        const at = sheets.stack.findIndex((s) => recordKey(s.record) === recordKey(rec.model(provider, m.model)));
        if (at >= 0) sheets.close(at);
      },
    });

  const usedBy = (pools.data ?? [])
    .flatMap((p) => p.members.filter((x) => x.provider === provider && x.model === m.model).map((x) => ({ pool: p.name, position: x.position, enabled: x.enabled })))
    .sort((a, b) => natural(a.pool, b.pool));
  const from = (k: Parameters<typeof factSource>[2]) => {
    const s = factSource(m, provider, k);
    return s ? <span className="text-fg-muted"> · from {s}</span> : null;
  };
  const yesNo = (b?: boolean) => (b === undefined ? none : b ? "Yes" : "No");

  return (
    <SheetBody>
      <SheetTitle
        kind="Model"
        logo={<ProviderTile handle={provider} size={44} />}
        title={m.model}
        mono
        subtitle={
          <>
            Model of <RecordLink record={rec.provider(provider)}>{provider}</RecordLink>
          </>
        }
        state={m.visible ? <Status tone="green">Listed</Status> : m.hidden ? <Status tone="gray">Hidden</Status> : <Status tone="gray">Not listed</Status>}
      />
      <SheetActions>
        <Button variant="primary" icon={MessageCircle} onClick={() => chat.open({ kind: "model", provider, model: m.model })}>
          Test {m.model} in Chat
        </Button>
        {m.hidden ? (
          <Button icon={Eye} onClick={() => change({ hidden: false }, `${m.model} shown to Callers`)}>
            Show {m.model}
          </Button>
        ) : (
          <Button icon={EyeOff} onClick={() => change({ hidden: true }, `${m.model} hidden`)}>
            Hide {m.model}
          </Button>
        )}
        {m.added && m.discovered ? (
          <Button icon={ListX} onClick={() => change({ added: false }, `${m.model} no longer pinned`)}>
            Unpin {m.model}
          </Button>
        ) : m.added ? (
          <Button variant="ghost" danger icon={ListX} onClick={askRemove}>
            Remove {m.model} from the list…
          </Button>
        ) : (
          <Button icon={ListPlus} onClick={() => change({ added: true }, `${m.model} pinned to the list`)}>
            Pin {m.model} to the list
          </Button>
        )}
        <SaveStatus save={actionSave} saving={false} />
      </SheetActions>
      <SaveError save={actionSave} className="-mt-3 mb-4" />

      {editing ? (
        <SheetSection title="Details">
          <form
            className="flex flex-col gap-4"
            onSubmit={(ev) => {
              ev.preventDefault();
              save();
            }}
          >
            <p className="text-[14px] text-fg-muted">What Callers' model lists say of it. Empty fields use {provider}'s own list, then models.dev. They never change routing.</p>
            <ModelFields m={m} handle={provider} f={f} setF={setF} />
            <SaveError save={detailsSave} error={error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={detailsSave.pending}>
                Save details
              </Button>
            </div>
          </form>
        </SheetSection>
      ) : (
        <SheetSection
          title="Details"
          action={
            <span className="flex items-center gap-2">
              <SaveStatus save={detailsSave} saving={false} />
              <Button size="sm" icon={SlidersHorizontal} onClick={edit}>
                Edit details
              </Button>
            </span>
          }
        >
          <Facts>
            <Fact label="Context window">
              {tokens(m.metadata.context_length)}
              {m.metadata.context_length !== undefined && from("context_length")}
            </Fact>
            <Fact label="Max output">
              {tokens(m.metadata.max_output_tokens)}
              {m.metadata.max_output_tokens !== undefined && from("max_output_tokens")}
            </Fact>
            <Fact label="Reasons before answering">
              {yesNo(m.metadata.reasoning)}
              {m.metadata.reasoning !== undefined && from("reasoning")}
            </Fact>
            <Fact label="Chat">{m.metadata.chat === "unsupported" ? "Doesn't chat" : "Chats"}</Fact>
            <Fact label="Named by" wide>
              {/* Neither: an entry kept only for the Owner's details (a POST with metadata alone). */}
              {m.discovered ? (m.endpoints.length ? m.endpoints.join(", ") : "discovery") : m.added ? "you (added by hand)" : "Nobody: only your details for it are kept"}
              {m.added && m.discovered && <span className="text-fg-muted"> · pinned by you</span>}
            </Fact>
            {m.upstream_keys.length > 0 && (
              <Fact label="Keys whose own list names it" wide>
                {m.upstream_keys.join(", ")}
              </Fact>
            )}
            <Fact label="Last discovered">{m.discovered_at ? timeAgo(m.discovered_at) : none}</Fact>
          </Facts>
        </SheetSection>
      )}

      <SheetSection
        title="Model Gaps"
        action={
          m.model_gaps.length > 0 && (
            <TextButton className="text-[14px]" aria-label={`Clear the Model Gaps of ${m.model}`} onClick={clearGaps}>
              Clear all
            </TextButton>
          )
        }
      >
        {m.model_gaps.length === 0 ? (
          <p className="text-[14.5px] text-fg-muted">No key has been refused {m.model}.</p>
        ) : (
          <>
            <p className="mb-3 text-[14px] text-fg-muted">These keys aren't tried for {m.model} until the gap ends or is cleared.</p>
            <LinkList>
              {[...m.model_gaps]
                .sort(natural)
                .slice(0, SHOWN_GAPS)
                .map((k) => (
                  <LinkRow key={k} aside="Model Gap">
                    <RecordLink record={rec.key(provider, k)} className="font-mono text-[14px]">
                      {k}
                    </RecordLink>
                  </LinkRow>
                ))}
            </LinkList>
            {m.model_gaps.length > SHOWN_GAPS && <p className="mt-2 text-[14px] text-fg-muted">{m.model_gaps.length - SHOWN_GAPS} more on the Keys tab.</p>}
          </>
        )}
      </SheetSection>

      <SheetSection title="Model Pools using it">
        {pools.isPending ? (
          <LinkListLoading label="Loading Model Pools" />
        ) : usedBy.length === 0 ? (
          <p className="text-[14.5px] text-fg-muted">No Model Pool uses {m.model} on {provider}.</p>
        ) : (
          <LinkList>
            {usedBy.map((u) => (
              <LinkRow key={u.pool} aside={u.enabled ? `Member ${u.position}` : `Member ${u.position}, off`}>
                <RecordLink record={rec.pool(u.pool)}>{u.pool}</RecordLink>
              </LinkRow>
            ))}
          </LinkList>
        )}
      </SheetSection>
      {confirm.dialog}
    </SheetBody>
  );
}
