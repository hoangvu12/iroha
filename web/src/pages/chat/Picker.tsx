import type { MutableRefObject, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, CornerDownLeft } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList } from "@ui-sdk/react/command";
import { Listbox, ListboxItem, ListboxItemIndicator } from "@ui-sdk/react/listbox";
import { createPopoverController, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { formatNumber } from "@/lib/format";
import { useGatewayKeys, useKeys, useProvider } from "@/pages/providers/api";
import { KeyStateLabel, Segmented } from "@/pages/providers/controls";
import { Kbd } from "@/ui/bits";
import { IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { PoolTile, ProviderTile } from "@/ui/LogoTile";
import { popupMotionClass } from "@/ui/popup";
import { ScrollArea } from "@/ui/ScrollArea";
import { Skeleton } from "@/ui/Skeleton";
import type { ModelChoice, Reasoning, Settings, Shape } from "./api";
import { bareModel, preferOf, providerOf, SHAPES, shapeLabel, useModelChoices } from "./api";
import { recentModels } from "./store";

// The composer's model button (C16, C27): the model, then Provider,
// Upstream Key, Endpoint, Shape, Send as and Reasoning (test tools are the
// composer's wrench, tools.tsx).
// Each row opens its own list in the same popover; the model list searches
// on the server (GET /api/test/models), the picked model's Provider first
// (else Pools first), and takes typed IDs.

export type View = "main" | "models" | "keys" | "endpoints" | "shapes" | "as";

/** Opens the picker from its triggers and from code, at a given view. */
export const createPickerController = () => createPopoverController<View>();
export type PickerController = ReturnType<typeof createPickerController>;
export const PickerTrigger = PopoverTrigger;

// Stands for "no pin" in lists whose values are names.
const ANY = "*any";

/** A model's logo: square for a Pool, round for a Provider's model. */
export function ModelTile({ model, size = 20 }: { model: string; size?: number }) {
  const p = providerOf(model);
  return p ? <ProviderTile handle={p} size={size} /> : <PoolTile name={model} size={size} />;
}

/** The popover above the composer, lined up with `anchor` (the composer column). */
export function PickerPopover({
  controller,
  anchor,
  settings,
  onChange,
}: {
  controller: PickerController;
  anchor: HTMLElement | null;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  // Escape in a list goes back to the settings; on the settings it closes.
  const back = useRef<() => boolean>(() => false);
  const [opening, setOpening] = useState(0);
  return (
    <Popover
      controller={controller}
      onOpenChange={(open, details) => {
        if (!open && details.reason === "escape-key" && back.current()) return details.cancel();
        if (open) setOpening((n) => n + 1);
      }}
      onPayloadChange={() => setOpening((n) => n + 1)}
    >
      <PopoverContent<View>
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        initialFocus="[data-autofocus]"
        className={cn(
          "flex w-(--anchor-width) max-h-[min(640px,calc(100dvh-160px),var(--available-height))] flex-col overflow-hidden rounded-xl border border-border bg-elevated text-fg shadow-elevated outline-none",
          // The shared popup recipe: grows from the composer, leaves faster; fades only under reduced motion.
          // Its own surface (wider radius, no padding), so the recipe without popupClass's surface.
          popupMotionClass,
        )}
      >
        {(state) => (
          <>
            <PopoverTitle className="sr-only">Model and settings</PopoverTitle>
            <Picker key={opening} initial={state.payload ?? "main"} settings={settings} onChange={onChange} onClose={() => controller.close()} backRef={back} />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Picker({
  settings,
  onChange,
  onClose,
  initial,
  backRef,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  initial: View;
  backRef: MutableRefObject<() => boolean>;
}) {
  const [view, setView] = useState<View>(settings.model ? initial : "models");
  const [query, setQuery] = useState("");
  const back = () => (settings.model ? setView("main") : onClose());
  const provider = providerOf(settings.model);
  const root = useRef<HTMLDivElement>(null);
  backRef.current = () => {
    if (view === "main" || !settings.model) return false;
    setView("main");
    return true;
  };

  // The view that took the old one's place takes focus, so it stays inside.
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [view]);

  const body = (() => {
    switch (view) {
      case "models":
        return (
          <ModelList
            settings={settings}
            initialQuery={query}
            onBack={back}
            onPick={(model) => {
              const sameProvider = providerOf(model) === provider;
              onChange({ model, ...(sameProvider ? {} : { upstreamKey: undefined, endpoint: undefined }) });
              setView("main");
            }}
          />
        );
      case "keys":
        return <KeyList handle={provider!} value={settings.upstreamKey} onBack={back} onPick={(upstreamKey) => (onChange({ upstreamKey }), setView("main"))} />;
      case "endpoints":
        return <EndpointList handle={provider!} value={settings.endpoint} onBack={back} onPick={(endpoint) => (onChange({ endpoint }), setView("main"))} />;
      case "shapes":
        return (
          <Choices
            title="Shape"
            onBack={back}
            value={settings.shape}
            items={SHAPES.map((s) => ({ value: s.value, label: s.label }))}
            onPick={(shape) => (onChange({ shape: shape as Shape }), setView("main"))}
          />
        );
      case "as":
        return <AsList value={settings.as} onBack={back} onPick={(as) => (onChange({ as }), setView("main"))} />;
      default:
        return (
          <Main
            settings={settings}
            onChange={onChange}
            open={(v, q) => {
              setQuery(q ?? "");
              setView(v);
            }}
          />
        );
    }
  })();

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      {body}
    </div>
  );
}

function Main({ settings, onChange, open }: { settings: Settings; onChange: (p: Partial<Settings>) => void; open: (v: View, q?: string) => void }) {
  const provider = providerOf(settings.model);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <SdkButton
        type="button"
        data-autofocus
        aria-label={`Change the model: ${bareModel(settings.model)} ${provider ? `on ${provider}` : "(Model Pool)"}`}
        onClick={() => open("models")}
        className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        <ModelTile model={settings.model} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{bareModel(settings.model)}</span>
          <span className="block truncate text-[13px] text-fg-muted">{provider ? `on ${provider}` : "Model Pool"}</span>
        </span>
        <ChevronDown size={16} aria-hidden className="text-fg-muted" />
      </SdkButton>
      <div className="py-1">
        <Row label="Provider" value={provider ?? "Model Pool"} onClick={() => open("models", provider ? `${provider}/` : "")}>
          {provider ? (
            <>
              <ProviderTile handle={provider} size={18} /> {provider}
            </>
          ) : (
            "Model Pool"
          )}
        </Row>
        <Row label="Upstream Key" value={provider ? (settings.upstreamKey ?? "Any active key") : "Each member's keys"} disabled={!provider} onClick={() => open("keys")} />
        <Row label="Endpoint" value={provider ? (settings.endpoint ?? "Any") : "Each member's"} disabled={!provider} onClick={() => open("endpoints")} />
        <Row label="Shape" value={shapeLabel(settings.shape)} onClick={() => open("shapes")} />
        <Row label="Send as" value={settings.as ?? "Owner"} onClick={() => open("as")} />
      </div>
      <div className="border-t border-border px-4 py-3">
        <p className="mb-2 text-[13px] text-fg-muted" aria-hidden>
          Reasoning
        </p>
        <Segmented<Reasoning>
          label="Reasoning"
          value={settings.reasoning}
          onChange={(reasoning) => onChange({ reasoning })}
          items={[
            { value: "off", label: "Off" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
        />
      </div>
    </ScrollArea>
  );
}

/** A setting and its value ("Shape OpenAI Chat Completions", its name too); pressing it opens the setting's list. `children` draws the value when it is more than text. */
function Row({ label, value, children, onClick, disabled }: { label: string; value: string; children?: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <SdkButton
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${label} ${value}`}
      className="flex h-11 w-full items-center gap-3 px-4 text-left text-[14.5px] outline-none hover:bg-muted/60 focus-visible:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent data-disabled:cursor-default data-disabled:hover:bg-transparent"
    >
      <span className="flex-1">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-2 truncate text-fg-muted">{children ?? value}</span>
      {!disabled && <ChevronRight size={15} aria-hidden className="shrink-0 text-fg-muted" />}
    </SdkButton>
  );
}

function Header({ title, onBack, children }: { title?: ReactNode; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
      <IconButton icon={ArrowLeft} label="Back" size="sm" className="size-8" onClick={onBack} />
      {title && <span className="flex-1 text-[14.5px] font-medium">{title}</span>}
      {children}
    </div>
  );
}

const optionClass =
  "flex min-h-10 w-full select-none items-center gap-3 rounded-lg px-3 text-left text-[14.5px] outline-none data-highlighted:bg-selected hover:bg-muted/60 data-highlighted:hover:bg-selected";
const searchClass = "h-8 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-subtle md:text-[14.5px]";
const noteClass = "shrink-0 border-t border-border px-4 py-2 text-[12.5px] text-fg-muted";

// A short list: arrows move, Enter or a press picks.
function Choices({
  title,
  value,
  items,
  onPick,
  onBack,
  note,
  loading,
}: {
  title: string;
  value?: string;
  items: { value: string; label: ReactNode }[];
  onPick: (v: string | undefined) => void;
  onBack: () => void;
  note?: string;
  loading?: string;
}) {
  const current = value ?? ANY;
  const focus = items.some((it) => it.value === current) ? current : items[0]?.value;
  return (
    <>
      <Header title={title} onBack={onBack} />
      <ScrollArea className="min-h-0 flex-1">
        <Listbox
          aria-label={title}
          activation="manual"
          value={current}
          onValueChange={(v) => v !== null && onPick(v === ANY ? undefined : v)}
          className="p-1.5 outline-none"
        >
          {items.map((it) => (
            <ListboxItem key={it.value} value={it.value} data-autofocus={it.value === focus ? "" : undefined} className={cn(optionClass, "focus-visible:bg-selected")}>
              <span className="flex min-w-0 flex-1 items-center gap-2.5">{it.label}</span>
              <ListboxItemIndicator className="inline-flex shrink-0 text-info">
                <Check size={16} aria-hidden />
              </ListboxItemIndicator>
            </ListboxItem>
          ))}
        </Listbox>
        {loading && <LoadingRows label={loading} />}
      </ScrollArea>
      {note && <p className={noteClass}>{note}</p>}
    </>
  );
}

const SAMPLE_ROWS = ["team-1", "team-2", "team-3", "team-4"];

// While a list's options load: rows shaped like them, drawn as a skeleton
// under the list (outside it, so they never join its keyboard navigation).
function LoadingRows({ label }: { label: string }) {
  return (
    <Skeleton data={undefined} sample={SAMPLE_ROWS} label={label}>
      {(rows) => (
        <div className="-mt-1.5 px-1.5 pb-1.5">
          {rows.map((r) => (
            <div key={r} className={optionClass}>
              <span className="min-w-0 flex-1 truncate font-mono text-[13.5px]">{r}</span>
              <span className="shrink-0 text-[13px]">Active</span>
            </div>
          ))}
        </div>
      )}
    </Skeleton>
  );
}

function KeyList({ handle, value, onPick, onBack }: { handle: string; value?: string; onPick: (k?: string) => void; onBack: () => void }) {
  const keys = useKeys(handle);
  return (
    <Command filter="contains" loop={false} onAction={(v) => onPick(v === ANY ? undefined : v)} className="flex min-h-0 flex-1 flex-col">
      <Header onBack={onBack}>
        <CommandInput data-autofocus aria-label={`Search keys of ${handle}`} placeholder={`Keys of ${handle}`} className={searchClass} />
      </Header>
      <ScrollArea className="min-h-0 flex-1">
        <CommandList className="p-1.5">
          <CommandItem value={ANY} label="Any active key" className={optionClass}>
            <span className="flex-1">Any active key</span>
            {!value && <Check size={16} aria-hidden className="shrink-0 text-info" />}
          </CommandItem>
          {(keys.data ?? []).map((k) => (
            <CommandItem key={k.id} value={k.name} label={k.name} className={optionClass}>
              <span className="min-w-0 flex-1 truncate font-mono text-[13.5px]">{k.name}</span>
              <KeyStateLabel state={k.state} className="shrink-0 text-[13px]" />
              {k.name === value && <Check size={16} aria-hidden className="shrink-0 text-info" />}
            </CommandItem>
          ))}
        </CommandList>
        {keys.isPending && <LoadingRows label={`Loading the keys of ${handle}`} />}
        <CommandEmpty className="px-4 py-4 text-[14px] text-fg-muted">No key matches.</CommandEmpty>
      </ScrollArea>
      <p className={noteClass}>A picked key gets every Attempt, whatever its state.</p>
    </Command>
  );
}

function EndpointList({ handle, value, onPick, onBack }: { handle: string; value?: string; onPick: (e?: string) => void; onBack: () => void }) {
  const p = useProvider(handle);
  return (
    <Choices
      title={`Endpoints of ${handle}`}
      value={value}
      onBack={onBack}
      onPick={onPick}
      loading={p.isPending ? "Loading endpoints" : undefined}
      items={[
        { value: ANY, label: "Any" },
        ...(p.data?.endpoints ?? []).map((e) => ({
          value: e.name,
          label: (
            <>
              <span className="flex-1 truncate">{e.name}</span>
              <span className="shrink-0 text-[13px] text-fg-muted">{shapeLabel(e.shape)}</span>
            </>
          ),
        })),
      ]}
    />
  );
}

function AsList({ value, onPick, onBack }: { value?: string; onPick: (k?: string) => void; onBack: () => void }) {
  const keys = useGatewayKeys();
  return (
    <Choices
      title="Send as"
      value={value}
      onBack={onBack}
      onPick={onPick}
      loading={keys.isPending ? "Loading Gateway Keys" : undefined}
      note="Uses that key's access. Shows in Requests as Test (as name), never as its traffic."
      items={[
        {
          value: ANY,
          label: (
            <>
              <span className="flex-1">Owner</span>
              <span className="text-[13px] text-fg-muted">Everything</span>
            </>
          ),
        },
        ...(keys.data ?? []).map((k) => ({
          value: k.name,
          label: (
            <>
              <span className="flex-1 truncate">{k.name}</span>
              <span className="shrink-0 text-[13px] text-fg-muted">{k.scope.all ? "Everything" : "Only some"}</span>
            </>
          ),
        })),
      ]}
    />
  );
}

/** "1M", "256K", "131K". */
function contextText(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  return `${Math.round(n / 1000)}K`;
}

type Filter = "all" | "pools" | "recent";

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

const TYPED = "typed:";

function ModelList({ settings, initialQuery, onPick, onBack }: { settings: Settings; initialQuery: string; onPick: (m: string) => void; onBack: () => void }) {
  const [q, setQ] = useState(initialQuery);
  const [filter, setFilter] = useState<Filter>("all");
  const dq = useDebounced(q.trim(), 150);
  // The picked model's Provider (or Pool) comes first; it was set by where Test was pressed.
  const prefer = preferOf(settings.model);
  const preferred = providerOf(settings.model);
  const res = useModelChoices(dq, settings.as, prefer);
  const recent = useMemo(() => recentModels(), []);

  const data = res.data;
  const typed = q.trim();
  const groups = useMemo(() => {
    if (!data) return [];
    const out: { key: string; label: ReactNode; count: number; items: ModelChoice[] }[] = [];
    if (filter === "recent") {
      const all = new Map([...data.pools, ...data.providers.flatMap((p) => p.models)].map((m) => [m.id, m]));
      const items = recent.filter((id) => id.toLowerCase().includes(typed.toLowerCase())).map((id) => all.get(id) ?? { id, model: bareModel(id) });
      return [{ key: "recent", label: "Used recently", count: items.length, items }];
    }
    if (data.pools.length) out.push({ key: "pools", label: "Model Pools", count: data.pools.length, items: data.pools });
    if (filter === "all")
      for (const p of data.providers)
        out[p.provider === preferred ? "unshift" : "push"]({
          key: p.provider,
          label: (
            <>
              <ProviderTile handle={p.provider} size={16} /> {p.provider}
            </>
          ),
          count: p.matched,
          items: p.models,
        });
    return out;
  }, [data, filter, recent, typed, preferred]);

  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const exact = groups.some((g) => g.items.some((c) => c.id === typed));
  const offerTyped = !!typed && !/\s/.test(typed) && (typed.includes("/") ? /^[^/]+\/.+/.test(typed) : true) && !exact;
  // Results for an older search stay until the new ones land; Enter waits for them.
  const settled = dq === typed && !res.isPlaceholderData;

  const option = (c: ModelChoice, label: ReactNode) => (
    <CommandItem key={c.id} value={c.id} label={c.id} disabled={!settled} className={optionClass}>
      <span className="flex min-w-0 flex-1 items-center gap-2.5">{label}</span>
      <span className="ml-auto shrink-0 pl-2 text-[13px] text-fg-muted tabular">{contextText(c.context_length)}</span>
      {c.id === settings.model && <Check size={16} aria-hidden className="shrink-0 text-info" />}
    </CommandItem>
  );

  return (
    <Command
      filter={false}
      loop={false}
      query={q}
      onQueryChange={setQ}
      status={res.isError ? "error" : res.isFetching ? "loading" : "idle"}
      onAction={(v) => onPick(v.startsWith(TYPED) ? v.slice(TYPED.length) : v)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <Header onBack={onBack}>
        <CommandInput data-autofocus placeholder="Search models, or type an ID" aria-label="Search models" className={cn(searchClass, "md:text-[15px]")} />
        {data && (
          <span className="shrink-0 pr-2 text-[13px] text-fg-muted tabular">
            {formatNumber(data.matched)} of {formatNumber(data.total)}
          </span>
        )}
      </Header>
      <div className="shrink-0 px-3 pt-3">
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All" },
            { value: "pools", label: "Model Pools" },
            { value: "recent", label: "Used recently" },
          ]}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <CommandList className="px-1.5 pb-2 pt-1">
          {offerTyped && (
            <CommandItem value={TYPED + typed} label={typed} className={optionClass}>
              <span className="min-w-0 flex-1 truncate">Use “{typed}”</span>
              <CornerDownLeft size={14} aria-hidden className="shrink-0 text-fg-muted" />
            </CommandItem>
          )}
          {groups.map((g) => (
            <CommandGroup key={g.key} className="mt-2">
              <CommandGroupLabel className="flex items-center gap-2 px-3 py-1.5 text-[13px] font-medium text-fg-muted">
                {g.label} <span className="font-normal tabular">{formatNumber(g.count)}</span>
              </CommandGroupLabel>
              {g.items.map((c) =>
                option(
                  c,
                  g.key === "pools" ? (
                    <>
                      <PoolTile name={c.id} size={20} />
                      <span className="truncate">{c.model}</span>
                    </>
                  ) : g.key === "recent" ? (
                    <>
                      <ModelTile model={c.id} />
                      <span className="truncate">{c.id}</span>
                    </>
                  ) : (
                    <span className="truncate">{c.model}</span>
                  ),
                ),
              )}
            </CommandGroup>
          ))}
        </CommandList>
        {data && shown === 0 && !offerTyped && (
          <p className="px-3 py-6 text-center text-[14px] text-fg-muted">{settings.as ? `Nothing ${settings.as} may use matches.` : "No model matches."}</p>
        )}
        {data?.truncated && filter !== "recent" && <p className="px-3 py-2 text-[13px] text-fg-muted">Showing the first {formatNumber(shown)}. Type more to narrow it down.</p>}
        {res.isError && <p className="px-3 py-4 text-[14px] text-danger-text">Couldn't load the models. {res.error instanceof Error ? res.error.message : ""}</p>}
      </ScrollArea>
      <div className="hidden shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-[12.5px] text-fg-muted md:flex">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd> to pick
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> back
        </span>
      </div>
    </Command>
  );
}
