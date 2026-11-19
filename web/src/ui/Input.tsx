import type { InputHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import { Eye, EyeOff, Search } from "lucide-react";
import { Field as SdkField, FieldDescription, FieldError, FieldLabel, useFieldControl } from "@ui-sdk/react/field";
import { Input as SdkInput } from "@ui-sdk/react/input";
import { PasswordInput as SdkPasswordInput, PasswordInputControl, PasswordInputToggle } from "@ui-sdk/react/password-input";
import { cn } from "./cn";

const inputBase =
  // 16px on phones so focusing does not zoom the page; 14px from md up.
  "h-9 w-full rounded-lg border border-border-strong bg-bg px-3 text-base md:text-sm text-fg placeholder:text-fg-subtle " +
  "outline-none transition-[border-color,box-shadow] focus:border-info focus:ring-2 focus:ring-info/20 " +
  "disabled:opacity-60 aria-[invalid=true]:border-danger-text";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue"> & {
  value?: string;
  defaultValue?: string;
  mono?: boolean;
};

// Inside a Field, UI SDK's controls take the label and notes from the Field;
// the same references passed again by Field's children(props) would repeat them.
function useWithoutFieldRefs<P extends InputProps>(props: P): P {
  const field = useFieldControl();
  if (!field) return props;
  const { "aria-describedby": _describedBy, "aria-labelledby": _labelledBy, ...own } = props;
  return own as P;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const { className, mono, ...rest } = useWithoutFieldRefs(props);
  return <SdkInput ref={ref} className={cn(inputBase, mono && "font-mono text-[13px]", className)} {...rest} />;
});

/** A password field with a show/hide eye (C13). */
export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput(props, ref) {
  const { className, mono, value, defaultValue, name, form, required, disabled, readOnly, autoComplete, ...rest } =
    useWithoutFieldRefs(props);
  return (
    <SdkPasswordInput
      className="relative block"
      {...{ value, defaultValue, name, form, required, disabled, readOnly, autoComplete }}
    >
      <PasswordInputControl ref={ref} className={cn(inputBase, "pr-10", mono && "font-mono text-[13px]", className)} {...rest} />
      <PasswordInputToggle
        aria-label="Show password"
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-fg-muted hover:text-fg"
      >
        {(state) => (state.visible ? <EyeOff size={17} aria-hidden /> : <Eye size={17} aria-hidden />)}
      </PasswordInputToggle>
    </SdkPasswordInput>
  );
});

export const SearchInput = forwardRef<HTMLInputElement, InputProps>(function SearchInput(props, ref) {
  const { className, ...rest } = useWithoutFieldRefs(props);
  return (
    <div className={cn("relative", className)}>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
      <SdkInput ref={ref} type="search" className={cn(inputBase, "pl-9")} {...rest} />
    </div>
  );
});

type ControlProps = { id?: string; "aria-invalid"?: boolean; "aria-describedby"?: string };

/**
 * Label, control, then a hint or an error under it (UI SDK's Field). The
 * control comes from `children(props)`: Input and PasswordInput join the
 * Field by themselves, and `props` connects any other control (a native
 * select or textarea) to the label, hint and error.
 */
export function Field({
  label,
  hint,
  error,
  children,
  id,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id?: string;
  children: (props: ControlProps) => ReactNode;
}) {
  return (
    <SdkField invalid={error ? true : undefined} className="flex flex-col gap-1.5">
      <FieldLabel className="text-sm font-medium text-fg">{label}</FieldLabel>
      <Control id={id} render={children} />
      {error ? (
        // Fades in where the hint was: no shift, no shake.
        <FieldError match role="alert" className="text-[13px] text-danger-text transition-opacity duration-list-in ease-out starting:opacity-0">
          {error}
        </FieldError>
      ) : hint ? (
        <FieldDescription className="text-[13px] text-fg-muted">{hint}</FieldDescription>
      ) : null}
    </SdkField>
  );
}

function Control({ id, render }: { id?: string; render: (props: ControlProps) => ReactNode }) {
  const field = useFieldControl({ id });
  const own = id ? { id } : {};
  return render(field ? (field.props(own) as ControlProps) : own);
}
