import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Dialog } from "@/ui/Dialog";
import { SearchInput } from "@/ui/Input";
import { useProviderModels } from "./api";
import { Checkbox, RadioOption } from "./bits";
import { ProviderTile } from "./logos";

// The model picker behind a checked Provider's "All models" (C02): every
// model, or only some. Search runs on the server and the list draws only
// the rows in view, so a Provider with thousands of models stays instant.

const ROW = 36;
const VIEW = 300;
const OVERSCAN = 8;
const CHIPS = 40;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ModelPicker({
  provider,
  value,
  onChange,
  onClose,
}: {
  provider: string | undefined;
  value: string[] | null;
  onChange: (models: string[] | null) => void;
  onClose: () => void;
}) {
  const [only, setOnly] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 200);

  // Reset to the Provider's current choice each time the picker opens.
  useEffect(() => {
    if (!provider) return;
    setOnly(!!value);
    setPicked(value ?? []);
    setText("");
  }, [provider]);

  const done = () => {
    onChange(only && picked.length > 0 ? picked : null);
    onClose();
  };

  return (
    <Dialog
      open={!!provider}
      onOpenChange={(o) => !o && onClose()}
      width={520}
      title={
        <span className="flex items-center gap-2.5">
          {provider && <ProviderTile handle={provider} size={26} />}
          Models of {provider}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={done} disabled={only && picked.length === 0}>
            {only ? (picked.length ? `Allow ${picked.length === 1 ? "1 model" : `${formatNumber(picked.length)} models`}` : "Pick a model") : "Allow all models"}
          </Button>
        </>
      }
    >
      <div role="radiogroup" className="flex flex-col gap-1">
        <RadioOption
          checked={!only}
          onSelect={() => setOnly(false)}
          title="All models"
          description={`Every model of ${provider}, including ones it adds later`}
        />
        <RadioOption checked={only} onSelect={() => setOnly(true)} title="Only these" description="The models you tick below, exactly as Callers name them" />
      </div>
      {only && (
        <div className="mt-4">
          {picked.length > 0 && (
            <div className="mb-3 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
              {picked.slice(0, CHIPS).map((m) => (
                <span key={m} className="inline-flex h-7 max-w-full items-center gap-1 rounded-md bg-muted pl-2 pr-1 font-mono text-[12.5px] text-fg">
                  <span className="truncate">{m}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${m}`}
                    onClick={() => setPicked((p) => p.filter((x) => x !== m))}
                    className="rounded p-0.5 text-fg-muted hover:text-fg"
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
              {picked.length > CHIPS && (
                <span className="inline-flex h-7 items-center px-1 text-[13px] text-fg-muted">and {formatNumber(picked.length - CHIPS)} more</span>
              )}
            </div>
          )}
          <ModelList provider={provider!} q={q} typed={text.trim()} picked={picked} setPicked={setPicked} search={text} onSearch={setText} />
        </div>
      )}
    </Dialog>
  );
}

function ModelList({
  provider,
  q,
  typed,
  picked,
  setPicked,
  search,
  onSearch,
}: {
  provider: string;
  q: string;
  typed: string;
  picked: string[];
  setPicked: (f: (p: string[]) => string[]) => void;
  search: string;
  onSearch: (s: string) => void;
}) {
  const models = useProviderModels(provider, q);
  const rows = useMemo(() => models.data?.pages.flatMap((p) => p.models.map((m) => m.model)) ?? [], [models.data]);
  const total = models.data?.pages[0]?.total ?? 0;
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  // A typed ID the list does not have can still be allowed (a model the
  // Provider serves but does not list): offered after the last match.
  const settled = q === typed && !models.isPlaceholderData && !models.isPending && !models.hasNextPage;
  const extra = typed && settled && !rows.includes(typed) ? typed : undefined;
  const items = extra ? [...rows, extra] : rows;

  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  useEffect(() => {
    box.current?.scrollTo({ top: 0 });
    setTop(0);
  }, [q]);

  const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((top + VIEW) / ROW) + OVERSCAN);

  // Read the next page when the view nears the end of what is loaded.
  useEffect(() => {
    if (last >= items.length - 20 && models.hasNextPage && !models.isFetchingNextPage) void models.fetchNextPage();
  }, [last, items.length, models]);

  const toggle = (m: string) => setPicked((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m]));

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="border-b border-border p-2">
        <SearchInput
          autoFocus
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={total > 0 && !q ? `Search ${formatNumber(total)} models` : "Search models"}
          aria-label="Search models"
          className="[&_input]:border-transparent [&_input]:bg-transparent [&_input]:focus:ring-0"
        />
      </div>
      {models.isPending ? (
        <div className="flex flex-col gap-3 p-4" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-2.5 w-40 rounded-full bg-muted" />
          ))}
        </div>
      ) : models.isError ? (
        <p className="p-4 text-sm text-danger-text">Couldn't load the models of {provider}. Type a model ID to allow it anyway.</p>
      ) : items.length === 0 ? (
        <p className="p-4 text-sm text-fg-muted">
          {q ? `No model of ${provider} matches “${q}”.` : `${provider} lists no models yet. Type a model ID to allow it.`}
        </p>
      ) : null}
      {items.length > 0 && (
        <div
          ref={box}
          role="listbox"
          aria-multiselectable="true"
          aria-label={`Models of ${provider}`}
          onScroll={(e) => setTop(e.currentTarget.scrollTop)}
          className={cn("relative overflow-y-auto", models.isPlaceholderData && "opacity-60")}
          style={{ height: Math.min(VIEW, items.length * ROW) }}
        >
          <div style={{ height: items.length * ROW }} className="relative">
            {items.slice(first, last).map((m, i) => {
              const at = first + i;
              const isExtra = extra !== undefined && at === items.length - 1;
              const on = pickedSet.has(m);
              return (
                <button
                  key={isExtra ? `extra:${m}` : m}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(m)}
                  style={{ top: at * ROW, height: ROW }}
                  className="absolute inset-x-0 flex items-center gap-3 px-3 text-left hover:bg-subtle"
                >
                  {isExtra && !on ? <Plus size={16} className="shrink-0 text-fg-muted" /> : <Checkbox checked={on} />}
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{m}</span>
                  {isExtra && <span className="shrink-0 text-[12px] text-fg-muted">Not in the list</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
