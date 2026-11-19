import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  CircleSlash,
  Copy,
  Eraser,
  Eye,
  EyeOff,
  KeyRound,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plug,
  Trash2,
  Waypoints,
} from "lucide-react";
import { useChatActions } from "@/app/chat-panel";
import { rec, RecordLink } from "@/sheets/RecordLink";
import type { BulkResult } from "@/api/types";
import { formatDate, formatDuration, timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { useUrlParams } from "@/lib/url-state";
import { Button, IconButton, TextButton } from "@/ui/Button";
import { Mono, StatusDot } from "@/ui/bits";
import { cn } from "@/ui/cn";
import { useConfirm } from "@/ui/Confirm";
import { CopyButton, useCopy } from "@/ui/CopyButton";
import { type ColumnFiltersState, type SortingState, DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { type Done, type Save, SaveError, SaveStatus, toastDone, useSave } from "@/ui/SaveStatus";
import { ScrollArea } from "@/ui/ScrollArea";
import { Dialog } from "@/ui/Dialog";
import { Field, Input, ToolbarSearch } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuIconTrigger } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { notify, notifyChange } from "@/ui/toast";
import type { KeyTestBulk, KeyTestResult, Provider, UpstreamKey } from "./api";
import { calls, errorText, maskSecret, natural, useKeys, useRefresh } from "./api";
import { Reveal } from "@/ui/Reveal";
import { appearClass, Checkbox, KeyStateLabel, Pill, ringRoom, Segmented, Select, shortWait, stateTone, Switch } from "./controls";
import { SAMPLE_KEYS } from "./samples";

// The Keys tab (C01, C11, C20; phones C31): one line per Upstream Key in the
// shared DataTable, sorted, filtered, searched and paged; selecting keys turns
// the toolbar into "N selected" with Test, Disable and a ⋯ menu. Every bulk
// action calls the bulk API and shows per-key results when any key failed. Its
// result (with Undo, an Audit revert) shows where it was asked for: in the
// selection bar, or in the key's dialog; from a row's menu, which has closed, it
// toasts. Deletes ask first (UI ticket 21).
// ?q= searches, ?state= filters, ?sort=&dir= sorts; ?key=<name> opens a key.

type StateFilter = "all" | "active" | "cooling" | "invalid" | "disabled" | "gaps";
type Sort = "name" | "state" | "used";

const stateOrder = { invalid: 0, cooling: 1, disabled: 2, active: 3 };

const col = columnsFor<UpstreamKey>();
const columns = col.columns([
  col.accessor("name", {
    header: "Name",
    sortFn: (a, b) => natural(a.original.name, b.original.name),
    meta: { width: "w-[24%]", className: "text-[15px] font-medium", opens: true },
    cell: ({ row }) => <span className="truncate">{row.original.name}</span>,
  }),
  col.display({
    id: "key",
    header: "Key",
    meta: { width: "w-[20%]" },
    cell: ({ row }) => <SecretCell k={row.original} />,
  }),
  col.accessor((k) => k.state.state, {
    id: "state",
    header: "State",
    sortFn: (a, b) => stateOrder[a.original.state.state] - stateOrder[b.original.state.state] || natural(a.original.name, b.original.name),
    filterFn: (row, _id, value) => (value === "gaps" ? hasGaps(row.original) : row.original.state.state === value),
    meta: { width: "w-[24%]" },
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <KeyStateLabel state={row.original.state} plain={row.original.state.state !== "cooling"} />
        <GapsPill k={row.original} />
      </span>
    ),
  }),
  col.accessor((k) => k.last_used_at ?? "", {
    id: "used",
    header: "Last used",
    // Most recent first, then by name.
    sortFn: (a, b) => (b.original.last_used_at ?? "").localeCompare(a.original.last_used_at ?? "") || natural(a.original.name, b.original.name),
    meta: { className: "whitespace-nowrap tabular" },
    cell: ({ row }) => (row.original.last_used_at ? timeAgo(row.original.last_used_at) : <span className="text-fg-muted">Never</span>),
  }),
]);

const searchKeys = (k: UpstreamKey, needle: string) => !needle || k.name.toLowerCase().includes(needle) || k.secret.toLowerCase().includes(needle);

export function KeysTab({
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
  const chat = useChatActions();
  const confirm = useConfirm();
  const { params, setParam, setParams, setSort } = useUrlParams();
  const q = params.get("q") ?? "";
  const filter = (params.get("state") as StateFilter) || "all";
  const sort = (params.get("sort") as Sort) || "name";
  const desc = params.get("dir") === "desc";
  const openKey = params.get("key");

  const [results, setResults] = useState<Results>();
  const [restricting, setRestricting] = useState<string[]>();
  const [busy, setBusy] = useState<string>();
  // Results of what the selection bar did show in the bar.
  const barSave = useSave({ describe: errorText });
  const emptySave = useSave({ describe: errorText });
  const copied = useCopy();

  const all = useMemo(() => keys.data ?? [], [keys.data]);
  const byName = useMemo(() => new Map(all.map((k) => [k.name, k])), [all]);

  const sorting = useMemo<SortingState>(() => [{ id: sort, desc }], [sort, desc]);
  const columnFilters = useMemo<ColumnFiltersState>(() => (filter === "all" ? [] : [{ id: "state", value: filter }]), [filter]);

  // Runs a change and shows its result at `at` (the bar, the key's dialog);
  // without one it came from a row's menu, which has closed, so it toasts.
  const perform = async (failure: string, fn: () => Promise<Done | undefined>, busyWith: string, at?: Save) => {
    setBusy(busyWith);
    try {
      if (at) await at.run(fn, { message: (d) => d ?? { message: "Nothing changed" } });
      else {
        try {
          const d = await fn();
          // Toast: the row's menu has closed.
          if (d) toastDone(d, refresh);
        } catch (e) {
          // Toast: an error with nowhere else to go (the row's menu has closed).
          notify.failure(failure, e);
        }
      }
    } finally {
      setBusy(undefined);
    }
  };

  const bulk = (
    action: "enable" | "disable" | "clear-model-gaps" | "clear-endpoint-gaps" | "restrict-to-working-endpoints",
    items: string[],
    past: string,
    at?: Save,
  ) =>
    perform(
      `Couldn't ${action.replace(/-/g, " ")} the keys`,
      async () => {
        const res = await calls.bulkKeys(handle, action, items);
        await refresh();
        return bulkDone(res, items, past, setResults);
      },
      action,
      at,
    );

  const test = (items: string[], at?: Save) =>
    perform(
      "Couldn't test the keys",
      async (): Promise<Done> => {
        const res = await calls.testKeys(handle, items);
        await refresh();
        if (items.length === 1 && res.items[0]?.result) {
          const r = res.items[0].result;
          if (r.passed) return { message: `${items[0]} passed: ${r.status} in ${formatDuration(r.duration_ms)}` };
          return { message: `${items[0]} failed: ${testFailure(r)}`, tone: "bad", action: { label: "Details", onClick: () => setResults(testResults(res, items)) } };
        }
        setResults(testResults(res, items));
        return { message: `${res.passed} passed, ${res.failed} failed`, tone: res.failed ? "bad" : "ok" };
      },
      "test",
      at,
    );

  // Asks first, naming the keys; the rows are gone afterwards, so the result (with Undo) toasts.
  const askDelete = (names: string[]) => {
    const one = names.length === 1;
    confirm.ask({
      title: one ? `Delete ${names[0]}?` : `Delete ${names.length} keys?`,
      body: one
        ? `Iroha stops using ${names[0]} and forgets its secret. Undo brings it back.`
        : `Iroha stops using ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""} and forgets their secrets. Undo brings them back.`,
      confirmLabel: one ? "Delete key" : `Delete ${names.length} keys`,
      onConfirm: async () => {
        const res = await calls.bulkKeys(handle, "delete", names);
        refresh();
        // Toast: the confirm dialog has closed and the rows are gone; Undo after a delete.
        reportBulk(res, names, "deleted", setResults, refresh);
        if (names.includes(openKey ?? "")) setParam("key");
      },
    });
  };

  // A keyless key: no secret, so Iroha sends no key with it. A failure
  // shows at `at` (the empty state or the Add keys dialog), which stays.
  const addKeyless = (at: Save) => {
    setBusy("keyless");
    void at
      .run(
        async () => {
          const res = await calls.addKeylessKey(handle, keylessName(all));
          refresh();
          setAdding(false);
          // Toast: the empty state (or the Add keys dialog) it came from is gone now.
          notifyChange(res.upstream_key.name === "keyless" ? "Keyless key added" : `Keyless key ${res.upstream_key.name} added`, res, { onUndone: refresh });
        },
        { quiet: true },
      )
      .finally(() => setBusy(undefined));
  };

  const keyActions: KeyActions = {
    open: (k) => setParam("key", k.name),
    test: (k, at) => void test([k.name], at),
    chat: (k) => chat.open({ kind: "upstream_key", provider: handle, key: k.name }),
    toggle: (k, at) => void bulk(k.enabled ? "disable" : "enable", [k.name], k.enabled ? "disabled" : "enabled", at),
    clearGaps: (k, at) => void bulk("clear-model-gaps", [k.name], "cleared of Model Gaps", at),
    clearEndpointGaps: (k, at) => void bulk("clear-endpoint-gaps", [k.name], "cleared of Endpoint Gaps", at),
    restrictToWorking: (k, at) => void bulk("restrict-to-working-endpoints", [k.name], "restricted to the Endpoints it works on", at),
    endpoints: (k) => setRestricting([k.name]),
    remove: (k) => askDelete([k.name]),
  };

  const filters = [
    ...(q ? [{ label: `Search: ${q}`, onRemove: () => setParam("q") }] : []),
    ...(filter !== "all" ? [{ label: filterLabel[filter], onRemove: () => setParam("state") }] : []),
  ];
  const detail = openKey ? byName.get(openKey) : undefined;
  const multipleEndpoints = (provider?.endpoints.length ?? 0) > 1;

  const bulkBar = (rows: UpstreamKey[]) => {
    const names = rows.map((k) => k.name).sort(natural);
    const withEndpointGaps = rows.filter((k) => k.endpoint_gaps.length > 0).map((k) => k.name);
    return (
      <>
        <Button icon={Play} onClick={() => void test(names, barSave)} loading={busy === "test"} size={phone ? "sm" : "md"}>
          Test
        </Button>
        <Button icon={Pause} onClick={() => void bulk("disable", names, "disabled", barSave)} loading={busy === "disable"} size={phone ? "sm" : "md"}>
          Disable
        </Button>
        <Menu>
          <MenuIconTrigger icon={MoreHorizontal} label="More actions for the selected keys" bordered copy={copied.state} />
          <MenuContent align="start">
            <MenuItem icon={CircleCheck} onSelect={() => void bulk("enable", names, "enabled", barSave)}>
              Enable
            </MenuItem>
            {multipleEndpoints && (
              <MenuItem icon={Plug} onSelect={() => setRestricting(names)}>
                Endpoints…
              </MenuItem>
            )}
            <MenuItem icon={Eraser} onSelect={() => void bulk("clear-model-gaps", names, "cleared of Model Gaps", barSave)}>
              Clear Model Gaps
            </MenuItem>
            {withEndpointGaps.length > 0 && (
              <>
                <MenuItem icon={Waypoints} onSelect={() => void bulk("restrict-to-working-endpoints", withEndpointGaps, "restricted to the Endpoints they work on", barSave)}>
                  Restrict to working Endpoints
                </MenuItem>
                <MenuItem icon={Eraser} onSelect={() => void bulk("clear-endpoint-gaps", names, "cleared of Endpoint Gaps", barSave)}>
                  Clear Endpoint Gaps
                </MenuItem>
              </>
            )}
            <MenuItem
              icon={Copy}
              onSelect={() => void copied.copy(rows.map((k) => k.secret).filter(Boolean).join("\n"), `${names.length} key${names.length === 1 ? "" : "s"}`)}
            >
              Copy keys
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onSelect={() => askDelete(names)}>
              Delete…
            </MenuItem>
          </MenuContent>
        </Menu>
        <SaveStatus save={barSave} saving={false} className="ml-1" />
        <SaveError save={barSave} />
      </>
    );
  };

  const toolbar = (
    <>
      <ToolbarSearch
        placeholder="Search keys"
        aria-label="Search keys by name or secret"
        value={q}
        onChange={(e) => setParam("q", e.target.value)}
      />
      {phone ? (
        // The Select is w-full: its box sets the width, so search and filter share a line (C31).
        <div className="w-28 shrink-0">
          <Select<StateFilter>
            aria-label="Show keys"
            value={filter}
            onValueChange={(v) => setParam("state", v === "all" ? undefined : v)}
            items={(Object.keys(filterLabel) as StateFilter[]).map((f) => ({ value: f, label: f === "all" ? "All" : filterLabel[f] }))}
          />
        </div>
      ) : (
        <Segmented<StateFilter>
          label="Show keys"
          value={filter}
          onChange={(v) => setParam("state", v === "all" ? undefined : v)}
          items={(["all", "active", "cooling", "invalid", "disabled", "gaps"] as StateFilter[]).map((f) => ({
            value: f,
            label: (
              <>
                {f === "all" ? "All" : filterLabel[f]}
                {f !== "all" && counts[f](all) > 0 && <span className="ml-1.5 text-fg-muted tabular">{counts[f](all)}</span>}
              </>
            ),
          }))}
        />
      )}
    </>
  );

  return (
    <section aria-label="Upstream Keys">
      <DataTable<UpstreamKey>
        id="provider-keys"
        label="Upstream Keys"
        columns={columns}
        data={keys.data}
        sample={SAMPLE_KEYS}
        getRowId={(k) => k.id}
        rowName={(k) => k.name}
        error={keys.isError ? keys.error : undefined}
        onRetry={() => void keys.refetch()}
        toolbar={toolbar}
        search={q}
        searchFn={searchKeys}
        columnFilters={columnFilters}
        filterChips={filters}
        noResultsTitle="No keys match"
        onClearFilters={() => setParams({ q: undefined, state: undefined })}
        sorting={sorting}
        onSortingChange={(s) => setSort(s[0]?.id ?? "name", s[0]?.desc ?? false, "name")}
        bulk={({ rows }) => bulkBar(rows)}
        rowActions={(k) => <KeyMenu k={k} actions={keyActions} multipleEndpoints={multipleEndpoints} />}
        onRowClick={keyActions.open}
        phoneRow={(k) => <KeyLine k={k} />}
        empty={
          <EmptyState
            icon={KeyRound}
            title="No Upstream Keys yet"
            description={`Paste the keys ${handle} issued you, one per line. If its Endpoints need no key, add one keyless key instead.`}
            action={
              <span className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Add keys
                </Button>
                <Button onClick={() => addKeyless(emptySave)} loading={busy === "keyless"}>
                  Add keyless key
                </Button>
                <SaveError save={emptySave} className="basis-full text-center" />
              </span>
            }
          />
        }
        footer={({ shown, total }) => (
          <>
            {shown === total ? `${total} key${total === 1 ? "" : "s"}` : `${shown} of ${total} keys`}. Hover a state for its reason; shift-click to select a range.
          </>
        )}
      />

      {confirm.dialog}
      <AddKeysDialog
        handle={handle}
        open={adding}
        onOpenChange={setAdding}
        onResults={setResults}
        onKeyless={addKeyless}
        keylessPending={busy === "keyless"}
      />
      <KeyDialog
        handle={handle}
        k={detail}
        missing={!!openKey && !keys.isPending && !detail ? openKey : undefined}
        provider={provider}
        onClose={() => setParam("key")}
        onRenamed={(n) => setParam("key", n)}
        actions={keyActions}
        testing={busy === "test"}
      />
      <EndpointsDialog
        handle={handle}
        provider={provider}
        names={restricting}
        keys={byName}
        onClose={() => setRestricting(undefined)}
        onResults={setResults}
      />
      <ResultsDialog results={results} onClose={() => setResults(undefined)} />
    </section>
  );
}

const filterLabel: Record<StateFilter, string> = {
  all: "All keys",
  active: "Active",
  cooling: "Cooling",
  invalid: "Invalid",
  disabled: "Disabled",
  gaps: "Gaps",
};

/** A Model Gap or an Endpoint Gap: the key serves, but not everything. */
const hasGaps = (k: UpstreamKey) => k.model_gaps.length > 0 || k.endpoint_gaps.length > 0;

const counts: Record<Exclude<StateFilter, "all">, (k: UpstreamKey[]) => number> = {
  active: (k) => k.filter((x) => x.state.state === "active").length,
  cooling: (k) => k.filter((x) => x.state.state === "cooling").length,
  invalid: (k) => k.filter((x) => x.state.state === "invalid").length,
  disabled: (k) => k.filter((x) => x.state.state === "disabled").length,
  gaps: (k) => k.filter(hasGaps).length,
};

function SecretCell({ k }: { k: UpstreamKey }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Mono className="text-fg-muted">{maskSecret(k.secret)}</Mono>
      {k.secret && <CopyButton icon value={k.secret} what="Key" label={`Copy ${k.name}`} className="row-reveal" />}
    </span>
  );
}

function GapsPill({ k }: { k: UpstreamKey }) {
  if (!k.model_gaps.length && !k.cooling_models.length && !k.endpoint_gaps.length) return null;
  const title = [
    ...k.endpoint_gaps.map((g) => `Endpoint Gap: not sent to ${g.endpoint} (${g.reason})`),
    ...k.model_gaps.map((g) => `Model Gap: ${g.model} (${g.reason})`),
    ...k.cooling_models.map((c) => `Cooling for ${c.model} until ${new Date(c.until).toLocaleTimeString()}`),
  ].join("\n");
  return (
    <span title={title} className="inline-flex gap-1">
      {k.endpoint_gaps.length > 0 && (
        <Pill tone="blue">{k.endpoint_gaps.length === 1 ? `Endpoint Gap: ${k.endpoint_gaps[0].endpoint}` : `${k.endpoint_gaps.length} Endpoint Gaps`}</Pill>
      )}
      {k.model_gaps.length > 0 && <Pill tone="blue">{k.model_gaps.length === 1 ? "1 Model Gap" : `${k.model_gaps.length} Model Gaps`}</Pill>}
      {k.cooling_models.length > 0 && <Pill tone="amber">{k.cooling_models.length} cooling</Pill>}
    </span>
  );
}

/** What a key's row menu and dialog can do; `at` is where the result shows (none: a toast, from a closed menu). */
type KeyActions = {
  open: (k: UpstreamKey) => void;
  test: (k: UpstreamKey, at?: Save) => void;
  chat: (k: UpstreamKey) => void;
  toggle: (k: UpstreamKey, at?: Save) => void;
  clearGaps: (k: UpstreamKey, at?: Save) => void;
  clearEndpointGaps: (k: UpstreamKey, at?: Save) => void;
  restrictToWorking: (k: UpstreamKey, at?: Save) => void;
  endpoints: (k: UpstreamKey) => void;
  remove: (k: UpstreamKey) => void;
};

function KeyMenu({ k, actions, multipleEndpoints }: { k: UpstreamKey; actions: KeyActions; multipleEndpoints: boolean }) {
  // "Copy key" closes the menu, so the trigger it closes back to shows the result.
  const copied = useCopy();
  return (
    <RowMenu name={k.name} copy={copied.state}>
      <MenuItem icon={Play} onSelect={() => actions.test(k)}>
        Test
      </MenuItem>
      <MenuItem icon={MessageCircle} onSelect={() => actions.chat(k)}>
        Test in Chat
      </MenuItem>
      {k.secret && (
        <MenuItem icon={Copy} onSelect={() => void copied.copy(k.secret, "Key")}>
          Copy key
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon={k.enabled ? Pause : CircleCheck} onSelect={() => actions.toggle(k)}>
        {k.enabled ? "Disable" : "Enable"}
      </MenuItem>
      {k.model_gaps.length > 0 && (
        <MenuItem icon={Eraser} onSelect={() => actions.clearGaps(k)}>
          Clear Model Gaps
        </MenuItem>
      )}
      {k.endpoint_gaps.length > 0 && (
        <>
          <MenuItem icon={Waypoints} onSelect={() => actions.restrictToWorking(k)}>
            Restrict to working Endpoints
          </MenuItem>
          <MenuItem icon={Eraser} onSelect={() => actions.clearEndpointGaps(k)}>
            Clear Endpoint Gaps
          </MenuItem>
        </>
      )}
      {multipleEndpoints && (
        <MenuItem icon={Plug} onSelect={() => actions.endpoints(k)}>
          Endpoints…
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon={Trash2} danger onSelect={() => actions.remove(k)}>
        Delete…
      </MenuItem>
    </RowMenu>
  );
}

/** Phones (C31): a key in two lines. */
function KeyLine({ k }: { k: UpstreamKey }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[16px]">{k.name}</span>
        <span className="block truncate font-mono text-[14px] text-fg-muted">{maskSecret(k.secret)}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end text-[14px]">
        <KeyStateLabel state={k.state} plain={k.state.state === "active" || k.state.state === "disabled"} />
        <span className="text-fg-muted">{k.last_used_at ? timeAgo(k.last_used_at) : "Never used"}</span>
      </span>
    </>
  );
}

// ---- Results of bulk actions ----

type ResultRow = { name: string; ok: boolean; text: ReactNode; tone?: "green" | "red" | "gray" };
type Results = { title: string; summary: string; rows: ResultRow[] };

/** A bulk change's result (with its Audit Entry for Undo); shows per-key results when any key failed. */
function bulkDone(res: BulkResult<UpstreamKey>, items: string[], past: string, show: (r: Results) => void): Done | undefined {
  const n = res.succeeded;
  const what = `${n} key${n === 1 ? "" : "s"}`;
  if (res.failed > 0)
    show({
      title: `${res.failed} of ${items.length} key${items.length === 1 ? "" : "s"} not ${past}`,
      summary: n > 0 ? `${what} ${past}. Undo puts them back.` : "Nothing changed.",
      rows: res.items.map((it) => ({
        name: items[it.index] ?? `#${it.index + 1}`,
        ok: it.ok,
        text: it.ok ? (it.outcome === "unchanged" ? "Already so" : "Done") : (it.error?.message ?? "Failed"),
        tone: it.ok ? "green" : "red",
      })),
    });
  if (n === 0) return undefined;
  return { message: items.length === 1 && res.failed === 0 ? `${items[0]} ${past}` : `${what} ${past}`, entry: res.audit_entry };
}

/** A bulk change whose place is gone (a dialog that closed): its toast. */
function reportBulk(res: BulkResult<UpstreamKey>, items: string[], past: string, show: (r: Results) => void, refresh: () => void) {
  const d = bulkDone(res, items, past, show);
  // Toast: the dialog it came from (a confirm, the Endpoints dialog) has closed, so the result has no place left.
  if (d) toastDone(d, refresh);
}

function testFailure(r: KeyTestResult): string {
  return [r.status ? String(r.status) : "No answer", r.reason].filter(Boolean).join(" ");
}

function testResults(res: KeyTestBulk, items: string[]): Results {
  return {
    title: `Tested ${items.length} key${items.length === 1 ? "" : "s"}`,
    summary: `${res.passed} passed, ${res.failed} failed.`,
    rows: res.items.map((it) => {
      const r = it.result;
      const name = items[it.index] ?? `#${it.index + 1}`;
      if (!it.ok || !r) return { name, ok: false, text: it.error?.message ?? "Couldn't test", tone: "red" };
      if (r.passed)
        return { name, ok: true, text: `Passed: ${r.status} in ${formatDuration(r.duration_ms)} (${r.model} on ${r.endpoint})`, tone: "green" };
      return {
        name,
        ok: false,
        text: (
          <>
            {testFailure(r)}
            <span className="block text-fg-muted">
              {r.action}
              {r.rule && ` (rule ${r.rule})`}
            </span>
          </>
        ),
        tone: "red",
      };
    }),
  };
}

function ResultsDialog({ results, onClose }: { results?: Results; onClose: () => void }) {
  return (
    <Dialog
      open={!!results}
      onOpenChange={(o) => !o && onClose()}
      title={results?.title}
      description={results?.summary}
      width={560}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <ScrollArea className="rounded-lg border border-border" viewportClassName="max-h-[50vh]">
        <ul className="divide-y divide-border">
          {results?.rows.map((r) => (
            <li key={r.name} className="flex items-start gap-3 px-4 py-2.5 text-[14px]">
              <StatusDot tone={r.tone ?? (r.ok ? "green" : "red")} className="mt-1.5" />
              <span className="w-28 shrink-0 truncate font-mono">{r.name}</span>
              <span className={cn("min-w-0 flex-1", !r.ok && "text-danger-text")}>{r.text}</span>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </Dialog>
  );
}

// ---- Add keys (C11) ----

/** The first free name for a keyless key: keyless, keyless-2, ... */
function keylessName(keys: UpstreamKey[]): string {
  const taken = new Set(keys.map((k) => k.name));
  if (!taken.has("keyless")) return "keyless";
  let n = 2;
  while (taken.has(`keyless-${n}`)) n++;
  return `keyless-${n}`;
}

/** Keys pasted one per line (or separated by spaces or commas), deduplicated. */
function parseKeys(text: string): string[] {
  const seen = new Set<string>();
  for (const t of text.split(/[\s,;]+/)) {
    const s = t.trim().replace(/^["']|["']$/g, "");
    if (s) seen.add(s);
  }
  return [...seen];
}

function AddKeysDialog({
  handle,
  open,
  onOpenChange,
  onResults,
  onKeyless,
  keylessPending,
}: {
  handle: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onResults: (r: Results) => void;
  onKeyless: (at: Save) => void;
  keylessPending: boolean;
}) {
  const refresh = useRefresh();
  const keylessSave = useSave({ describe: errorText });
  const [text, setText] = useState("");
  const [testAfter, setTestAfter] = useState(true);
  const [preview, setPreview] = useState<{ secrets: string[]; res?: BulkResult<UpstreamKey>; error?: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const secrets = useMemo(() => parseKeys(text), [text]);

  // Dry run: which keys are new, which the Provider already holds, which are refused.
  useEffect(() => {
    if (!open || secrets.length === 0) return setPreview(undefined);
    let live = true;
    const t = setTimeout(() => {
      calls
        .addKeys(
          handle,
          secrets.map((secret) => ({ secret })),
          true,
        )
        .then((res) => live && setPreview({ secrets, res }))
        .catch((e) => live && setPreview({ secrets, error: errorText(e) }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [handle, open, secrets]);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setText("");
      setPreview(undefined);
      setError(undefined);
      keylessSave.clear();
    }
  };

  const current = preview && preview.secrets === secrets ? preview : undefined;
  const rows = current?.res?.items.map((it) => ({
    secret: secrets[it.index],
    name: it.result?.name,
    kind: !it.ok ? "error" : it.outcome === "created" ? "new" : "existing",
    error: it.error?.message,
  }));
  const fresh = rows?.filter((r) => r.kind === "new").length ?? 0;

  const submit = async () => {
    if (!fresh) return;
    setPending(true);
    setError(undefined);
    try {
      const res = await calls.addKeys(
        handle,
        secrets.map((secret) => ({ secret })),
      );
      refresh();
      const added = res.items.filter((it) => it.ok && it.outcome === "created").map((it) => it.result?.name ?? "");
      // Toast: the dialog closes once the keys are in.
      notifyChange(`${added.length} key${added.length === 1 ? "" : "s"} added`, res, { onUndone: refresh });
      close(false);
      if (testAfter && added.length) {
        const t = await calls.testKeys(handle, added);
        refresh();
        // Toast: a background test finishing after the dialog closed.
        if (t.failed === 0) notify.success(`All ${added.length} new key${added.length === 1 ? "" : "s"} passed the test`);
        else onResults(testResults(t, added));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Add Upstream Keys"
      description="Paste one key per line. Iroha names them and skips keys it already has."
      width={560}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" loading={pending} disabled={!fresh} onClick={() => void submit()}>
            {fresh ? `Add ${fresh} key${fresh === 1 ? "" : "s"}` : "Add keys"}
          </Button>
        </>
      }
    >
      <textarea
        autoFocus
        aria-label="Keys, one per line"
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"sk-...\nsk-..."}
        rows={6}
        className="w-full resize-y rounded-lg border border-border-strong bg-subtle px-3 py-2.5 font-mono text-[13px] leading-6 text-fg outline-none placeholder:text-fg-subtle focus:border-info focus:ring-2 focus:ring-info/20"
      />
      <Reveal open={secrets.length > 0} label="Keys found">
        <div className="pt-4">
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between bg-subtle px-4 py-2.5 text-[14px]">
            <span className="font-medium">
              {secrets.length} key{secrets.length === 1 ? "" : "s"} found
            </span>
            <span className="text-fg-muted">{rows ? `${fresh} new` : current?.error ? "" : "Checking…"}</span>
          </div>
          {current?.error && <p className="border-t border-border px-4 py-2.5 text-[14px] text-danger-text">{current.error}</p>}
          {rows && (
            <ScrollArea className="border-t border-border" viewportClassName="max-h-[240px]">
              <ul className="divide-y divide-border">
                {/* Pasted keys are deduplicated, so each secret is one row. */}
                {rows.map((r) => (
                  <li key={r.secret} className="flex items-center gap-3 px-4 py-2 text-[14px]">
                    <Mono className="w-20 shrink-0 text-fg-muted">{maskSecret(r.secret)}</Mono>
                    <span className={cn("min-w-0 flex-1 truncate", r.kind === "existing" && "text-fg-muted", r.kind === "error" && "text-danger-text")}>
                      {r.kind === "error" ? r.error : r.name}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-fg-muted">
                      <StatusDot tone={r.kind === "new" ? "green" : r.kind === "error" ? "red" : "gray"} />
                      {r.kind === "new" ? <span className="text-fg">New</span> : r.kind === "error" ? "Refused" : "Already added"}
                    </span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>
        </div>
      </Reveal>
      <label className="mt-5 flex items-center gap-3 text-[15px]">
        <Switch checked={testAfter} onChange={setTestAfter} label="Test each new key after adding" />
        Test each new key after adding
      </label>
      {secrets.length === 0 && (
        <p className="mt-4 text-[14px] text-fg-muted">
          No key needed?{" "}
          <TextButton disabled={keylessPending} onClick={() => onKeyless(keylessSave)}>
            Add a keyless key
          </TextButton>{" "}
          instead: Iroha then sends no key.
        </p>
      )}
      {error && <p className={cn("mt-3 text-[13px] text-danger-text", appearClass)}>{error}</p>}
      <SaveError save={keylessSave} className="mt-3" />
    </Dialog>
  );
}

// ---- Endpoints a key may use ----

function EndpointsDialog({
  handle,
  provider,
  names,
  keys,
  onClose,
  onResults,
}: {
  handle: string;
  provider?: Provider;
  names?: string[];
  keys: Map<string, UpstreamKey>;
  onClose: () => void;
  onResults: (r: Results) => void;
}) {
  const refresh = useRefresh();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const eps = provider?.endpoints ?? [];

  useEffect(() => {
    if (!names) return;
    setError(undefined);
    // Start from what the first key allows.
    const first = keys.get(names[0]);
    setChosen(new Set(first?.endpoints ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names]);

  const save = async () => {
    if (!names) return;
    setPending(true);
    setError(undefined);
    try {
      const list = eps.filter((e) => chosen.has(e.name)).map((e) => e.name);
      const res = await calls.restrictKeys(
        handle,
        names.map((name) => ({ name, endpoints: list.length === eps.length ? [] : list })),
      );
      refresh();
      // Toast: the dialog closes on Save.
      reportBulk(res, names, list.length && list.length < eps.length ? `limited to ${list.join(", ")}` : "allowed on every Endpoint", onResults, refresh);
      onClose();
    } catch (e) {
      // The dialog stays open, so the failure shows in it.
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={!!names}
      onOpenChange={(o) => !o && onClose()}
      title={names?.length === 1 ? `Endpoints for ${names[0]}` : `Endpoints for ${names?.length} keys`}
      description="A key is only sent to the Endpoints ticked here. Tick none (or all) to allow every Endpoint."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <ul className="divide-y divide-border rounded-lg border border-border">
        {eps.map((e) => (
          <li key={e.id}>
            <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5">
              <Checkbox
                label={e.name}
                checked={chosen.has(e.name)}
                onChange={(on) =>
                  setChosen((s) => {
                    const n = new Set(s);
                    on ? n.add(e.name) : n.delete(e.name);
                    return n;
                  })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">{e.name}</span>
                <span className="block truncate font-mono text-[12.5px] text-fg-muted">{e.url}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={cn("mt-3 text-[13px] text-danger-text", appearClass)}>
          {error}
        </p>
      )}
    </Dialog>
  );
}

// ---- One key ----

function KeyDialog({
  handle,
  k: current,
  missing,
  provider,
  onClose,
  onRenamed,
  actions,
  testing,
}: {
  handle: string;
  k?: UpstreamKey;
  missing?: string;
  provider?: Provider;
  onClose: () => void;
  onRenamed: (name: string) => void;
  actions: KeyActions;
  testing: boolean;
}) {
  const refresh = useRefresh();
  const [shown, setShown] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string>();
  // The dialog stays open, so results show in it: a rename beside the Name
  // field, a new secret under the key, everything else in the footer.
  const nameSave = useSave({ refresh, describe: errorText });
  const secretSave = useSave({ refresh, describe: errorText });
  const actionSave = useSave({ describe: errorText });

  // A key opened (not one closing): start from it.
  useEffect(() => {
    if (!current) return;
    setName(current.name);
    setSecret(undefined);
    nameSave.clear();
    secretSave.clear();
    actionSave.clear();
    setShown(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Motion: the dialog stays mounted while it leaves, still about the key (or
  // missing name) it showed, so the dialog recipe's exit plays.
  const open = !!missing || !!current;
  const last = useRef<{ missing?: string; k?: UpstreamKey }>({});
  if (open) last.current = { missing, k: current };
  const gone = open ? missing : last.current.missing;
  const k = open ? current : last.current.k;

  if (gone)
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={`No key ${gone}`} description={`${handle} has no Upstream Key named ${gone}. It may have been renamed or deleted.`} />
    );
  if (!k) return null;

  const rename = (to: string) =>
    void nameSave.run(
      async () => {
        const res = await calls.updateKey(handle, k.name, { name: to });
        onRenamed(to);
        return res;
      },
      { message: `Renamed to ${to}` },
    );
  const replace = (to: string) =>
    void secretSave.run(
      async () => {
        const res = await calls.updateKey(handle, k.name, { secret: to });
        setSecret(undefined);
        return res;
      },
      { message: "Key replaced" },
    );

  const clearGap = (model?: string) =>
    void actionSave.run(
      async () => {
        const res = await calls.clearKeyGaps(handle, k.name, model);
        await refresh();
        return res;
      },
      { message: model ? `Model Gap for ${model} cleared` : "Model Gaps cleared" },
    );

  const clearEndpointGap = (endpoint?: string) =>
    void actionSave.run(
      async () => {
        const res = await calls.clearEndpointGaps(handle, k.name, endpoint);
        await refresh();
        return res;
      },
      { message: endpoint ? `Endpoint Gap on ${endpoint} cleared` : "Endpoint Gaps cleared" },
    );

  const eps = provider?.endpoints ?? [];
  const s = k.state;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={k.name} description={`Upstream Key of ${handle}`} width={600}>
      <div className="flex flex-col gap-6">
        <section>
          <h3 className="mb-2 text-[14px] font-semibold">State</h3>
          <div className="rounded-lg border border-border px-4 py-3">
            <div className="flex items-center gap-3 text-[15px]">
              <KeyStateLabel state={s} />
              {s.since && <span className="text-[13.5px] text-fg-muted">since {timeAgo(s.since)}</span>}
            </div>
            {s.reason && <p className="mt-1.5 text-[14px] text-fg-muted">{s.reason}</p>}
            {(s.rule || s.request_id) && (
              <p className="mt-1.5 flex flex-wrap gap-x-4 text-[13.5px] text-fg-muted">
                {s.rule && <span>Rule: {s.rule}</span>}
                {s.request_id && (
                  <RecordLink record={rec.request(s.request_id)} drop={DIALOG}>
                    Open the Request
                  </RecordLink>
                )}
              </p>
            )}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-[14px] font-semibold">Key</h3>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-subtle py-1 pl-3 pr-1">
            <Mono className="min-w-0 flex-1 break-all py-1 text-fg">{k.secret ? (shown ? k.secret : maskSecret(k.secret)) : "Keyless: no key is sent"}</Mono>
            {k.secret && <IconButton icon={shown ? EyeOff : Eye} label={shown ? "Hide the key" : "Show the key"} size="sm" onClick={() => setShown((x) => !x)} />}
            {k.secret && <CopyButton icon value={k.secret} what="Key" label="Copy the key" />}
            <Button size="sm" variant="ghost" onClick={() => setSecret(secret === undefined ? "" : undefined)}>
              {secret !== undefined ? "Cancel" : k.secret ? "Replace" : "Add a secret"}
            </Button>
          </div>
          <Reveal open={secret !== undefined} label="New key" className={ringRoom}>
            <form
              className="flex gap-2 pt-2"
              onSubmit={(e) => {
                e.preventDefault();
                replace((secret ?? "").trim());
              }}
            >
              <Input mono autoFocus placeholder="The new key" value={secret ?? ""} onChange={(e) => setSecret(e.target.value)} aria-label="New key" aria-invalid={!!secretSave.error} />
              <Button type="submit" variant="primary" loading={secretSave.pending} disabled={!secret?.trim()}>
                Save
              </Button>
            </form>
          </Reveal>
          <SaveStatus save={secretSave} saving={false} className="mt-2" />
          <SaveError save={secretSave} className="mt-2" />
        </section>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name.trim() !== k.name) rename(name.trim());
          }}
        >
          <Field label="Name" hint="Unique within the Provider; Requests and Audit Entries show it." error={nameSave.error}>
            {(p) => (
              <div className="flex flex-wrap items-center gap-2">
                <Input {...p} mono className="min-w-48 flex-1" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
                {name.trim() !== k.name ? (
                  <Button type="submit" variant="primary" loading={nameSave.pending}>
                    Rename
                  </Button>
                ) : (
                  <SaveStatus save={nameSave} className="shrink-0" />
                )}
              </div>
            )}
          </Field>
        </form>

        {(k.model_gaps.length > 0 || k.cooling_models.length > 0) && (
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[14px] font-semibold">Models this key can't serve now</h3>
              {k.model_gaps.length > 1 && (
                <TextButton className="text-[13.5px]" onClick={() => void clearGap()}>
                  Clear all Model Gaps
                </TextButton>
              )}
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border text-[14px]">
              {k.model_gaps.map((g) => (
                <li key={`g${g.model}`} className="flex items-start gap-3 px-4 py-2.5">
                  <StatusDot tone="blue" className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono">{g.model}</span>
                    <span className="block text-fg-muted">
                      Model Gap: {g.reason}. Ends {formatDate(g.expires_at)}.
                    </span>
                  </span>
                  <TextButton className="shrink-0" aria-label={`Clear the Model Gap for ${g.model}`} onClick={() => void clearGap(g.model)}>
                    Clear
                  </TextButton>
                </li>
              ))}
              {k.cooling_models.map((c) => (
                <CoolingRow key={`c${c.model}`} model={c.model} reason={c.reason} until={c.until} />
              ))}
            </ul>
          </section>
        )}

        {(eps.length > 1 || k.endpoint_gaps.length > 0) && (
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[14px] font-semibold">Endpoints</h3>
              <TextButton className="text-[13.5px]" aria-label={`Change the Endpoints of ${k.name}`} onClick={() => actions.endpoints(k)}>
                Change
              </TextButton>
            </div>
            <p className="text-[14px] text-fg-muted">
              {k.endpoints.length ? (
                <>
                  Only <EndpointNames handle={handle} names={k.endpoints} />
                </>
              ) : (
                "Every Endpoint"
              )}
              {k.worked_on.length > 0 && (
                <>
                  . Worked on <EndpointNames handle={handle} names={k.worked_on.map((w) => w.endpoint)} />.
                </>
              )}
            </p>
            {k.endpoint_gaps.length > 0 && (
              <>
                <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-[14px]">
                  {k.endpoint_gaps.map((g) => (
                    <li key={g.endpoint_id} className="flex items-start gap-3 px-4 py-2.5">
                      <StatusDot tone="blue" className="mt-1.5" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 font-medium">
                          <RecordLink record={rec.endpoint(handle, g.endpoint)} drop={DIALOG}>
                            {g.endpoint}
                          </RecordLink>
                        </span>
                        <span className="block text-fg-muted">Endpoint Gap: {g.reason}. Not sent there until cleared; a passing test there clears it.</span>
                      </span>
                      <TextButton className="shrink-0" aria-label={`Clear the Endpoint Gap on ${g.endpoint}`} onClick={() => void clearEndpointGap(g.endpoint)}>
                        Clear
                      </TextButton>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex justify-end">
                  <Button size="sm" icon={Waypoints} onClick={() => actions.restrictToWorking(k, actionSave)}>
                    Restrict to working Endpoints
                  </Button>
                </div>
              </>
            )}
          </section>
        )}

        <dl className="grid grid-cols-2 gap-4 text-[14px]">
          <div>
            <dt className="text-fg-muted">Added</dt>
            <dd>{formatDate(k.created_at)}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Last used</dt>
            <dd>{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-border pt-5">
        <Button variant="ghost" danger icon={Trash2} onClick={() => actions.remove(k)}>
          Delete…
        </Button>
        <div className="flex-1" />
        <Button icon={k.enabled ? Pause : CircleSlash} onClick={() => actions.toggle(k, actionSave)}>
          {k.enabled ? "Disable" : "Enable"}
        </Button>
        <Button icon={MessageCircle} onClick={() => actions.chat(k)}>
          Test in Chat
        </Button>
        <Button variant="primary" icon={Play} loading={testing} onClick={() => actions.test(k, actionSave)}>
          Test
        </Button>
      </div>
      {/* Its own line under the buttons that caused it, so a long result never squeezes them. */}
      <div className="mt-3 flex min-h-5 flex-wrap items-center justify-end gap-x-2 empty:hidden">
        <SaveStatus save={actionSave} saving={false} />
        <SaveError save={actionSave} />
      </div>
    </Dialog>
  );
}

/** The key's dialog is in the URL (?key=): a link out of it closes it, and Back reopens it. */
const DIALOG = ["key"];

/** "main, intl": each Endpoint's name a link to its sheet. */
function EndpointNames({ handle, names }: { handle: string; names: string[] }) {
  return names.map((n, i) => (
    <span key={n}>
      {i > 0 && ", "}
      <RecordLink record={rec.endpoint(handle, n)} drop={DIALOG} className="align-bottom">
        {n}
      </RecordLink>
    </span>
  ));
}

function CoolingRow({ model, reason, until }: { model: string; reason: string; until: string }) {
  const left = Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000));
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <StatusDot tone={stateTone.cooling} className="mt-1.5" />
      <span className="min-w-0 flex-1">
        <span className="block font-mono">{model}</span>
        <span className="block text-fg-muted">
          Cooling for this model, {shortWait(left)} left: {reason}
        </span>
      </span>
    </li>
  );
}
