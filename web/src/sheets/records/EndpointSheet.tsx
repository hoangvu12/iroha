import { useQuery } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { api, seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { formatDate } from "@/lib/format";
import { authStyleLabel, type Endpoint, natural, shapeLabel, useKeys } from "@/pages/providers/api";
import { KeyStateLabel } from "@/pages/providers/controls";
import { Button } from "@/ui/Button";
import { ProviderTile } from "@/ui/LogoTile";
import { rec, RecordLink } from "../RecordLink";
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

const SHOWN_KEYS = 8;

export default function EndpointSheet({ record }: SheetBodyProps<"endpoint">) {
  const { provider, endpoint } = record;
  const q = useQuery({
    queryKey: ["providers", provider, "endpoints", endpoint],
    queryFn: ({ signal }) => api.get<Endpoint>(`/api/providers/${seg(provider)}/endpoints/${seg(endpoint)}`, { signal }),
  });
  const keys = useKeys(provider);
  const chat = useChatActions();
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

  const e = q.data;
  const using = [...(keys.data ?? [])].filter((k) => k.endpoints.length === 0 || k.endpoints.includes(e.name)).sort((a, b) => natural(a.name, b.name));
  const gapped = (keys.data ?? []).filter((k) => k.endpoint_gaps.some((g) => g.endpoint === e.name));

  return (
    <>
      <SheetBar kind="Endpoint" page={page} />
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
        </SheetActions>
        <SheetSection title="Facts">
          <Facts>
            <Fact label="URL" mono wide>
              <span className="inline-flex max-w-full items-center gap-1">
                <span className="min-w-0 break-all">{e.url}</span>
                <CopyIconButton text={e.url} what="Endpoint URL" />
              </span>
            </Fact>
            <Fact label="Shape">{shapeLabel(e.shape)}</Fact>
            <Fact label="Key sent as">
              {authStyleLabel(e.auth_style, e.auth_param)}
            </Fact>
            <Fact label="Model list" mono wide>
              {e.discovery_url || none}
            </Fact>
            <Fact label="Static headers">{Object.keys(e.static_headers ?? {}).length || none}</Fact>
            <Fact label="Added">{formatDate(e.created_at)}</Fact>
          </Facts>
        </SheetSection>
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
      </SheetBody>
    </>
  );
}
