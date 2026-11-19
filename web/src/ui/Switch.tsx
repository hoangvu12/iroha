import { Switch as SdkSwitch, SwitchThumb } from "@ui-sdk/react/switch";

// A press doesn't reach a clickable row around the switch.
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <SdkSwitch
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(on) => onChange(on)}
      onClick={(e) => e.stopPropagation()}
      className={
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-border-strong transition-colors " +
        "data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50 motion-reduce:transition-none"
      }
    >
      <SwitchThumb className="inline-block size-[18px] translate-x-[3px] rounded-full bg-bg shadow-sm transition-transform data-checked:translate-x-[19px] motion-reduce:transition-none" />
    </SdkSwitch>
  );
}
