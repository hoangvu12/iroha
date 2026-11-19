import * as DM from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/ui/cn";

// Submenus and checkbox items for the Filter and Columns menus, styled like
// src/ui/Menu.tsx (which has the plain items).

const itemClass =
  "flex h-8 select-none items-center gap-2 rounded-md px-2 text-fg outline-none " +
  "data-[highlighted]:bg-muted data-[state=open]:bg-muted data-[disabled]:opacity-50";

export function SubMenu({ label, value, children }: { label: ReactNode; value?: ReactNode; children: ReactNode }) {
  return (
    <DM.Sub>
      <DM.SubTrigger className={itemClass}>
        <span className="flex-1">{label}</span>
        {value && <span className="max-w-32 truncate text-xs text-fg-muted">{value}</span>}
        <ChevronRight size={14} className="text-fg-muted" />
      </DM.SubTrigger>
      <DM.Portal>
        <DM.SubContent
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-h-[min(420px,70vh)] min-w-52 max-w-80 overflow-y-auto rounded-lg border border-border bg-elevated p-1 text-sm shadow-elevated"
        >
          {children}
        </DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  );
}

export function CheckItem({
  checked,
  onChange,
  children,
  count,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <DM.CheckboxItem
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      onSelect={(e) => e.preventDefault()}
      className={cn(itemClass, "relative pl-8")}
    >
      <DM.ItemIndicator className="absolute left-2 inline-flex">
        <Check size={15} />
      </DM.ItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="tabular text-xs text-fg-subtle">{count}</span>}
    </DM.CheckboxItem>
  );
}

/** A radio-like choice that stays a plain item (closes the menu on select). */
export function ChoiceItem({
  selected,
  onSelect,
  children,
  count,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <DM.Item onSelect={onSelect} className={cn(itemClass, "relative pl-8")}>
      {selected && (
        <span className="absolute left-2 inline-flex">
          <Check size={15} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="tabular text-xs text-fg-subtle">{count}</span>}
    </DM.Item>
  );
}
