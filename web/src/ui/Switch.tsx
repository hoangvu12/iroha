import { useEffect, useState } from "react";
import { Switch as SdkSwitch, SwitchThumb } from "@ui-sdk/react/switch";

// A press doesn't reach a clickable row around the switch.
// `pending` (a save running, see useSave): the switch shows the state it was
// pressed to at once, is busy, and ignores presses; when the save ends it
// shows `checked` again, so a failed save puts it back.
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  pending,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
  pending?: boolean;
}) {
  const [target, setTarget] = useState<boolean>();
  useEffect(() => {
    if (!pending) setTarget(undefined);
  }, [pending]);
  const shown = pending && target !== undefined ? target : checked;
  return (
    <SdkSwitch
      aria-label={label}
      aria-busy={pending || undefined}
      checked={shown}
      disabled={disabled}
      onCheckedChange={(on, details) => {
        if (pending) return details.cancel();
        setTarget(on);
        onChange(on);
      }}
      onClick={(e) => e.stopPropagation()}
      className={
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-border-strong transition-colors " +
        "data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-busy:cursor-progress motion-reduce:transition-none"
      }
    >
      <SwitchThumb className="inline-block size-[18px] translate-x-[3px] rounded-full bg-bg shadow-sm transition-transform data-checked:translate-x-[19px] motion-reduce:transition-none" />
    </SdkSwitch>
  );
}
