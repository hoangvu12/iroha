import { cn } from "./cn";

export const popupMotionClass = cn(
  "origin-(--transform-origin) transition-[opacity,scale] duration-popup-in ease-out",
  "data-starting-style:scale-(--motion-scale-popup) data-starting-style:opacity-0",
  "data-ending-style:scale-(--motion-scale-popup) data-ending-style:opacity-0 data-ending-style:duration-popup-out",
);

export const popupClass = cn("rounded-lg border border-border bg-elevated p-1 text-sm text-fg shadow-elevated outline-none", popupMotionClass);

const OPEN_POPUP = ["dialog", "alert-dialog", "menu", "select", "combobox"]
  .map((p) => `[data-slot="${p}-content"][data-open]:not([data-sheet])`)
  .join(", ");

export function popupOpen(): boolean {
  return !!document.querySelector(OPEN_POPUP);
}
