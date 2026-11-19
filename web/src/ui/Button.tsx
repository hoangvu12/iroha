import type { ButtonHTMLAttributes, ComponentType, MouseEvent, ReactNode } from "react";
import { forwardRef } from "react";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { cn } from "./cn";
import { Tip } from "./Tooltip";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: ComponentType<{ size?: number; className?: string }>;
  loading?: boolean;
  // Keeps a disabled button focusable, so a tooltip can say why.
  focusableWhenDisabled?: boolean;
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

// disabled: for other elements styled with buttonClass; data-disabled for UI
// SDK's Button, which also marks a focusable disabled button that way.
const base =
  "inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors " +
  "disabled:opacity-50 data-disabled:opacity-50 data-pending:cursor-progress";

/** Button looks for a <Link> or <a> (never nest a button in a link). */
export function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

// `loading` is for a request the page tracks; an onClick that returns a
// Promise keeps UI SDK's Button pending by itself until the Promise settles.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, disabled, className, children, type = "button", onClick, ...rest },
  ref,
) {
  return (
    <SdkButton
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
      onClick={onClick && ((e) => onClick(e as MouseEvent<HTMLButtonElement>))}
      {...rest}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 16} className="shrink-0" />}
      {children}
    </SdkButton>
  );
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string; // accessible name and tooltip
  size?: "sm" | "md";
  bordered?: boolean;
};

export function iconButtonClass(size: "sm" | "md" = "md", bordered?: boolean, className?: string) {
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-muted hover:text-fg",
    "disabled:opacity-50 data-disabled:opacity-50 data-open:bg-muted data-open:text-fg",
    size === "sm" ? "size-7" : "size-9",
    bordered && "border border-border-strong text-fg",
    className,
  );
}

// The label is the button's name and its tooltip.
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = "md", bordered, className, type = "button", onClick, ...rest },
  ref,
) {
  return (
    <Tip label={label} type="label">
      <SdkButton
        ref={ref}
        type={type}
        className={iconButtonClass(size, bordered, className)}
        onClick={onClick && ((e) => onClick(e as MouseEvent<HTMLButtonElement>))}
        {...rest}
      >
        <Icon size={size === "sm" ? 15 : 17} aria-hidden />
      </SdkButton>
    </Tip>
  );
});
