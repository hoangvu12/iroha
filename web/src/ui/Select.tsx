import { Check, ChevronDown } from "lucide-react";
import { Select as SdkSelect, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { cn } from "./cn";
import { popupClass } from "./popup";
import { ScrollArea } from "./ScrollArea";

export type SelectOption<T extends string = string> = { value: T; label: string; disabled?: boolean };

// A short list of choices behind a button. Inside a Field it takes the
// Field's label; elsewhere pass aria-label.
export function Select<T extends string>({
  value,
  onValueChange,
  items,
  className,
  disabled,
  placeholder,
  "aria-label": label,
}: {
  value: T;
  onValueChange: (v: T) => void;
  items: SelectOption<T>[];
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}) {
  return (
    <SdkSelect<T>
      items={items}
      value={value}
      onValueChange={(v) => v !== null && onValueChange(v as T)}
      disabled={disabled}
      placeholder={placeholder}
    >
      <SelectTrigger
        aria-label={label}
        className={cn(
          "inline-flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border-strong bg-bg pl-3 pr-2.5 text-left text-base text-fg outline-none md:text-sm",
          "transition-[border-color,box-shadow] focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/20 focus-visible:outline-none",
          "data-open:border-info data-placeholder:text-fg-subtle data-disabled:opacity-60",
          className,
        )}
      >
        <SelectValue className="min-w-0 flex-1 truncate" />
        <ChevronDown size={15} aria-hidden className="shrink-0 text-fg-muted" />
      </SelectTrigger>
      <SelectContent
        sideOffset={4}
        collisionPadding={8}
        className={cn(popupClass, "min-w-(--anchor-width) p-0")}
      >
        <ScrollArea viewportClassName="max-h-[min(360px,calc(var(--available-height)-2px))]" contentClassName="p-1">
        {items.map((it) => (
          <SelectItem
            key={it.value}
            value={it.value}
            disabled={it.disabled}
            className="flex h-8 select-none items-center gap-2 rounded-md px-2 text-fg outline-none data-highlighted:bg-muted data-disabled:opacity-50"
          >
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            <SelectItemIndicator className="inline-flex text-fg">
              <Check size={15} aria-hidden />
            </SelectItemIndicator>
          </SelectItem>
        ))}
        </ScrollArea>
      </SelectContent>
    </SdkSelect>
  );
}
