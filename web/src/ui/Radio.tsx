import type { ReactNode } from "react";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";

export type RadioCardOption<T extends string = string> = { value: T; title: string; description: ReactNode };

export function RadioCards<T extends string>({
  label,
  value,
  onValueChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onValueChange: (v: T) => void;
  options: RadioCardOption<T>[];
  className?: string;
}) {
  return (
    <RadioGroup aria-label={label} value={value} onValueChange={(v) => v !== null && onValueChange(v as T)} className={className ?? "flex flex-col gap-1.5"}>
      {options.map((o) => (
        <Field key={o.value} render={<label />} className="flex w-full cursor-pointer gap-3 rounded-lg py-1.5 text-left">
          <Radio
            value={o.value}
            className="mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-border-strong bg-bg transition-colors data-checked:border-primary data-checked:bg-primary"
          >
            <RadioIndicator className="size-[7px] rounded-full bg-primary-fg" />
          </Radio>
          <span className="min-w-0">
            <FieldLabel render={<span />} className="block text-[15px] text-fg">
              {o.title}
            </FieldLabel>
            <FieldDescription render={<span />} className="mt-0.5 block text-sm text-fg-muted">
              {o.description}
            </FieldDescription>
          </span>
        </Field>
      ))}
    </RadioGroup>
  );
}
