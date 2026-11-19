import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronDown, History, KeyRound, LockKeyhole, Monitor, RotateCcw, User } from "lucide-react";
import { revertEntry } from "@/api/audit";
import { isApiError } from "@/api/client";
import type { Actor, AuditEntry } from "@/api/types";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton, buttonClass } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { ConfirmAction } from "@/ui/Confirm";
import { SearchInput } from "@/ui/Input";
import { LogoTile, PoolTile, ProviderTile } from "@/ui/LogoTile";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { Chip, EmptyState, ErrorState, NoResults } from "@/ui/States";
import { Skeleton } from "@/ui/Skeleton";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { type EntryFilter, type ResourceOption, useAuditEntries, useAuditFilters, useInvalidateAll } from "./api";
import { EntryChanges, RevertNote } from "./Changes";
import { clockTime, dayLabel } from "./format";
import { SAMPLE_AUDIT_ENTRIES } from "./samples";

/** Settings → Audit Entries (C29): every change, grouped by day, with Revert on the row. */
export function AuditEntriesTab() {
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
  useEffect(() => setParam("q", q), [q]);

  const filter: EntryFilter = { q, actor, resource };
  const entries = useAuditEntries(filter);
  const filters = useAuditFilters();
  const labels = useMemo(() => new Map((filters.data?.resources ?? []).map((r) => [r.name, r])), [filters.data]);
  const actorLabel = (filters.data?.actors ?? []).find((a) => a.filter === actor)?.name ?? actor;
  const resourceLabel = labels.get(resource)?.plural ?? resource.replace(/_/g, " ");

  const chips = [
    ...(q ? [{ label: `Text is “${q}”`, onRemove: () => setText("") }] : []),
    ...(actor ? [{ label: `By ${actorLabel}`, onRemove: () => setParam("actor", "") }] : []),
    ...(resource ? [{ label: `Only ${resourceLabel}`, onRemove: () => setParam("resource", "") }] : []),
  ];
  const clear = () => {
    setText("");
    setParams({}, { replace: true });
  };

  const all = entries.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <section aria-label="Audit Entries">
      <div className="mb-6 flex flex-wrap items-center gap-3">
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
      </div>

      {entries.isError ? (
        <ErrorState title="Couldn't load Audit Entries" error={entries.error} onRetry={() => void entries.refetch()} />
      ) : (
      // Measured from sample entries grouped by day, like the real list. A filter change keeps the list (dimmed).
      <Skeleton
        data={entries.data ? all : undefined}
        sample={SAMPLE_AUDIT_ENTRIES}
        id="audit-entries"
        label="Loading Audit Entries"
        className={cn("transition-opacity", entries.isPlaceholderData && "opacity-60")}
      >
      {(all) => all.length === 0 ? (
        chips.length > 0 ? (
          <NoResults title="No changes match these filters" filters={chips} onClear={clear} />
        ) : (
          <EmptyState
            icon={History}
            title="No changes yet"
            description="Every change to Iroha's configuration shows up here, with who made it and a way to revert it."
          />
        )
      ) : (
        <>
          <EntryList entries={all} labels={labels} />
          {entries.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button loading={entries.isFetchingNextPage} onClick={() => void entries.fetchNextPage()}>
                Show older changes
              </Button>
            </div>
          )}
        </>
      )}
      </Skeleton>
      )}
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

type Labels = Map<string, ResourceOption>;

function EntryList({ entries, labels }: { entries: AuditEntry[]; labels: Labels }) {
  const [open, setOpen] = useState<string>();
  const groups: { day: string; entries: AuditEntry[] }[] = [];
  for (const e of entries) {
    const day = dayLabel(e.time);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else groups.push({ day, entries: [e] });
  }
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.day} aria-label={g.day}>
          <h3 className="mb-1 px-2.5 text-[13px] font-medium text-fg-muted">{g.day}</h3>
          <ul>
            {g.entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                labels={labels}
                open={open === e.id}
                onToggle={() => setOpen((o) => (o === e.id ? undefined : e.id))}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ActorIcon({ kind }: { kind: Actor["kind"] }) {
  const Icon = kind === "owner_session" ? User : KeyRound;
  return <Icon size={15} className="shrink-0 text-fg-muted" />;
}

function ActorName({ actor }: { actor: Actor }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
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
function targetOf(e: AuditEntry): { name: string; resource: string; parent: boolean; more: number } | undefined {
  const c = e.changes;
  if (c.length === 0) return undefined;
  if (c.length === 1) return { name: c[0].name, resource: c[0].resource, parent: false, more: 0 };
  const parent = c[0].name.includes("/") ? c[0].name.slice(0, c[0].name.indexOf("/")) : "";
  if (parent && c.every((x) => x.name.startsWith(parent + "/"))) return { name: parent, resource: "provider", parent: true, more: 0 };
  return { name: c[0].name, resource: c[0].resource, parent: false, more: c.length - 1 };
}

function TargetName({ t }: { t: { name: string; more: number } }) {
  return (
    <span className="truncate">
      {t.name}
      {t.more > 0 && <span className="text-fg-muted"> and {t.more} more</span>}
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

/** The desktop row and its opened details share columns: time, who, what, on what, Revert, chevron. */
const ROW_GRID = "grid grid-cols-[64px_minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1fr)_136px_28px] gap-x-4 px-2.5";

function EntryRow({ entry, labels, open, onToggle }: { entry: AuditEntry; labels: Labels; open: boolean; onToggle: () => void }) {
  const phone = useIsPhone();
  const target = targetOf(entry);
  const summary = what(entry, target);
  const detailsId = `entry-${entry.id}`;
  const targetLabel = target && (target.parent ? target.name : `${labels.get(target.resource)?.label ?? target.resource} ${target.name}`);

  const toggle = (
    <IconButton
      icon={ChevronDown}
      label={open ? "Hide before and after" : "Show before and after"}
      size="sm"
      aria-expanded={open}
      aria-controls={detailsId}
      onClick={(ev) => {
        ev.stopPropagation();
        onToggle();
      }}
      className={cn("transition-transform", open && "rotate-180")}
    />
  );

  return (
    <li className={cn("rounded-lg", open && "bg-subtle")}>
      {phone ? (
        <div className="flex cursor-pointer items-start gap-2 px-1 py-3" onClick={onToggle}>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className="truncate text-[15.5px] font-medium">{summary}</p>
              <span className="shrink-0 font-mono text-[13px] text-fg-muted">{clockTime(entry.time)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 text-[14px] text-fg-muted">
              <ActorName actor={entry.actor} />
              {target && <TargetName t={target} />}
            </div>
          </div>
          {toggle}
        </div>
      ) : (
        <div className={cn(ROW_GRID, "min-h-[64px] cursor-pointer items-center")} onClick={onToggle}>
          <span className="font-mono text-[13.5px] text-fg-muted">{clockTime(entry.time)}</span>
          <span className="min-w-0 text-[15px] text-fg-muted">
            <ActorName actor={entry.actor} />
          </span>
          <span className="truncate text-[15px] font-medium" title={entry.summary}>
            {summary}
          </span>
          <span className="flex min-w-0 items-center gap-2.5 text-[15px]" title={targetLabel}>
            {target && (
              <>
                <TargetIcon resource={target.resource} name={target.name} />
                <TargetName t={target} />
              </>
            )}
          </span>
          <span className="flex justify-end" onClick={(ev) => ev.stopPropagation()}>
            <RevertControl entry={entry} />
          </span>
          {toggle}
        </div>
      )}
      {open &&
        (phone ? (
          <div id={detailsId} className="flex flex-col gap-5 px-3 pb-4 pt-1">
            <EntryChanges entry={entry} labels={labels} />
            <RevertNote entry={entry} />
            <div>
              <RevertControl entry={entry} />
            </div>
          </div>
        ) : (
          <div id={detailsId} className={cn(ROW_GRID, "items-start pb-5 pt-1")}>
            <div className="col-start-3">
              <EntryChanges entry={entry} labels={labels} />
            </div>
            <div className="col-span-3 pt-1">
              <RevertNote entry={entry} />
            </div>
          </div>
        ))}
    </li>
  );
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

/** Revert: the result (with Undo, which puts the change back) shows in its place, a failure under it. */
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
        <Button danger="hover" icon={RotateCcw}>
          Revert…
        </Button>
      </ConfirmAction>
    );
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        icon={RotateCcw}
        loading={reverting.pending}
        onClick={() => void reverting.run(() => revertEntry(entry.id), { message: () => ({ message: "Reverted", undone: true }) })}
      >
        Revert
      </Button>
      <SaveError save={reverting} className="text-right text-[12.5px] leading-snug" />
    </span>
  );
}
