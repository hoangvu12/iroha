import type { ReactNode } from "react";
import { useState } from "react";
import { Ellipsis, KeyRound, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { ApiError } from "@/api/client";
import { Button } from "@/ui/Button";
import { CopyButton } from "@/ui/CopyButton";
import { Input } from "@/ui/Input";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { Switch } from "@/ui/Switch";
import { ConfirmDialog, TypeToConfirmDialog } from "@/ui/Dialog";
import { LogoTile } from "@/ui/LogoTile";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuIconTrigger } from "@/ui/Menu";
import { Status } from "@/ui/bits";
import { EmptyState, ErrorState, NoResults } from "@/ui/States";
import { TBody, TD, TH, THead, TR, Table, TableSkeleton } from "@/ui/Table";
import { notify } from "@/ui/toast";

// /states: the shared components in every state (design C25), for anyone
// building a page to look at. Not linked from the navigation.

function Panel({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[15px] font-semibold">
        {title} <span className="ml-1.5 font-normal text-fg-muted">{note}</span>
      </h2>
      <div className="rounded-xl border border-border bg-bg p-5">{children}</div>
    </section>
  );
}

const timeout = new ApiError({
  status: 0,
  code: "timeout",
  message: "Iroha didn't answer within 10 s. It may be restarting.",
  method: "GET",
  path: "/api/requests",
});

export default function StatesPage() {
  const [del, setDel] = useState(false);
  const [rev, setRev] = useState(false);
  return (
    <>
      <PageHeader
        title="States"
        description="How a page looks while it loads, when it has nothing to show, when something fails, and when it asks before acting."
      />
      <div className="grid gap-8 lg:grid-cols-2">
        <Panel title="Loading" note="Rows hold their place. No spinners.">
          <TableSkeleton columns={["Name", "Key", "State", "Last used"]} rows={4} />
        </Panel>
        <Panel title="Empty" note="One sentence and the one action that fills it.">
          <EmptyState
            icon={KeyRound}
            title="No Upstream Keys yet"
            description="Paste keys from dashscope and Iroha starts routing to them."
            action={
              <Button variant="primary" icon={Plus}>
                Add keys
              </Button>
            }
          />
        </Panel>
        <Panel title="No results" note="Filters stay visible so they're easy to undo.">
          <NoResults
            title="No requests match these filters"
            description="Nothing from Test (as zeron-fleet) failed in the last 24 hours."
            filters={[
              { label: "Caller is Test (as zeron-fleet)", onRemove: () => {} },
              { label: "Status is 5xx", onRemove: () => {} },
            ]}
            onClear={() => {}}
          />
        </Panel>
        <Panel title="Error" note="Says what failed and keeps the page around it.">
          <ErrorState title="Couldn't load Requests" error={timeout} onRetry={() => {}} />
        </Panel>
        <Panel title="Confirm" note="Delete names what goes; revoke asks for the name. Red only on the button that does it.">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setDel(true)}>Delete 3 keys…</Button>
            <Button onClick={() => setRev(true)}>Revoke zeron-fleet…</Button>
          </div>
          <ConfirmDialog
            open={del}
            onOpenChange={setDel}
            title="Delete 3 Upstream Keys?"
            body="team-3, team-5 and team-10 will be removed from dashscope. Requests already logged keep the key's name."
            confirmLabel="Delete 3 keys"
            onConfirm={() => new Promise((r) => setTimeout(r, 400))}
          />
          <TypeToConfirmDialog
            open={rev}
            onOpenChange={setRev}
            title="Revoke zeron-fleet?"
            body="Callers using this key get 401 straight away. A revoked key can't be turned back on."
            name="zeron-fleet"
            confirmLabel="Revoke key"
            onConfirm={() => new Promise((r) => setTimeout(r, 400))}
          />
        </Panel>
        <Panel title="Results in place" note="Copy says Copied on the button; a setting shows Saving, then its result beside it, a failure under it.">
          <ResultsDemo />
        </Panel>
        <Panel title="Toasts" note="Only when the place that caused a result is gone. Bottom right for 6 s; a change that can be put back has Undo.">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => notify.success("3 keys disabled", { label: "Undo", onClick: () => notify.success("Change reverted") })}>
              Change with Undo
            </Button>
            <Button onClick={() => notify.error("Couldn't test team-5: 401 Invalid key", { label: "Open", onClick: () => {} })}>
              Failure
            </Button>

          </div>
        </Panel>
        <Panel title="Logo fallback" note="Round tiles for Providers, rounded squares for Pools.">
          <div className="flex flex-col gap-3">
            {[
              { name: "dashscope", shape: "round" as const, note: "No logo served yet, so the first letter" },
              { name: "my-vllm", shape: "round" as const, note: "No logo found, so the first letter" },
              { name: "house-mix", shape: "square" as const, note: "No maker matched, so the first letter" },
            ].map((l) => (
              <div key={l.name} className="flex items-center gap-3">
                <LogoTile name={l.name} shape={l.shape} size={32} />
                <span className="w-32 font-medium">{l.name}</span>
                <span className="text-fg-muted">{l.note}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Table, buttons, menu" note="One fact per cell; one primary button per page.">
          <div className="mb-4 flex flex-wrap gap-2">
            <Button variant="primary" icon={Plus}>
              Add Provider
            </Button>
            <Button>Test</Button>
            <Button variant="ghost">Clear selection</Button>
            <Button variant="danger">Delete</Button>
          </div>
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Key</TH>
                <TH>State</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {[
                ["team-1", "sk-…a91f", "green", "Active"],
                ["team-3", "sk-…0be4", "amber", "Cooling"],
                ["team-5", "sk-…c3a8", "red", "Invalid"],
                ["team-7", "sk-…f02b", "gray", "Disabled"],
              ].map(([n, k, tone, s], i) => (
                <TR key={n} selected={i === 1}>
                  <TD className="font-medium">{n}</TD>
                  <TD mono>{k}</TD>
                  <TD>
                    <Status tone={tone as "green"}>{s}</Status>
                  </TD>
                  <TD align="right">
                    <Menu>
                      <MenuIconTrigger icon={Ellipsis} label={`Actions for ${n}`} size="sm" />
                      <MenuContent>
                        <MenuItem>Test</MenuItem>
                        <MenuItem>Disable</MenuItem>
                        <MenuSeparator />
                        <MenuItem icon={Trash2} danger>
                          Delete
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Panel>
      </div>
    </>
  );
}

/** CopyButton and an inline save, with a fake call that fails when the name is "taken". */
function ResultsDemo() {
  const [name, setName] = useState("team-5");
  const [on, setOn] = useState(true);
  const naming = useSave();
  const switching = useSave();
  const wait = <T,>(v: T, fail?: string) => new Promise<T>((ok, no) => setTimeout(() => (fail ? no(new Error(fail)) : ok(v)), 600));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton value="http://localhost/v1" what="Base URL" />
        <CopyButton icon value="req_01HX" what="Request ID" bordered />
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void naming.run(() => wait({ audit_entry: undefined }, name === "taken" ? "taken is already used. Pick another name." : undefined), { message: `Renamed to ${name}` });
        }}
      >
        <Input aria-label="Demo name" className="w-48" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" loading={naming.pending}>
          Save
        </Button>
        <SaveStatus save={naming} />
        <SaveError save={naming} className="basis-full" />
      </form>
      <div className="flex items-center gap-3">
        <Switch label="Demo setting" checked={on} pending={switching.pending} onChange={(v) => void switching.run(() => wait(v).then(setOn), { message: v ? "Switched on" : "Switched off" })} />
        <SaveStatus save={switching} saving={false} />
      </div>
    </div>
  );
}
