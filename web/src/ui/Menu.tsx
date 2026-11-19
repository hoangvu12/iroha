import * as DM from "@radix-ui/react-dropdown-menu";
import type { ComponentType, ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "./cn";

// Menus (the ⋯ on rows, the Owner menu). Radix gives keyboard navigation
// and focus handling; these wrappers give the look.

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuGroup = DM.Group;
export const MenuRadioGroup = DM.RadioGroup;

export function MenuContent({
  children,
  align = "end",
  side,
  className,
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={8}
        className={cn("z-50 min-w-44 rounded-lg border border-border bg-elevated p-1 text-sm shadow-elevated", className)}
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

const itemClass =
  "flex h-8 select-none items-center gap-2 rounded-md px-2 text-fg outline-none " +
  "data-[highlighted]:bg-muted data-[disabled]:opacity-50";

export function MenuItem({
  children,
  onSelect,
  icon: Icon,
  danger,
  disabled,
  shortcut,
}: {
  children: ReactNode;
  onSelect?: (e: Event) => void;
  icon?: ComponentType<{ size?: number; className?: string }>;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <DM.Item onSelect={onSelect} disabled={disabled} className={cn(itemClass, danger && "text-danger-text")}>
      {Icon && <Icon size={15} className={danger ? "" : "text-fg-muted"} />}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-xs text-fg-subtle">{shortcut}</span>}
    </DM.Item>
  );
}

export function MenuRadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <DM.RadioItem value={value} className={cn(itemClass, "pl-8 relative")}>
      <DM.ItemIndicator className="absolute left-2 inline-flex">
        <Check size={15} />
      </DM.ItemIndicator>
      {children}
    </DM.RadioItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2 pb-1 pt-1.5 text-xs text-fg-muted">{children}</DM.Label>;
}

export function MenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-border" />;
}
