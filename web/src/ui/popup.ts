import { cn } from "./cn";

// The popup recipe (architecture.md "UI motion system"): grows from its
// trigger and shrinks back into it, faster out than in. Under reduced motion
// the scale token is 1, so it only fades. On its own for a popup with its own
// surface (the chat model Picker); `popupClass` is it with the shared surface.
export const popupMotionClass = cn(
  "origin-(--transform-origin) transition-[opacity,scale] duration-popup-in ease-out",
  "data-starting-style:scale-(--motion-scale-popup) data-starting-style:opacity-0",
  "data-ending-style:scale-(--motion-scale-popup) data-ending-style:opacity-0 data-ending-style:duration-popup-out",
);

// The surface of menus, selects and popovers, with the popup recipe.
export const popupClass = cn("rounded-lg border border-border bg-elevated p-1 text-sm text-fg shadow-elevated outline-none", popupMotionClass);

// Page shortcuts stand down while a dialog, menu or list popup is open
// (record sheets, `data-sheet`, sit beside the page and don't count).
const OPEN_POPUP = ["dialog", "alert-dialog", "menu", "select", "combobox"]
  .map((p) => `[data-slot="${p}-content"][data-open]:not([data-sheet])`)
  .join(", ");

export function popupOpen(): boolean {
  return !!document.querySelector(OPEN_POPUP);
}
