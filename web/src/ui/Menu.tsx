import type { ComponentType, ReactElement, ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import {
  Menu as SdkMenu,
  MenuCheckboxItem as SdkMenuCheckboxItem,
  MenuContent as SdkMenuContent,
  MenuGroup as SdkMenuGroup,
  MenuGroupLabel,
  MenuItem as SdkMenuItem,
  MenuItemIndicator,
  MenuRadioGroup as SdkMenuRadioGroup,
  MenuRadioItem as SdkMenuRadioItem,
  MenuSeparator as SdkMenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger as SdkMenuTrigger,
} from "@ui-sdk/react/menu";
import { iconButtonClass } from "./Button";
import { cn } from "./cn";
import { popupClass } from "./popup";
import { Tip } from "./Tooltip";

// Menus (the ⋯ on rows, the Owner menu, the Requests filters) on UI SDK's
// Menu: one Menu per row, its trigger named for the row.

export const Menu = SdkMenu;
export const MenuTrigger = SdkMenuTrigger;

type Icon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

// An icon-only trigger, named by its label, which is also its tooltip.
export function MenuIconTrigger({
  icon: Icon,
  label,
  size = "md",
  bordered,
  className,
}: {
  icon: Icon;
  label: string;
  size?: "sm" | "md";
  bordered?: boolean;
  className?: string;
}) {
  return (
    <Tip label={label} type="label">
      <SdkMenuTrigger className={iconButtonClass(size, bordered, className)}>
        <Icon size={size === "sm" ? 15 : 17} aria-hidden />
      </SdkMenuTrigger>
    </Tip>
  );
}

export function MenuContent({
  children,
  align = "end",
  side,
  className,
  finalFocus,
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  finalFocus?: "trigger" | "none" | string;
}) {
  return (
    <SdkMenuContent
      align={align}
      side={side}
      sideOffset={6}
      collisionPadding={8}
      finalFocus={finalFocus}
      className={cn(popupClass, "max-h-(--available-height) min-w-44 overflow-y-auto", className)}
    >
      {children}
    </SdkMenuContent>
  );
}

const itemClass =
  "flex h-8 select-none items-center gap-2 rounded-md px-2 text-fg outline-none " +
  "data-highlighted:bg-muted data-open:bg-muted data-disabled:opacity-50 data-destructive:text-danger-text";

export function MenuItem({
  children,
  onSelect,
  icon: Icon,
  danger,
  disabled,
  render,
  label,
}: {
  children: ReactNode;
  onSelect?: (e: Event) => void;
  icon?: Icon;
  danger?: boolean;
  disabled?: boolean;
  render?: ReactElement;
  label?: string;
}) {
  return (
    <SdkMenuItem
      // The menu closes at once; a returned Promise would keep it open and pending.
      onSelect={onSelect && ((e) => void onSelect(e))}
      disabled={disabled}
      destructive={danger}
      render={render}
      label={label}
      className={itemClass}
    >
      {Icon && <Icon size={15} aria-hidden className={danger ? "" : "text-fg-muted"} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </SdkMenuItem>
  );
}

export function MenuRadioGroup({
  label,
  value,
  onValueChange,
  children,
}: {
  label?: ReactNode;
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <SdkMenuRadioGroup value={value} onValueChange={(v) => onValueChange(String(v))}>
      {label && <MenuGroupLabel className={labelClass}>{label}</MenuGroupLabel>}
      {children}
    </SdkMenuRadioGroup>
  );
}

// Radio items close the menu: each is a choice, not a setting to toggle along.
export function MenuRadioItem({ value, children, label }: { value: string; children: ReactNode; label?: string }) {
  return (
    <SdkMenuRadioItem value={value} label={label} closeOnSelect className={cn(itemClass, "relative pl-8")}>
      <MenuItemIndicator className="absolute left-2 inline-flex">
        <Check size={15} aria-hidden />
      </MenuItemIndicator>
      {children}
    </SdkMenuRadioItem>
  );
}

export function MenuCheckboxItem({
  value,
  checked,
  onCheckedChange,
  children,
  count,
}: {
  value: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <SdkMenuCheckboxItem value={value} checked={checked} onCheckedChange={(v) => onCheckedChange(v)} className={cn(itemClass, "relative pl-8")}>
      <MenuItemIndicator className="absolute left-2 inline-flex">
        <Check size={15} aria-hidden />
      </MenuItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="tabular text-xs text-fg-subtle">{count}</span>}
    </SdkMenuCheckboxItem>
  );
}

const labelClass = "px-2 pb-1 pt-1.5 text-xs text-fg-muted";

export function MenuGroup({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <SdkMenuGroup>
      <MenuGroupLabel className={labelClass}>{label}</MenuGroupLabel>
      {children}
    </SdkMenuGroup>
  );
}

// A line of text in a menu that is not an item, like a status or "Loading…".
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className={labelClass}>{children}</div>;
}

export function MenuSeparator() {
  return <SdkMenuSeparator className="-mx-1 my-1 h-px bg-border" />;
}

export function SubMenu({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return (
    <MenuSub>
      <MenuSubTrigger className={itemClass}>
        <span className="flex-1">{label}</span>
        {value && <span className="max-w-32 truncate text-xs text-fg-muted">{value}</span>}
        <ChevronRight size={14} aria-hidden className="text-fg-muted" />
      </MenuSubTrigger>
      <MenuSubContent
        sideOffset={6}
        collisionPadding={8}
        className={cn(popupClass, "max-h-[min(420px,var(--available-height))] min-w-52 max-w-80 overflow-y-auto")}
      >
        {children}
      </MenuSubContent>
    </MenuSub>
  );
}
