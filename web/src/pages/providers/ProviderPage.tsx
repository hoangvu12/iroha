import { useState } from "react";
import { Navigate, useParams } from "react-router";
import { MessageCircle, Plus, RefreshCw } from "lucide-react";
import { useChatPanel } from "@/app/chat-panel";
import { PageHeader } from "@/app/PageHeader";
import { seg } from "@/api/client";
import { formatNumber } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton } from "@/ui/Button";
import { RouteTabs } from "@/ui/Tabs";
import { ErrorState } from "@/ui/States";
import { notify } from "@/ui/toast";
import { calls, useChange, useProvider } from "./api";
import { Pill, ProviderTile } from "./controls";
import { EndpointsTab } from "./Endpoints";
import { KeysTab } from "./Keys";
import { ModelsTab } from "./Models";
import { ProviderSettingsTab } from "./ProviderSettings";
import { RulesTab } from "./Rules";

const TABS = ["keys", "endpoints", "models", "rules", "settings"] as const;
type Tab = (typeof TABS)[number];

const primary: Partial<Record<Tab, string>> = {
  keys: "Add keys",
  endpoints: "Add endpoint",
  rules: "Add rule",
};

/** A Provider: header, underline tabs, one primary action per tab (C01, C07-C09, C14). */
export function ProviderPage() {
  const { handle = "", tab: raw } = useParams();
  const tab = TABS.find((t) => t === raw);
  const provider = useProvider(handle);
  const chat = useChatPanel();
  const phone = useIsPhone();
  const [adding, setAdding] = useState(false);
  const refreshList = useChange(() => calls.refreshModels(handle));

  if (!tab) return <Navigate to={`/providers/${seg(handle)}/keys`} replace />;
  const p = provider.data;

  const refresh = () =>
    refreshList.mutate(undefined, {
      onSuccess: (r) => (r.outcome === "failed" ? notify.error(r.summary) : notify.success(r.summary)),
      onError: (e) => notify.failure("Couldn't refresh the model list", e),
    });

  const label = primary[tab];
  const test = () => chat.open({ kind: "provider", provider: handle });
  const actions = (
    <>
      {phone ? (
        <IconButton icon={MessageCircle} label={`Test ${handle} in Chat`} bordered onClick={test} />
      ) : (
        <Button icon={MessageCircle} onClick={test}>
          Test
        </Button>
      )}
      {label &&
        (phone ? (
          <IconButton icon={Plus} label={label} bordered onClick={() => setAdding(true)} />
        ) : (
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            {label}
          </Button>
        ))}
      {tab === "models" &&
        (phone ? (
          <IconButton icon={RefreshCw} label="Refresh list" bordered onClick={refresh} disabled={refreshList.isPending} />
        ) : (
          <Button variant="primary" icon={RefreshCw} loading={refreshList.isPending} onClick={refresh}>
            Refresh list
          </Button>
        ))}
    </>
  );

  return (
    <>
      <PageHeader
        back={{ to: "/providers", label: "Providers" }}
        icon={<ProviderTile handle={handle} version={p?.logo_domain} size={phone ? 40 : 60} />}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">{handle}</span>
            {p?.archived ? <Pill>Archived</Pill> : p && !p.enabled ? <Pill>Off</Pill> : null}
          </span>
        }
        description={p ? `${formatNumber(p.upstream_key_count)} Upstream Key${p.upstream_key_count === 1 ? "" : "s"}` : " "}
        actions={actions}
      />
      {provider.isError && !p ? (
        <ErrorState title={`Couldn't load ${handle}`} error={provider.error} onRetry={() => void provider.refetch()} />
      ) : (
        <RouteTabs
          label={`${handle} sections`}
          value={tab}
          items={TABS.map((t) => ({ value: t, to: `/providers/${seg(handle)}/${t}`, label: t[0].toUpperCase() + t.slice(1) }))}
          panelClassName="pt-6"
        >
          {tab === "keys" && <KeysTab handle={handle} provider={p} adding={adding} setAdding={setAdding} />}
          {tab === "endpoints" && <EndpointsTab handle={handle} provider={p} adding={adding} setAdding={setAdding} />}
          {tab === "models" && <ModelsTab handle={handle} />}
          {tab === "rules" && <RulesTab handle={handle} adding={adding} setAdding={setAdding} />}
          {tab === "settings" && p && <ProviderSettingsTab provider={p} />}
        </RouteTabs>
      )}
    </>
  );
}
