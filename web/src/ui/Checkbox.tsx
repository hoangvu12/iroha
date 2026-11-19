import { Check, Minus } from "lucide-react";
import { Checkbox as SdkCheckbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { cn } from "./cn";

// "mixed" shows a dash, for a header box over a partly selected list. A
// press doesn't reach a clickable row around the box. `onChange` gets the
// press's event too, so a table can read Shift for a range.
export function Checkbox({
  checked,
  onChange,
  label,
  className,
  disabled,
}: {
  checked: boolean | "mixed";
  onChange: (on: boolean, event?: Event) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SdkCheckbox
      aria-label={label}
      checked={checked === "mixed" ? "indeterminate" : checked}
      disabled={disabled}
      onCheckedChange={(next, details) => onChange(next === true, details.event)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-border-strong bg-bg transition-colors duration-hover ease-[ease] hover:border-fg-muted",
        "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-fg",
        "data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-fg data-disabled:opacity-50",
        className,
      )}
    >
      <CheckboxIndicator className="inline-flex">
        {(state) => (state.indeterminate ? <Minus size={13} strokeWidth={3} aria-hidden /> : <Check size={13} strokeWidth={3} aria-hidden />)}
      </CheckboxIndicator>
    </SdkCheckbox>
  );
}
