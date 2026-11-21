import { useEffect, useState } from "react";
import { Switch as SdkSwitch, SwitchThumb } from "@ui-sdk/react/switch";

function useOptimisticChecked(checked: boolean, pending: boolean | undefined) {
  const [target, setTarget] = useState<boolean>();
  useEffect(() => {
    if (!pending) setTarget(undefined);
  }, [pending]);
  const shown = pending && target !== undefined ? target : checked;
  return [shown, setTarget] as const;
}

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
  const [shown, showUntilSettled] = useOptimisticChecked(checked, pending);
  return (
    <SdkSwitch
      aria-label={label}
      aria-busy={pending || undefined}
      checked={shown}
      disabled={disabled}
      onCheckedChange={(on, details) => {
        if (pending) return details.cancel();
        showUntilSettled(on);
        onChange(on);
      }}
      onClick={(e) => e.stopPropagation()}
      className={
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-border-strong transition-colors duration-hover ease-[ease] " +
        "data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-busy:cursor-progress"
      }
    >
      <SwitchThumb className="inline-block size-[18px] translate-x-[3px] rounded-full bg-bg shadow-sm transition-[translate] duration-press ease-out data-checked:translate-x-[19px]" />
    </SdkSwitch>
  );
}
