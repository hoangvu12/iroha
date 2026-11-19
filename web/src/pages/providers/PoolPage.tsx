import { useEffect, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { MessageCircle, Plus } from "lucide-react";
import { useChatActions } from "@/app/chat-panel";
import { PageHeader } from "@/app/PageHeader";
import { seg } from "@/api/client";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton } from "@/ui/Button";
import { RouteTabs } from "@/ui/Tabs";
import { Skeleton } from "@/ui/Skeleton";
import { ErrorState } from "@/ui/States";
import { usePool } from "./api";
import { PoolTile } from "./controls";
import { AddMemberDialog, PoolMembersTab } from "./PoolMembers";
import { PoolRouteTab } from "./PoolRoute";
import { PoolSettingsTab } from "./PoolSettings";
import { SAMPLE_POOL } from "./samples";

const TABS = ["route", "members", "settings"] as const;

/** A Model Pool: Route (C19), Members (C06), Settings. */
export function PoolPage() {
  const { name = "", tab: raw } = useParams();
  const tab = TABS.find((t) => t === raw);
  const pool = usePool(name);
  const chat = useChatActions();
  const phone = useIsPhone();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);

  // /members?add=1 (from New Pool) opens Add member once.
  useEffect(() => {
    if (params.get("add") === "1") {
      setAdding(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  if (!tab) return <Navigate to={`/providers/pools/${seg(name)}/route`} replace />;
  const p = pool.data;
  const test = () => chat.open({ kind: "pool", pool: name });

  return (
    <>
      <PageHeader
        back={{ to: "/providers", label: "Providers" }}
        icon={<PoolTile name={name} version={p?.maker} size={phone ? 40 : 60} />}
        title={name}
        description="Model Pool"
        actions={
          <>
            {phone ? (
              <IconButton icon={MessageCircle} label={`Test ${name} in Chat`} bordered onClick={test} />
            ) : (
              <Button icon={MessageCircle} onClick={test}>
                Test
              </Button>
            )}
            {tab !== "settings" &&
              (phone ? (
                <IconButton icon={Plus} label="Add member" bordered onClick={() => setAdding(true)} />
              ) : (
                <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                  Add member
                </Button>
              ))}
          </>
        }
      />
      {pool.isError && !p ? (
        <ErrorState title={`Couldn't load ${name}`} error={pool.error} onRetry={() => void pool.refetch()} />
      ) : (
        <>
          <RouteTabs
            label={`${name} sections`}
            value={tab}
            panelClassName="pt-6"
            items={[
              { value: "route", to: `/providers/pools/${seg(name)}/route`, label: "Route" },
              {
                value: "members",
                to: `/providers/pools/${seg(name)}/members`,
                label: (
                  <>
                    Members
                    {p && <span className="ml-2 tabular text-fg-muted">{p.members.length}</span>}
                  </>
                ),
              },
              { value: "settings", to: `/providers/pools/${seg(name)}/settings`, label: "Settings" },
            ]}
          >
            {tab === "route" && <PoolRouteTab name={name} pool={p} onAdd={() => setAdding(true)} />}
            {tab === "members" && <PoolMembersTab name={name} pool={p} onAdd={() => setAdding(true)} />}
            {tab === "settings" && (
              <Skeleton data={p} sample={SAMPLE_POOL} id="pool-settings" label="Loading settings">
                {(p) => <PoolSettingsTab pool={p} />}
              </Skeleton>
            )}
          </RouteTabs>
          {p && <AddMemberDialog pool={p} open={adding} onOpenChange={setAdding} />}
        </>
      )}
    </>
  );
}
