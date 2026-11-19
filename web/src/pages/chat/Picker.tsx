import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, CornerDownLeft } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { useGatewayKeys, useKeys, useProvider } from "@/pages/providers/api";
import { KeyStateLabel, Segmented, Switch } from "@/pages/providers/controls";
import { SAMPLE_KEYS } from "@/pages/providers/samples";
import { Kbd } from "@/ui/bits";
import { cn } from "@/ui/cn";
import { PoolTile, ProviderTile } from "@/ui/LogoTile";
import { Skeleton } from "@/ui/Skeleton";
import type { ModelChoice, Reasoning, Settings, Shape } from "./api";
import { bareModel, providerOf, SHAPES, shapeLabel, useModelChoices } from "./api";
import { recentModels } from "./store";

// The composer's model button (C16, C27): the model, then Provider,
// Upstream Key, Endpoint, Shape, Send as, Reasoning and the tool-call check.
// Each row opens its own list in the same popover; the model list searches
// on the server (GET /api/test/models), Pools first, and takes typed IDs.

export type View = "main" | "models" | "keys" | "endpoints" | "shapes" | "as";

const SAMPLE_KEY_OPTIONS = SAMPLE_KEYS.slice(0, 5);

/** A model's logo: square for a Pool, round for a Provider's model. */
export function ModelTile({ model, size = 20 }: { model: string; size?: number }) {
  const p = providerOf(model);
  return p ? <ProviderTile handle={p} size={size} /> : <PoolTile name={model} size={size} />;
}

export function Picker({
  settings,
  onChange,
  onClose,
  initial = "main",
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  initial?: View;
}) {
  const [view, setView] = useState<View>(settings.model ? initial : "models");
  const [query, setQuery] = useState("");
  const back = () => (settings.model ? setView("main") : onClose());
  const provider = providerOf(settings.model);

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
    <div
      role="dialog"
      aria-label="Model and settings"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (view === "main") onClose();
          else back();
        }
      }}
      className="flex max-h-[min(640px,calc(100dvh-160px))] flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-elevated"
    >
      {body}
    </div>
  );
}

function Main({ settings, onChange, open }: { settings: Settings; onChange: (p: Partial<Settings>) => void; open: (v: View, q?: string) => void }) {
  const provider = providerOf(settings.model);
  return (
    <div className="overflow-y-auto">
      <button type="button" onClick={() => open("models")} className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left hover:bg-muted/60">
        <ModelTile model={settings.model} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{bareModel(settings.model)}</span>
          <span className="block truncate text-[13px] text-fg-muted">{provider ? `on ${provider}` : "Model Pool"}</span>
        </span>
        <ChevronDown size={16} className="text-fg-muted" />
      </button>
      <div className="py-1">
        <Row label="Provider" onClick={() => open("models", provider ? `${provider}/` : "")}>
          {provider ? (
            <>
              <ProviderTile handle={provider} size={18} /> {provider}
            </>
          ) : (
            "Model Pool"
          )}
        </Row>
        <Row label="Upstream Key" disabled={!provider} onClick={() => open("keys")}>
          {provider ? (settings.upstreamKey ?? "Any active key") : "Each member's keys"}
        </Row>
        <Row label="Endpoint" disabled={!provider} onClick={() => open("endpoints")}>
          {provider ? (settings.endpoint ?? "Any") : "Each member's"}
        </Row>
        <Row label="Shape" onClick={() => open("shapes")}>
          {shapeLabel(settings.shape)}
        </Row>
        <Row label="Send as" onClick={() => open("as")}>
          {settings.as ?? "Owner"}
        </Row>
      </div>
      <div className="border-t border-border px-4 py-3">
        <p className="mb-2 text-[13px] text-fg-muted">Reasoning</p>
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
      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-medium">Check tool calls</span>
          <span className="block text-[13px] text-fg-muted">Offer a test tool and check the call</span>
        </span>
        <Switch label="Check tool calls" checked={settings.toolCheck} onChange={(toolCheck) => onChange({ toolCheck })} />
      </div>
    </div>
  );
}

function Row({ label, children, onClick, disabled }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-11 w-full items-center gap-3 px-4 text-left text-[14.5px] hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="flex-1">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-2 truncate text-fg-muted">{children}</span>
      {!disabled && <ChevronRight size={15} className="shrink-0 text-fg-muted" />}
    </button>
  );
}

function Header({ title, onBack, children }: { title?: ReactNode; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-2">
      <button type="button" onClick={onBack} aria-label="Back" className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-muted hover:text-fg">
        <ArrowLeft size={17} />
      </button>
      {title && <span className="flex-1 text-[14.5px] font-medium">{title}</span>}
      {children}
    </div>
  );
}

function Option({ active, selected, onClick, children, id }: { active?: boolean; selected?: boolean; onClick: () => void; children: ReactNode; id?: string }) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn("flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[14.5px]", active ? "bg-selected" : "hover:bg-muted/60")}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">{children}</span>
      {selected && <Check size={16} className="shrink-0 text-info" />}
    </button>
  );
}

function Choices({ title, value, items, onPick, onBack }: { title: string; value?: string; items: { value: string; label: ReactNode }[]; onPick: (v: string) => void; onBack: () => void }) {
  return (
    <>
      <Header title={title} onBack={onBack} />
      <div role="listbox" className="overflow-y-auto p-1.5">
        {items.map((it) => (
          <Option key={it.value} selected={it.value === value} onClick={() => onPick(it.value)}>
            {it.label}
          </Option>
        ))}
      </div>
    </>
  );
}

function KeyList({ handle, value, onPick, onBack }: { handle: string; value?: string; onPick: (k?: string) => void; onBack: () => void }) {
  const keys = useKeys(handle);
  const [q, setQ] = useState("");
  const shown = (keys.data ?? []).filter((k) => k.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <Header onBack={onBack}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Keys of ${handle}`} className="h-8 flex-1 bg-transparent text-base outline-none placeholder:text-fg-subtle md:text-[14.5px]" />
      </Header>
      <div role="listbox" className="overflow-y-auto p-1.5">
        {!q && (
          <Option selected={!value} onClick={() => onPick(undefined)}>
            Any active key
          </Option>
        )}
        <Skeleton data={keys.data && shown} sample={SAMPLE_KEY_OPTIONS} label={`Loading the keys of ${handle}`}>
          {(shown) =>
            shown.map((k) => (
              <Option key={k.id} selected={k.name === value} onClick={() => onPick(k.name)}>
                <span className="min-w-0 flex-1 truncate font-mono text-[13.5px]">{k.name}</span>
                <KeyStateLabel state={k.state} className="shrink-0 text-[13px]" />
              </Option>
            ))
          }
        </Skeleton>
      </div>
      <p className="border-t border-border px-4 py-2 text-[12.5px] text-fg-muted">A picked key gets every Attempt, whatever its state.</p>
    </>
  );
}

function EndpointList({ handle, value, onPick, onBack }: { handle: string; value?: string; onPick: (e?: string) => void; onBack: () => void }) {
  const p = useProvider(handle);
  return (
    <>
      <Header title={`Endpoints of ${handle}`} onBack={onBack} />
      <div role="listbox" className="overflow-y-auto p-1.5">
        <Option selected={!value} onClick={() => onPick(undefined)}>
          Any
        </Option>
        {(p.data?.endpoints ?? []).map((e) => (
          <Option key={e.id} selected={e.name === value} onClick={() => onPick(e.name)}>
            <span className="flex-1 truncate">{e.name}</span>
            <span className="shrink-0 text-[13px] text-fg-muted">{shapeLabel(e.shape)}</span>
          </Option>
        ))}
      </div>
    </>
  );
}

function AsList({ value, onPick, onBack }: { value?: string; onPick: (k?: string) => void; onBack: () => void }) {
  const keys = useGatewayKeys();
  return (
    <>
      <Header title="Send as" onBack={onBack} />
      <div role="listbox" className="overflow-y-auto p-1.5">
        <Option selected={!value} onClick={() => onPick(undefined)}>
          <span className="flex-1">Owner</span>
          <span className="text-[13px] text-fg-muted">Everything</span>
        </Option>
        {(keys.data ?? []).map((k) => (
          <Option key={k.id} selected={k.name === value} onClick={() => onPick(k.name)}>
            <span className="flex-1 truncate">{k.name}</span>
            <span className="shrink-0 text-[13px] text-fg-muted">{k.scope.all ? "Everything" : "Only some"}</span>
          </Option>
        ))}
      </div>
      <p className="border-t border-border px-4 py-2 text-[12.5px] text-fg-muted">Uses that key's access. Shows in Requests as Test (as name), never as its traffic.</p>
    </>
  );
}

/** "1M", "256K", "131K". */
function contextText(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  return `${Math.round(n / 1000)}K`;
}

type Filter = "all" | "pools" | "recent";
type Flat = { id: string; choice?: ModelChoice; typed?: boolean };

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function ModelList({ settings, initialQuery, onPick, onBack }: { settings: Settings; initialQuery: string; onPick: (m: string) => void; onBack: () => void }) {
  const [q, setQ] = useState(initialQuery);
  const [filter, setFilter] = useState<Filter>("all");
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 150);
  const res = useModelChoices(dq, settings.as);
  const listRef = useRef<HTMLDivElement>(null);
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
        out.push({
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
  }, [data, filter, recent, typed]);

  const flat: Flat[] = useMemo(() => {
    const items: Flat[] = groups.flatMap((g) => g.items.map((c) => ({ id: c.id, choice: c })));
    const exact = items.some((i) => i.id === typed);
    const valid = typed && !/\s/.test(typed) && (typed.includes("/") ? /^[^/]+\/.+/.test(typed) : true);
    return valid && !exact ? [{ id: typed, typed: true }, ...items] : items;
  }, [groups, typed]);

  useEffect(() => setActive(0), [dq, filter]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let index = -1;
  const row = (f: Flat, tail: ReactNode, label: ReactNode) => {
    index++;
    const i = index;
    return (
      <div key={(f.typed ? "typed:" : "") + f.id} data-index={i}>
        <Option active={i === active} selected={!f.typed && f.id === settings.model} onClick={() => onPick(f.id)}>
          {label}
          <span className="ml-auto shrink-0 pl-2 text-[13px] text-fg-muted tabular">{tail}</span>
        </Option>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header onBack={onBack}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, flat.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            else if (e.key === "Enter" && flat[active]) (e.preventDefault(), onPick(flat[active].id));
          }}
          placeholder="Search models, or type an ID"
          aria-label="Search models"
          className="h-8 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-subtle md:text-[15px]"
        />
        {data && (
          <span className="shrink-0 pr-2 text-[13px] text-fg-muted tabular">
            {formatNumber(data.matched)} of {formatNumber(data.total)}
          </span>
        )}
      </Header>
      <div className="flex gap-2 px-3 pt-3">
        {(
          [
            ["all", "All"],
            ["pools", "Model Pools"],
            ["recent", "Used recently"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={filter === v}
            onClick={() => setFilter(v)}
            className={cn(
              "h-8 rounded-full border px-3 text-[13.5px] transition-colors",
              filter === v ? "border-primary bg-primary text-primary-fg" : "border-border-strong text-fg hover:bg-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div ref={listRef} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-1">
        {flat[0]?.typed && row(flat[0], <CornerDownLeft size={14} />, <span className="truncate">Use “{flat[0].id}”</span>)}
        {groups.map((g) => (
          <section key={g.key} className="mt-2">
            <h4 className="flex items-center gap-2 px-3 py-1.5 text-[13px] font-medium text-fg-muted">
              {g.label} <span className="font-normal tabular">{formatNumber(g.count)}</span>
            </h4>
            {g.items.map((c) =>
              row(
                { id: c.id, choice: c },
                contextText(c.context_length),
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
          </section>
        ))}
        {data && flat.length === 0 && <p className="px-3 py-6 text-center text-[14px] text-fg-muted">{settings.as ? `Nothing ${settings.as} may use matches.` : "No model matches."}</p>}
        {data?.truncated && filter !== "recent" && <p className="px-3 py-2 text-[13px] text-fg-muted">Showing the first {formatNumber(flat.length)}. Type more to narrow it down.</p>}
        {res.isError && <p className="px-3 py-4 text-[14px] text-danger-text">Couldn't load the models. {res.error instanceof Error ? res.error.message : ""}</p>}
      </div>
      <div className="hidden items-center gap-4 border-t border-border px-4 py-2 text-[12.5px] text-fg-muted md:flex">
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
    </div>
  );
}
