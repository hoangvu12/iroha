import { cn } from "./cn";

// The surface of menus, selects and popovers: grows from its trigger.
export const popupClass = cn(
  "rounded-lg border border-border bg-elevated p-1 text-sm text-fg shadow-elevated outline-none",
  "origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out",
  "data-starting-style:scale-96 data-starting-style:opacity-0 data-ending-style:scale-96 data-ending-style:opacity-0 motion-reduce:transition-none",
);

// Page shortcuts stand down while a dialog, menu or list popup is open.
const OPEN_POPUP = ["dialog", "alert-dialog", "menu", "select", "combobox"]
  .map((p) => `[data-slot="${p}-content"][data-open]`)
  .join(", ");

export function popupOpen(): boolean {
  return !!document.querySelector(OPEN_POPUP);
}
