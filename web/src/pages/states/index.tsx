import type { ReactNode } from "react";
import { useState } from "react";
import { KeyRound, Plus, Trash2, X } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { ApiError } from "@/api/client";
import { Button, IconButton } from "@/ui/Button";
import { ConfirmAction, useConfirm } from "@/ui/Confirm";
import { CopyButton } from "@/ui/CopyButton";
import { type DataTableProps, type SortingState, DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { Input } from "@/ui/Input";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { Switch } from "@/ui/Switch";
import { ConfirmDialog, TypeToConfirmDialog } from "@/ui/Dialog";
import { LogoTile } from "@/ui/LogoTile";
import { MenuItem, MenuSeparator } from "@/ui/Menu";
import { Mono, Status } from "@/ui/bits";
import { EmptyState } from "@/ui/States";
import { notify } from "@/ui/toast";

// /states: the shared components in every state (design C25), for anyone
// building a page to look at. Not linked from the navigation.

function Panel({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
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
        <Panel title="Loading" note="The table's skeleton, measured from its sample rows, so nothing moves when they land. No spinners.">
          {/* Never loads. */}
          <DemoTable id="states-loading" data={undefined} />
        </Panel>
        <Panel title="Empty" note="One sentence and the one action that fills it; the toolbar hides.">
          <DemoTable
            id="states-empty"
            data={[]}
            empty={
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
            }
          />
        </Panel>
        <Panel title="No results" note="Filters stay visible as chips, so they're easy to undo.">
          <NoResultsDemo />
        </Panel>
        <Panel title="Error" note="Says what failed and keeps the page around it.">
          <DemoTable id="states-error" data={undefined} error={timeout} errorTitle="Couldn't load Requests" onRetry={() => {}} />
        </Panel>
        <Panel title="Confirm" note="Destructive triggers are red and ask, naming what goes; revoke asks for the name. Solid red only on the button that does it.">
          <div className="flex flex-wrap items-center gap-2">
            <Button danger onClick={() => setDel(true)}>
              Delete 3 keys…
            </Button>
            <Button danger onClick={() => setRev(true)}>
              Revoke zeron-fleet…
            </Button>
            <ConfirmAction
              title="Remove gpt-4o from fast?"
              body="Requests for fast stop going to gpt-4o. Undo puts it back in its place."
              confirmLabel="Remove model"
              onConfirm={() => new Promise((r) => setTimeout(r, 400))}
            >
              <IconButton icon={Trash2} label="Remove gpt-4o" danger />
            </ConfirmAction>
            <span className="inline-flex h-7 items-center gap-1 rounded-md bg-muted pl-2 pr-1 font-mono text-[12.5px]">
              qwen3-max
              <IconButton icon={X} size="xs" danger label="Remove qwen3-max (draft, doesn't ask)" />
            </span>
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
            {/* Toast: these buttons only show each kind of toast on the States page. */}
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
        <Panel title="Buttons" note="One primary button per page.">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={Plus}>
              Add Provider
            </Button>
            <Button>Test</Button>
            <Button variant="ghost">Clear selection</Button>
            <Button danger>Delete…</Button>
          </div>
        </Panel>
        <Panel title="Table" note="One fact per cell. Sort, select for the bulk bar, a row menu, details under a row, pages.">
          <TableDemo />
        </Panel>
      </div>
    </>
  );
}

type DemoKey = { id: string; name: string; secret: string; tone: "green" | "amber" | "red" | "gray"; state: string };

const STATES: Pick<DemoKey, "tone" | "state">[] = [
  { tone: "green", state: "Active" },
  { tone: "amber", state: "Cooling" },
  { tone: "red", state: "Invalid" },
  { tone: "gray", state: "Disabled" },
];
const DEMO_KEYS: DemoKey[] = Array.from({ length: 12 }, (_, i) => ({
  id: `k${i + 1}`,
  name: `team-${i + 1}`,
  secret: `sk-…${(0xa91f + i * 2741).toString(16).slice(-4)}`,
  ...STATES[i % 4],
}));

const col = columnsFor<DemoKey>();
const demoColumns = col.columns([
  col.accessor("name", { header: "Name", sortFn: "alphanumeric", meta: { className: "font-medium" } }),
  col.display({ id: "key", header: "Key", cell: ({ row }) => <Mono className="text-fg-muted">{row.original.secret}</Mono> }),
  col.accessor("state", { header: "State", cell: ({ row }) => <Status tone={row.original.tone}>{row.original.state}</Status> }),
]);
const BY_NAME: SortingState = [{ id: "name", desc: false }];

/** The demo table in one state: `data` undefined loads, `[]` is empty, `error` failed. */
function DemoTable(p: Partial<DataTableProps<DemoKey>> & { id: string }) {
  return (
    <DataTable<DemoKey>
      label="Upstream Keys"
      columns={demoColumns}
      data={DEMO_KEYS}
      sample={DEMO_KEYS.slice(0, 4)}
      getRowId={(k) => k.id}
      rowName={(k) => k.name}
      defaultSorting={BY_NAME}
      paging={{ mode: "none" }}
      {...p}
    />
  );
}

function NoResultsDemo() {
  const [q, setQ] = useState("qwen");
  const [cooling, setCooling] = useState(true);
  const chips = [
    ...(q ? [{ label: `Search: ${q}`, onRemove: () => setQ("") }] : []),
    ...(cooling ? [{ label: "Cooling", onRemove: () => setCooling(false) }] : []),
  ];
  return (
    <DemoTable
      id="states-no-results"
      data={DEMO_KEYS.slice(0, 4)}
      search={q}
      columnFilters={cooling ? [{ id: "state", value: "Cooling" }] : []}
      filterChips={chips}
      noResultsTitle="No keys match"
      onClearFilters={() => {
        setQ("");
        setCooling(false);
      }}
    />
  );
}

function TableDemo() {
  const confirm = useConfirm();
  const askDelete = (names: string[]) =>
    confirm.ask({
      title: names.length === 1 ? `Delete ${names[0]}?` : `Delete ${names.length} keys?`,
      body: `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""} will be removed. Undo brings ${names.length === 1 ? "it" : "them"} back.`,
      confirmLabel: names.length === 1 ? "Delete key" : `Delete ${names.length} keys`,
      onConfirm: () => new Promise((r) => setTimeout(r, 400)),
    });
  return (
    <>
      <DemoTable
        id="states-table"
        label="Demo keys"
        paging={{ mode: "pages", sizes: [5, 10] }}
        bulk={({ rows }) => (
          <>
            <Button size="sm">Test</Button>
            <Button size="sm" danger onClick={() => askDelete(rows.map((k) => k.name))}>
              Delete…
            </Button>
          </>
        )}
        rowActions={(k) => (
          <RowMenu name={k.name}>
            <MenuItem>Test</MenuItem>
            <MenuItem>Disable</MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onSelect={() => askDelete([k.name])}>
              Delete…
            </MenuItem>
          </RowMenu>
        )}
        rowTone={(k) => (k.state === "Invalid" ? "danger" : undefined)}
        renderExpanded={(k) => (
          <p className="text-sm text-fg-muted">
            {k.name} was added on Nov 3 and is {k.state.toLowerCase()}.
          </p>
        )}
        footer={({ shown }) => `${shown} keys. Shift-click to select a range.`}
      />
      {confirm.dialog}
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
