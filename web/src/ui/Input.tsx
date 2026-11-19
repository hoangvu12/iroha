import type { InputHTMLAttributes, ReactNode } from "react";
import { forwardRef, useId, useState } from "react";
import { Eye, EyeOff, Search } from "lucide-react";
import { cn } from "./cn";

const inputBase =
  // 16px on phones so focusing does not zoom the page; 14px from md up.
  "h-9 w-full rounded-lg border border-border-strong bg-bg px-3 text-base md:text-sm text-fg placeholder:text-fg-subtle " +
  "outline-none transition-[border-color,box-shadow] focus:border-info focus:ring-2 focus:ring-info/20 " +
  "disabled:opacity-60 aria-[invalid=true]:border-danger-text";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { mono?: boolean };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, mono, ...rest }, ref) {
  return <input ref={ref} className={cn(inputBase, mono && "font-mono text-[13px]", className)} {...rest} />;
});

/** A password field with a show/hide eye (C13). */
export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput({ className, ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input ref={ref} type={shown ? "text" : "password"} className={cn(inputBase, "pr-10", className)} {...rest} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        title={shown ? "Hide" : "Show"}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-fg-muted hover:text-fg"
      >
        {shown ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
});

export const SearchInput = forwardRef<HTMLInputElement, InputProps>(function SearchInput({ className, ...rest }, ref) {
  return (
    <div className={cn("relative", className)}>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
      <input ref={ref} type="search" className={cn(inputBase, "pl-9")} {...rest} />
    </div>
  );
});

/** Label, control, then a hint or an error under it. */
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
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const auto = useId();
  const fid = id ?? auto;
  const noteId = `${fid}-note`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fid} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children({ id: fid, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? noteId : undefined })}
      {error ? (
        <p id={noteId} role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p id={noteId} className="text-[13px] text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
