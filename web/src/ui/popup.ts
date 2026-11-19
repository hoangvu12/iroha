import { cn } from "./cn";

// The surface of menus, selects and popovers: grows from its trigger and
// shrinks back into it, faster out than in (architecture.md "UI motion
// system"). Under reduced motion the scale token is 1, so it only fades.
export const popupClass = cn(
  "rounded-lg border border-border bg-elevated p-1 text-sm text-fg shadow-elevated outline-none",
  "origin-(--transform-origin) transition-[opacity,scale] duration-popup-in ease-out",
  "data-starting-style:scale-(--motion-scale-popup) data-starting-style:opacity-0",
  "data-ending-style:scale-(--motion-scale-popup) data-ending-style:opacity-0 data-ending-style:duration-popup-out",
);

// Page shortcuts stand down while a dialog, menu or list popup is open
// (record sheets, `data-sheet`, sit beside the page and don't count).
const OPEN_POPUP = ["dialog", "alert-dialog", "menu", "select", "combobox"]
  .map((p) => `[data-slot="${p}-content"][data-open]:not([data-sheet])`)
  .join(", ");

export function popupOpen(): boolean {
  return !!document.querySelector(OPEN_POPUP);
}
