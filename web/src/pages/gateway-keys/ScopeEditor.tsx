import type { Dispatch, SetStateAction } from "react";
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/ui/cn";
import { SearchInput } from "@/ui/Input";
import { usePoolOptions, useProviderOptions } from "./api";
import { Checkbox, RadioOption } from "./bits";
import { PoolTile, ProviderTile } from "@/ui/LogoTile";
import { ModelPicker } from "./ModelPicker";
import { type Draft, modelsLabel } from "./scope";

// Access, as in C02: Everything, or Only some, a checklist of Providers
// (each narrowable to models) and Model Pools. Used by the create dialog and
// by Edit access on the key page.

type SetDraft = Dispatch<SetStateAction<Draft>>;

export function ScopeEditor({ draft, onChange }: { draft: Draft; onChange: SetDraft }) {
  return (
    <div>
      <p className="text-sm font-medium text-fg">Access</p>
      <div role="radiogroup" aria-label="Access" className="mt-2 flex flex-col gap-1.5">
        <RadioOption
          checked={draft.all}
          onSelect={() => onChange((d) => ({ ...d, all: true }))}
          title="Everything"
          description="Every Provider and Model Pool, including ones you add later"
        />
        <RadioOption
          checked={!draft.all}
          onSelect={() => onChange((d) => ({ ...d, all: false }))}
          title="Only some"
          description="Pick the Providers and Model Pools this key can use"
        />
      </div>
      {!draft.all && <Checklist draft={draft} onChange={onChange} />}
    </div>
  );
}

function Checklist({ draft, onChange }: { draft: Draft; onChange: SetDraft }) {
  const providers = useProviderOptions();
  const pools = usePoolOptions();
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState<string>();

  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);

  // Handles the scope names that no longer exist (a deleted Provider) stay
  // listed so saving never drops them silently.
  const handles = useMemo(() => {
    const known = new Set((providers.data ?? []).map((p) => p.handle));
    const gone = [...draft.providers.keys()].filter((h) => !known.has(h));
    return [...(providers.data ?? []).map((p) => ({ handle: p.handle, enabled: p.enabled, gone: false })), ...gone.map((h) => ({ handle: h, enabled: false, gone: true }))];
  }, [providers.data, draft.providers]);
  const poolNames = useMemo(() => {
    const known = (pools.data ?? []).map((p) => p.name);
    return [...known, ...[...draft.pools].filter((n) => !known.includes(n))];
  }, [pools.data, draft.pools]);

  const shownProviders = handles.filter((p) => match(p.handle));
  const shownPools = poolNames.filter(match);

  const toggleProvider = (h: string) =>
    onChange((d) => {
      const next = new Map(d.providers);
      if (next.has(h)) next.delete(h);
      else next.set(h, null);
      return { ...d, providers: next };
    });
  const setModels = (h: string, models: string[] | null) =>
    onChange((d) => {
      const next = new Map(d.providers);
      next.set(h, models);
      return { ...d, providers: next };
    });
  const togglePool = (n: string) =>
    onChange((d) => {
      const next = new Set(d.pools);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return { ...d, pools: next };
    });

  const loading = providers.isPending || pools.isPending;
  const failed = providers.isError || pools.isError;

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-border">
      <div className="border-b border-border p-2">
        <SearchInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search Providers and Pools"
          aria-label="Search Providers and Pools"
          className="[&_input]:border-transparent [&_input]:bg-transparent [&_input]:focus:ring-0"
        />
      </div>
      <div className="max-h-[min(380px,45dvh)] overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-4 p-4" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-2.5 w-32 rounded-full bg-muted" />
            ))}
          </div>
        ) : failed ? (
          <p className="p-4 text-sm text-danger-text">Couldn't load the Providers and Pools. Close this and try again.</p>
        ) : shownProviders.length === 0 && shownPools.length === 0 ? (
          <p className="p-4 text-sm text-fg-muted">{needle ? `Nothing matches “${q.trim()}”.` : "There are no Providers or Model Pools yet."}</p>
        ) : null}
        {!loading && !failed && (
          <>
            {shownProviders.map((p) => {
              const on = draft.providers.has(p.handle);
              const models = draft.providers.get(p.handle) ?? null;
              return (
                <div key={p.handle} className="flex h-12 items-center gap-3 px-4 hover:bg-subtle">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleProvider(p.handle)}
                    className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left"
                  >
                    <Checkbox checked={on} />
                    <ProviderTile handle={p.handle} />
                    <span className={cn("truncate text-[15px]", p.gone ? "text-fg-muted line-through" : "text-fg")}>{p.handle}</span>
                    {!p.enabled && !p.gone && <span className="shrink-0 text-[13px] text-fg-muted">Disabled</span>}
                  </button>
                  {on && !p.gone && (
                    <button
                      type="button"
                      onClick={() => setPicking(p.handle)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm text-fg-muted hover:bg-muted hover:text-fg"
                    >
                      {modelsLabel(models)}
                      <ChevronDown size={15} />
                    </button>
                  )}
                </div>
              );
            })}
            {shownPools.length > 0 && (
              <div className={cn(shownProviders.length > 0 && "border-t border-border")}>
                <p className="px-4 pb-1 pt-3 text-[13px] text-fg-muted">Model Pools</p>
                {shownPools.map((n) => {
                  const on = draft.pools.has(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => togglePool(n)}
                      className="flex h-12 w-full items-center gap-3 px-4 text-left hover:bg-subtle"
                    >
                      <Checkbox checked={on} />
                      <PoolTile name={n} />
                      <span className="truncate text-[15px] text-fg">{n}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      <ModelPicker
        provider={picking}
        value={picking ? (draft.providers.get(picking) ?? null) : null}
        onChange={(m) => picking && setModels(picking, m)}
        onClose={() => setPicking(undefined)}
      />
    </div>
  );
}
