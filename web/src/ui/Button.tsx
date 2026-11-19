import type { ButtonHTMLAttributes, ComponentType, ReactNode } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: ComponentType<{ size?: number; className?: string }>;
  loading?: boolean;
  children?: ReactNode;
};

const variants: Record<Variant, string> = {
  // Each page has one primary button (near-black; light in dark mode).
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  secondary: "bg-bg text-fg border border-border-strong hover:bg-muted",
  ghost: "text-fg hover:bg-muted",
  // Red appears only on the button that deletes or revokes.
  danger: "bg-danger text-white hover:bg-danger-hover",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  lg: "h-11 px-4 text-[15px] gap-2",
};

const base =
  "inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** Button looks for a <Link> or <a> (never nest a button in a link). */
export function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, disabled, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
      {...rest}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 16} className="shrink-0" />}
      {children}
    </button>
  );
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string; // accessible name and tooltip
  size?: "sm" | "md";
  bordered?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = "md", bordered, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-muted hover:text-fg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "size-7" : "size-9",
        bordered && "border border-border-strong text-fg",
        className,
      )}
      {...rest}
    >
      <Icon size={size === "sm" ? 15 : 17} />
    </button>
  );
});
