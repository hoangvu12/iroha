import type { ReactNode } from "react";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";

export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
  label: string;
}) {
  return (
    <SegmentedControl
      aria-label={label}
      value={value}
      onValueChange={(v) => v !== null && onChange(v as T)}
      className="relative isolate inline-flex h-9 shrink-0 rounded-lg bg-muted p-1"
    >
      <SegmentedControlIndicator
        className={
          "absolute left-0 top-0 -z-10 translate-x-(--segmented-control-indicator-left) translate-y-(--segmented-control-indicator-top) " +
          "h-(--segmented-control-indicator-height) w-(--segmented-control-indicator-width) rounded-md bg-bg shadow-sm " +
          "transition-[translate,width] duration-indicator ease-out data-[activation-direction=none]:transition-none"
        }
      />
      {items.map((it) => (
        <SegmentedControlItem
          key={it.value}
          value={it.value}
          className="flex items-center whitespace-nowrap rounded-md px-3 text-[14px] text-fg-muted transition-colors duration-hover ease-[ease] hover:text-fg data-checked:font-medium data-checked:text-fg"
        >
          {it.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
