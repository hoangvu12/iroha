import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronDown, History, KeyRound, LockKeyhole, Monitor, RotateCcw, User } from "lucide-react";
import { revertEntry } from "@/api/audit";
import { isApiError } from "@/api/client";
import type { Actor, AuditEntry } from "@/api/types";
import { useIsPhone } from "@/lib/media";
import { Button, buttonClass } from "@/ui/Button";
import { ConfirmAction } from "@/ui/Confirm";
import { DataTable, columnsFor, useTablePaging } from "@/ui/DataTable";
import { SearchInput } from "@/ui/Input";
import { LogoTile, PoolTile, ProviderTile } from "@/ui/LogoTile";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { cn } from "@/ui/cn";
import { riseIn } from "@/ui/Reveal";
import { Chip, EmptyState } from "@/ui/States";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { type EntryFilter, type ResourceOption, useAuditEntries, useAuditFilters, useInvalidateAll } from "./api";
import { ChangedName, EntryChanges, RevertNote } from "./Changes";
import { clockTime, dayLabel } from "./format";
import { SAMPLE_AUDIT_ENTRIES } from "./samples";

// Settings → Audit Entries (C29) on the shared DataTable (UI ticket 08): every
// change, newest first, in numbered pages; a row shows its before and after
// under it, and Revert sits in the row. The filters live in the URL
// (?q=&actor=&resource=), so other pages can link to a filtered history.
// The API reads older entries from a cursor (`before`), so each page of the
// table is one page of the API, read once the page before it is; the total
// isn't known until the last page is. Columns don't sort: the server's order
// (newest first) is the only one a cursor can page.

type Labels = Map<string, ResourceOption>;

/** Entries that start a new day on the page, which show the day over their time. */
const DayStarts = createContext<Set<string>>(new Set());
const LabelsOf = createContext<Labels>(new Map());

const entryName = (e: AuditEntry) => `${e.summary} at ${clockTime(e.time)}`;

const col = columnsFor<AuditEntry>();
const columns = col.columns([
  col.display({ id: "time", header: "Time", meta: { width: "w-[92px]" }, cell: ({ row }) => <When entry={row.original} /> }),
  col.display({
    id: "actor",
    header: "Changed by",
    meta: { width: "w-[16%]", className: "max-w-0 text-[15px] text-fg-muted" },
    cell: ({ row }) => <ActorName actor={row.original.actor} />,
  }),
  col.display({ id: "change", header: "Change", meta: { className: "max-w-0 text-[15px] font-medium" }, cell: ({ row }) => <Summary entry={row.original} /> }),
  col.display({ id: "target", header: "On", meta: { width: "w-[24%]", className: "max-w-0 text-[15px]" }, cell: ({ row }) => <Target entry={row.original} /> }),
  col.display({
    id: "revert",
    header: () => <span className="sr-only">Revert</span>,
    meta: { width: "w-[150px]", label: "Revert", className: "text-right" },
    cell: ({ row }) => <RevertControl entry={row.original} />,
  }),
]);

/** Settings → Audit Entries (C29): every change, newest first, with Revert on the row. */
export function AuditEntriesTab() {
  const phone = useIsPhone();
  const [params, setParams] = useSearchParams();
  const actor = params.get("actor") ?? "";
  const resource = params.get("resource") ?? "";
  const [text, setText] = useState(params.get("q") ?? "");
  const q = useDebounced(text.trim(), 250);

  const setParam = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  useEffect(() => setParam("q", q), [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const [pagination, setPagination] = useTablePaging("audit-entries");
  const filter: EntryFilter = { q, actor, resource };
  const entries = useAuditEntries(filter, pagination.pageSize);
  const filters = useAuditFilters();
  const labels = useMemo<Labels>(() => new Map((filters.data?.resources ?? []).map((r) => [r.name, r])), [filters.data]);
  const actorLabel = (filters.data?.actors ?? []).find((a) => a.filter === actor)?.name ?? actor;
  const resourceLabel = labels.get(resource)?.plural ?? resource.replace(/_/g, " ");

  // A new filter starts again on page 1 (the table does that for the search itself).
  const filterKey = `${actor}\n${resource}`;
  const [lastFilter, setLastFilter] = useState(filterKey);
  if (lastFilter !== filterKey) {
    setLastFilter(filterKey);
    if (pagination.pageIndex !== 0) setPagination((p) => ({ ...p, pageIndex: 0 }));
  }

  // Page N of the table is page N of the API: read it when it's asked for.
  const pages = entries.data?.pages ?? [];
  const wanted = pagination.pageIndex;
  const { hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage } = entries;
  useEffect(() => {
    if (wanted >= pages.length && hasNextPage && !isFetchingNextPage && !isPlaceholderData) void fetchNextPage();
  }, [wanted, pages.length, hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage]);
  // Until it lands the page before stays, dimmed.
  const shownIndex = Math.min(wanted, Math.max(0, pages.length - 1));
  const rows = entries.data ? (pages[shownIndex]?.entries ?? []) : undefined;
  const loaded = pages.reduce((n, p) => n + p.entries.length, 0);
  // Pages past the last one read are one page more while the API has older entries.
  const rowCount = loaded + (hasNextPage ? pagination.pageSize : 0);

  const dayStarts = useMemo(() => {
    const starts = new Set<string>();
    let last = "";
    for (const e of rows ?? []) {
      const day = dayLabel(e.time);
      if (day !== last) starts.add(e.id);
      last = day;
    }
    return starts;
  }, [rows]);

  const chips = [
    ...(q ? [{ label: `Text is “${q}”`, onRemove: () => setText("") }] : []),
    ...(actor ? [{ label: `By ${actorLabel}`, onRemove: () => setParam("actor", "") }] : []),
    ...(resource ? [{ label: `Only ${resourceLabel}`, onRemove: () => setParam("resource", "") }] : []),
  ];
  const clear = () => {
    setText("");
    setParams({}, { replace: true });
  };

  const toolbar = (
    <>
      <SearchInput
        placeholder="Search changes"
        aria-label="Search changes"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-w-0 flex-1 md:w-[300px] md:flex-none"
      />
      <Menu>
        <MenuTrigger className={buttonClass("secondary", "md", "gap-1.5")}>
          {actor ? actorLabel : "Anyone"}
          <ChevronDown size={15} aria-hidden className="text-fg-muted" />
        </MenuTrigger>
        <MenuContent align="start" className="min-w-56" maxHeight="max-h-[min(60vh,calc(var(--available-height)-2px))]">
          <MenuRadioGroup label="Changed by" value={actor} onValueChange={(v) => setParam("actor", v)}>
            <MenuRadioItem value="">Anyone</MenuRadioItem>
            {(filters.data?.actors ?? []).map((a) => (
              <MenuRadioItem key={a.filter} value={a.filter}>
                <ActorIcon kind={a.kind} />
                <span className="truncate">{a.name}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuRadioGroup label="Changed what" value={resource} onValueChange={(v) => setParam("resource", v)}>
            <MenuRadioItem value="">Everything</MenuRadioItem>
            {(filters.data?.resources ?? []).map((r) => (
              <MenuRadioItem key={r.name} value={r.name}>
                {r.plural}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      {resource && <Chip label={`Only ${resourceLabel}`} onRemove={() => setParam("resource", "")} />}
    </>
  );

  const from = shownIndex * pagination.pageSize + 1;
  return (
    <section aria-label="Audit Entries">
      <LabelsOf.Provider value={labels}>
        <DayStarts.Provider value={dayStarts}>
          <DataTable<AuditEntry>
            id="audit-entries"
            label="Audit Entries"
            columns={columns}
            data={rows}
            sample={SAMPLE_AUDIT_ENTRIES}
            getRowId={(e) => e.id}
            rowName={entryName}
            error={entries.isError ? entries.error : undefined}
            onRetry={() => void entries.refetch()}
            toolbar={toolbar}
            search={q}
            manualFiltering
            filterChips={chips}
            noResultsTitle="No changes match these filters"
            onClearFilters={clear}
            paging={{ mode: "server", pagination, onPaginationChange: setPagination, rowCount }}
            dimmed={isPlaceholderData || wanted !== shownIndex}
            renderExpanded={(e) => <Details entry={e} labels={labels} phone={phone} />}
            phoneRow={(e) => <EntryLine entry={e} />}
            empty={
              <EmptyState
                icon={History}
                title="No changes yet"
                description="Every change to Iroha's configuration shows up here, with who made it and a way to revert it."
              />
            }
            footer={() =>
              rows && rows.length > 0
                ? `${from}–${from + rows.length - 1} of ${hasNextPage ? `more than ${loaded}` : loaded} changes`
                : null
            }
          />
        </DayStarts.Provider>
      </LabelsOf.Provider>
    </section>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The time; the first entry of each day on the page shows the day over it. */
function When({ entry }: { entry: AuditEntry }) {
  const first = useContext(DayStarts).has(entry.id);
  return (
    <span className="flex flex-col leading-tight">
      {first && <span className="text-[12.5px] font-medium text-fg-muted">{dayLabel(entry.time)}</span>}
      <span className="font-mono text-[13.5px] text-fg-muted">{clockTime(entry.time)}</span>
    </span>
  );
}

function Summary({ entry }: { entry: AuditEntry }) {
  const target = targetOf(entry);
  return (
    <span className="block truncate" title={entry.summary}>
      {what(entry, target)}
    </span>
  );
}

function Target({ entry }: { entry: AuditEntry }) {
  const labels = useContext(LabelsOf);
  const target = targetOf(entry);
  if (!target) return null;
  const targetLabel = target.parent ? target.name : `${labels.get(target.resource)?.label ?? target.resource} ${target.name}`;
  return (
    <span className="flex min-w-0 items-center gap-2.5" title={targetLabel}>
      <TargetIcon resource={target.resource} name={target.name} />
      <TargetName t={target} />
    </span>
  );
}

/** Under an opened row: what changed, before and after, and what Revert would do; on phones Revert too. */
function Details({ entry, labels, phone }: { entry: AuditEntry; labels: Labels; phone: boolean }) {
  return (
    // Enters like a row (UI ticket 20): a row's shift and a fade, never its height (the rows under it move down at once).
    <div className={cn("flex flex-col gap-4 pt-1 md:ml-[140px] md:max-w-[720px]", riseIn)}>
      <EntryChanges entry={entry} labels={labels} />
      <RevertNote entry={entry} />
      {phone && (
        <div>
          <RevertControl entry={entry} />
        </div>
      )}
    </div>
  );
}

/** Phones: what changed and when, then who and on what (C31). */
function EntryLine({ entry }: { entry: AuditEntry }) {
  const target = targetOf(entry);
  const first = useContext(DayStarts).has(entry.id);
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-[15.5px] font-medium">{what(entry, target)}</p>
        <span className="shrink-0 font-mono text-[13px] text-fg-muted">
          {first && <span className="mr-1.5 font-sans">{dayLabel(entry.time)}</span>}
          {clockTime(entry.time)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[14px] text-fg-muted">
        <ActorName actor={entry.actor} />
        {target && <TargetName t={target} />}
      </div>
    </div>
  );
}

function ActorIcon({ kind }: { kind: Actor["kind"] }) {
  const Icon = kind === "owner_session" ? User : KeyRound;
  return <Icon size={15} className="shrink-0 text-fg-muted" />;
}

function ActorName({ actor }: { actor: Actor }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <ActorIcon kind={actor.kind} />
      <span className="truncate">{actor.name}</span>
    </span>
  );
}

/**
 * What an entry changed, as one name: the record when there is one, the
 * shared parent when several children of one Provider changed
 * ("dashscope/team-1", "dashscope/team-2" -> dashscope), else the first.
 */
type TargetOf = { id: string; name: string; resource: string; parent: boolean; more: number };

function targetOf(e: AuditEntry): TargetOf | undefined {
  const c = e.changes;
  if (c.length === 0) return undefined;
  if (c.length === 1) return { id: c[0].id, name: c[0].name, resource: c[0].resource, parent: false, more: 0 };
  const parent = c[0].name.includes("/") ? c[0].name.slice(0, c[0].name.indexOf("/")) : "";
  if (parent && c.every((x) => x.name.startsWith(parent + "/"))) return { id: "", name: parent, resource: "provider", parent: true, more: 0 };
  return { id: c[0].id, name: c[0].name, resource: c[0].resource, parent: false, more: c.length - 1 };
}

/** The changed record's name, a link to its sheet when it has one (UI ticket 11). */
function TargetName({ t }: { t: TargetOf }) {
  return (
    <span className="flex min-w-0 items-baseline">
      <ChangedName resource={t.resource} id={t.id} name={t.name} className="min-w-0" />
      {t.more > 0 && <span className="shrink-0 whitespace-pre text-fg-muted"> and {t.more} more</span>}
    </span>
  );
}

const keyLike = new Set(["admin_token", "gateway_key", "upstream_key"]);

function TargetIcon({ resource, name }: { resource: string; name: string }) {
  const tile = "inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-bg text-fg-muted";
  if (keyLike.has(resource))
    return (
      <span className={tile} aria-hidden="true">
        <KeyRound size={14} />
      </span>
    );
  if (resource === "owner_password")
    return (
      <span className={tile} aria-hidden="true">
        <LockKeyhole size={14} />
      </span>
    );
  if (resource === "owner_session")
    return (
      <span className={tile} aria-hidden="true">
        <Monitor size={14} />
      </span>
    );
  if (resource === "provider") return <ProviderTile handle={name} size={28} />;
  if (resource === "pool") return <PoolTile name={name} size={28} />;
  return <LogoTile name={name} size={28} />;
}

/** "Created Admin Token huy" shows as "Created Admin Token", with huy in its own column. */
function what(e: AuditEntry, target?: { name: string }) {
  if (target && e.changes.length === 1 && e.summary.endsWith(" " + target.name)) return e.summary.slice(0, -target.name.length - 1);
  return e.summary;
}

function revertError(e: unknown): string {
  if (!isApiError(e)) return e instanceof Error ? e.message : String(e);
  if (e.code === "audit_conflict") {
    const conflicts = (e.details as { conflicts?: { name: string }[] } | undefined)?.conflicts ?? [];
    const names = conflicts.map((c) => c.name).join(", ");
    return `${names || "A record"} changed since. Revert the newer change first.`;
  }
  return e.hint ? `${e.message} ${e.hint}` : e.message;
}

/**
 * Revert: the result (with Undo, which puts the change back) shows in its place, a failure under it.
 * Named "Revert <summary>" so each row's button is its own for agents.
 */
function RevertControl({ entry }: { entry: AuditEntry }) {
  const invalidate = useInvalidateAll();
  const reverting = useSave({ refresh: invalidate, describe: (e) => `Couldn't revert. ${revertError(e)}` });
  if (reverting.done) return <SaveStatus save={reverting} className="whitespace-nowrap" />;
  if (entry.reverted_by) return <span className="whitespace-nowrap text-[14px] text-fg-muted">Reverted</span>;
  if (!entry.revertible)
    return (
      <span className="whitespace-nowrap text-[14px] text-fg-muted" title={entry.not_revertible}>
        Can't be reverted
      </span>
    );
  // Reverting a create deletes what it made: that asks first, naming what goes (UI ticket 21).
  const goes = entry.changes.filter((c) => c.op === "create");
  if (goes.length)
    return (
      <ConfirmAction
        title={`Revert and delete ${goes.length === 1 ? goes[0].name : `${goes.length} records`}?`}
        body={`${goes.length === 1 ? goes[0].name : goes.map((c) => c.name).join(", ")} ${goes.length === 1 ? "was" : "were"} made by this change and ${goes.length === 1 ? "goes" : "go"} with it. Undo brings ${goes.length === 1 ? "it" : "them"} back.`}
        confirmLabel="Revert and delete"
        onConfirm={async () => {
          // A failure shows in the confirm dialog; once it closes, the result shows in this row like any revert.
          try {
            const res = await revertEntry(entry.id);
            await invalidate();
            reverting.show({ message: "Reverted", entry: res.audit_entry, undone: true });
          } catch (e) {
            void invalidate();
            throw new Error(revertError(e));
          }
        }}
      >
        <Button danger="hover" icon={RotateCcw} aria-label={`Revert ${entry.summary}…`}>
          Revert…
        </Button>
      </ConfirmAction>
    );
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        icon={RotateCcw}
        aria-label={`Revert ${entry.summary}`}
        loading={reverting.pending}
        onClick={() => void reverting.run(() => revertEntry(entry.id), { message: () => ({ message: "Reverted", undone: true }) })}
      >
        Revert
      </Button>
      <SaveError save={reverting} className="text-right text-[12.5px] leading-snug" />
    </span>
  );
}
