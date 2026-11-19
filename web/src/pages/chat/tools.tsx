import type { ComponentType } from "react";
import { Calculator, Clock, CloudSun, Globe, Link2, Package, Wrench } from "lucide-react";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { popupMotionClass } from "@/ui/popup";
import { ScrollArea } from "@/ui/ScrollArea";
import { Skeleton } from "@/ui/Skeleton";
import { Switch } from "@/ui/Switch";
import type { Settings, TestTool } from "./api";
import { useTestTools, WEATHER_TOOL } from "./api";

// The composer's test tools (UI ticket 29): a wrench with the number of tools
// on, opening a popover with All on / All off and a Switch per tool. The list
// is Iroha's (GET /api/test/tools); Iroha answers each call and checks it.

type Icon = ComponentType<{ size?: number; className?: string }>;

const ICONS: Record<string, Icon> = {
  get_weather: CloudSun,
  get_time: Clock,
  calculate: Calculator,
  web_search: Globe,
  fetch_url: Link2,
  lookup_order: Package,
};

/** A test tool's icon; a wrench for a name this UI doesn't know. */
export function toolIcon(name: string): Icon {
  return ICONS[name] ?? Wrench;
}

// What "Call a tool" asks, per tool: the first tool on that has one.
const PROMPTS: [string, string][] = [
  [WEATHER_TOOL, "What's the weather in Hanoi right now? Use the tool."],
  ["calculate", "Use the calculate tool: what is (12.5 * 4) / 3 + 2^10?"],
  ["get_time", "What time is it in Tokyo right now? Use the tool."],
  ["lookup_order", "Where is my order ORD-10482? Use the tool."],
  ["web_search", "Search the web for SQLite WAL mode and sum up the top result."],
  ["fetch_url", "Fetch https://example.com/docs/getting-started and tell me what it covers."],
];

/** The "Call a tool" starter: turns every tool on when none is, and asks for one that is on. */
export function callAToolChip(on: string[], all: string[]): { prompt: string; patch?: Partial<Settings> } {
  const patch = on.length ? undefined : { tools: all.length ? all : [WEATHER_TOOL] };
  const active = patch?.tools ?? on;
  const prompt = PROMPTS.find(([name]) => active.includes(name))?.[1] ?? `Call the ${active[0]} tool.`;
  return { prompt, patch };
}

/** The wrench button and its popover. `tools` is what is on; `onChange` gets the new list, in Iroha's order. */
export function ToolsButton({ tools, onChange }: { tools: string[]; onChange: (tools: string[]) => void }) {
  const n = tools.length;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={n ? `Tools, ${n} on` : "Tools, off"}
        className={cn(
          "press inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-[13px] font-semibold tabular",
          n ? "border-info/40 bg-info/10 text-info" : "border-border text-fg hover:bg-muted data-open:bg-muted",
        )}
      >
        <Wrench size={15} aria-hidden />
        {n > 0 && <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-info px-1 text-[11.5px] leading-none text-bg">{n}</span>}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className={cn(
          "flex w-[min(400px,calc(100vw-16px))] max-h-[min(560px,calc(100dvh-160px),var(--available-height))] flex-col overflow-hidden rounded-xl border border-border bg-elevated text-fg shadow-elevated outline-none",
          // The shared popup recipe: grows from the button, leaves faster; fades only under reduced motion.
          popupMotionClass,
        )}
      >
        <ToolList on={tools} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

const SAMPLE_TOOLS: TestTool[] = [
  { name: "get_weather", description: "Get the current weather in a city.", parameters: {} },
  { name: "get_time", description: "Get the current date and time in a time zone.", parameters: {} },
  { name: "calculate", description: "Evaluate an arithmetic expression exactly.", parameters: {} },
  { name: "web_search", description: "Search the web and return the top results.", parameters: {} },
];

function ToolList({ on, onChange }: { on: string[]; onChange: (tools: string[]) => void }) {
  const list = useTestTools();
  const all = list.data?.map((t) => t.name) ?? [];
  // Kept in Iroha's order, whatever order they were switched on in.
  const set = (name: string, value: boolean) => onChange(all.filter((n) => (n === name ? value : on.includes(n))));
  const allOn = all.length > 0 && all.every((n) => on.includes(n));
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border py-2 pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <PopoverTitle className="text-[14.5px] font-semibold">Test tools</PopoverTitle>
          <PopoverDescription className="text-[12.5px] leading-snug text-fg-muted">Iroha answers each call and checks it.</PopoverDescription>
        </div>
        <Button variant="ghost" size="sm" disabled={!list.data || allOn} onClick={() => onChange(all)}>
          All on
        </Button>
        <Button variant="ghost" size="sm" disabled={on.length === 0} onClick={() => onChange([])}>
          All off
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {list.isError ? (
          <p className="px-4 py-4 text-[14px] text-danger-text">Couldn't load the tools. {list.error instanceof Error ? list.error.message : ""}</p>
        ) : (
          <Skeleton data={list.data} sample={SAMPLE_TOOLS} id="chat-tools" label="Loading the tools">
            {(tools) => (
              <ul className="py-1">
                {tools.map((t) => {
                  const Icon = toolIcon(t.name);
                  return (
                    <li key={t.name} className="flex items-center gap-3 px-4 py-2.5">
                      <Icon size={17} className="shrink-0 self-start text-fg-muted mt-0.5" />
                      <span className="min-w-0 flex-1" aria-hidden>
                        <span className="block truncate font-mono text-[13.5px] font-medium">{t.name}</span>
                        <span className="block text-[13px] leading-snug text-fg-muted">{t.description}</span>
                      </span>
                      <Switch label={t.name} checked={on.includes(t.name)} onChange={(v) => set(t.name, v)} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Skeleton>
        )}
      </ScrollArea>
    </>
  );
}
