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
  focusableWhenDisabled?: boolean;
  danger?: boolean | "hover";
  children?: ReactNode;
};

const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  secondary: "bg-bg text-fg border border-border-strong hover:bg-muted",
  ghost: "text-fg hover:bg-muted",
  danger: "bg-danger text-white hover:bg-danger-hover",
};

const dangerTones: Record<Variant, string> = {
  primary: variants.danger,
  secondary: "bg-bg text-danger-text border border-danger hover:bg-danger-tint",
  ghost: "text-danger-text hover:bg-danger-tint",
  danger: variants.danger,
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  lg: "h-11 px-4 text-[15px] gap-2",
};

const press = "press";

const base =
  `inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-medium ${press} ` +
  "disabled:opacity-50 data-disabled:opacity-50 data-pending:cursor-progress";

const dangerOnHover =
  "hover:bg-danger-tint hover:text-danger-text hover:border-danger focus-visible:text-danger-text focus-visible:border-danger";

export function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string, danger?: boolean | "hover") {
  const tone = danger === "hover" ? cn(variants[variant], dangerOnHover) : danger ? dangerTones[variant] : variants[variant];
  return cn(base, tone, sizes[size], className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, disabled, danger, className, children, type = "button", onClick, ...rest },
  ref,
) {
  return (
    <SdkButton
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-danger={danger === "hover" ? "hover" : danger || undefined}
      className={buttonClass(variant, size, className, danger)}
      onClick={onClick && ((e) => onClick(e as MouseEvent<HTMLButtonElement>))}
      {...rest}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 16} className="shrink-0" />}
      {children}
    </SdkButton>
  );
});

export type TextButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "link" | "quiet";
};

const textTones = { link: "text-info hover:underline", quiet: "text-fg-muted hover:text-fg" };

export const TextButton = forwardRef<HTMLButtonElement, TextButtonProps>(function TextButton(
  { tone = "link", className, type = "button", onClick, ...rest },
  ref,
) {
  return (
    <SdkButton
      ref={ref}
      type={type}
      className={cn(textTones[tone], "disabled:opacity-60 data-disabled:opacity-60", className)}
      onClick={onClick && ((e) => onClick(e as MouseEvent<HTMLButtonElement>))}
      {...rest}
    />
  );
});

export type IconButtonProps =ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  size?: "xs" | "sm" | "md";
  bordered?: boolean;
  danger?: boolean;
  focusableWhenDisabled?: boolean;
};

const iconSizes = { xs: "size-5 rounded", sm: "size-7 rounded-lg", md: "size-9 rounded-lg" };
const iconPx = { xs: 13, sm: 15, md: 17 };

export function iconButtonClass(size: "xs" | "sm" | "md" = "md", bordered?: boolean, className?: string, danger?: boolean) {
  return cn(
    `inline-flex shrink-0 items-center justify-center text-fg-muted ${press}`,
    danger
      ? "hover:bg-danger-tint hover:text-danger-text focus-visible:text-danger-text data-open:bg-danger-tint data-open:text-danger-text"
      : "hover:bg-muted hover:text-fg data-open:bg-muted data-open:text-fg",
    "disabled:opacity-50 data-disabled:opacity-50",
    iconSizes[size],
    bordered && "border border-border-strong text-fg",
    className,
  );
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = "md", bordered, danger, className, type = "button", onClick, ...rest },
  ref,
) {
  return (
    <Tip label={label} type="label">
      <SdkButton
        ref={ref}
        type={type}
        data-danger={danger || undefined}
        className={iconButtonClass(size, bordered, className, danger)}
        onClick={onClick && ((e) => onClick(e as MouseEvent<HTMLButtonElement>))}
        {...rest}
      >
        <Icon size={iconPx[size]} aria-hidden />
      </SdkButton>
    </Tip>
  );
});
