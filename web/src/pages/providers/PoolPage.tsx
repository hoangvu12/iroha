import { useEffect, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { MessageCircle, Plus } from "lucide-react";
import { useChatPanel } from "@/app/chat-panel";
import { PageHeader } from "@/app/PageHeader";
import { seg } from "@/api/client";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton } from "@/ui/Button";
import { Tabs } from "@/ui/bits";
import { ErrorState } from "@/ui/States";
import { usePool } from "./api";
import { PoolTile } from "./controls";
import { AddMemberDialog, PoolMembersTab } from "./PoolMembers";
import { PoolRouteTab } from "./PoolRoute";
import { PoolSettingsTab } from "./PoolSettings";

const TABS = ["route", "members", "settings"] as const;

/** A Model Pool: Route (C19), Members (C06), Settings. */
export function PoolPage() {
  const { name = "", tab: raw } = useParams();
  const tab = TABS.find((t) => t === raw);
  const pool = usePool(name);
  const chat = useChatPanel();
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
        icon={<PoolTile name={name} version={p?.maker} size={phone ? 48 : 60} />}
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
          <Tabs
            items={[
              { to: `/providers/pools/${seg(name)}/route`, label: "Route" },
              {
                to: `/providers/pools/${seg(name)}/members`,
                label: (
                  <>
                    Members
                    {p && <span className="ml-2 tabular text-fg-muted">{p.members.length}</span>}
                  </>
                ),
              },
              { to: `/providers/pools/${seg(name)}/settings`, label: "Settings" },
            ]}
          />
          <div className="pt-6">
            {tab === "route" && <PoolRouteTab name={name} pool={p} onAdd={() => setAdding(true)} />}
            {tab === "members" && <PoolMembersTab name={name} pool={p} onAdd={() => setAdding(true)} />}
            {tab === "settings" && p && <PoolSettingsTab pool={p} />}
          </div>
          {p && <AddMemberDialog pool={p} open={adding} onOpenChange={setAdding} />}
        </>
      )}
    </>
  );
}
