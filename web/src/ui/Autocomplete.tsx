import {
  Autocomplete as SdkAutocomplete,
  AutocompleteContent,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "@ui-sdk/react/autocomplete";
import { cn } from "./cn";
import { popupClass } from "./popup";
import { ScrollArea } from "./ScrollArea";

const SHOWN = 200;

export function Autocomplete({
  value,
  onValueChange,
  items,
  mono,
  placeholder,
}: {
  value: string;
  onValueChange: (v: string) => void;
  items: string[];
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <SdkAutocomplete value={value} onValueChange={(v) => onValueChange(v)} items={items} filter="contains">
      <AutocompleteInput
        spellCheck={false}
        placeholder={placeholder}
        className={cn(
          "h-9 w-full rounded-lg border border-border-strong bg-bg px-3 text-base text-fg outline-none placeholder:text-fg-subtle md:text-sm",
          "transition-[border-color,box-shadow] focus:border-info focus:ring-2 focus:ring-info/20 disabled:opacity-60 aria-[invalid=true]:border-danger-text",
          mono && "font-mono text-[13px] md:text-[13px]",
        )}
      />
      <AutocompleteContent sideOffset={4} collisionPadding={8} className={cn(popupClass, "min-w-(--anchor-width) p-0")}>
        <ScrollArea viewportClassName="max-h-[min(300px,calc(var(--available-height)-2px))]" contentClassName="p-1">
          <AutocompleteList>
            {(state) =>
              state.items.slice(0, SHOWN).map((it) => {
                const v = typeof it === "string" ? it : "value" in it ? String(it.value) : "";
                return (
                  <AutocompleteItem
                    key={v}
                    value={v}
                    className={cn("flex h-8 select-none items-center rounded-md px-2 text-fg outline-none data-highlighted:bg-muted", mono && "font-mono text-[13px]")}
                  >
                    <span className="truncate">{v}</span>
                  </AutocompleteItem>
                );
              })
            }
          </AutocompleteList>
        </ScrollArea>
      </AutocompleteContent>
    </SdkAutocomplete>
  );
}
