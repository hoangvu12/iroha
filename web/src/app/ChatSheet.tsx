import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { animateIn, animateOut } from "@ui-sdk/core";
import { useChatPanel } from "./chat-panel";

export const CHAT_WIDTH = 460;

// The sheet recipe (architecture.md "UI motion system"): in and out along the
// right edge on the drawer curve, opacity on its own short fade so reduced
// motion (slide tokens at 0) still fades. data-instant drops the transition
// for the C key and the /chat page swap.
const sheetClass = [
  "fixed inset-y-0 right-0 z-30 flex max-w-full flex-col border-l border-border bg-subtle shadow-elevated",
  "[transition:translate_var(--duration-sheet-in)_var(--ease-drawer),opacity_var(--duration-fade)_var(--ease-out)]",
  "data-ending-style:[transition-duration:var(--duration-sheet-out),var(--duration-fade)]",
  "data-starting-style:translate-x-(--motion-sheet-offset) data-starting-style:opacity-0",
  "data-ending-style:translate-x-(--motion-sheet-offset) data-ending-style:opacity-0",
  "data-instant:transition-none",
].join(" ");

/**
 * The chat panel's slot on the right. It stays mounted while it slides out
 * (inert, so nothing in it takes focus or clicks), and turns back from where
 * it is when opened again mid-exit. `hidden` is the /chat page, where the
 * full-page chat takes its place at once.
 */
export function ChatSheet({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const chat = useChatPanel();
  const show = chat.isOpen && !hidden;
  const [present, setPresent] = useState(show);
  if (show && !present) setPresent(true);
  const ref = useRef<HTMLElement>(null);
  const leaving = useRef(false);
  const wasOpen = useRef(chat.isOpen);

  useLayoutEffect(() => {
    // Only the panel's own open and close slide; a route change swaps it at once.
    const instant = chat.instant || wasOpen.current === chat.isOpen;
    wasOpen.current = chat.isOpen;
    const el = ref.current;
    if (!el) return;
    if (show) {
      // Reopened mid-exit: the exit's cleanup already lifted data-ending-style,
      // so the running transition turns back on its own.
      if (leaving.current) {
        leaving.current = false;
        return;
      }
      return instant ? undefined : animateIn(el);
    }
    if (instant) {
      leaving.current = false;
      setPresent(false);
      return;
    }
    leaving.current = true;
    return animateOut(el, () => {
      leaving.current = false;
      setPresent(false);
    });
    // Runs when the sheet is asked to show or hide; `instant` is read with it.
  }, [show]);

  if (!present) return null;
  return (
    <aside ref={ref} aria-label="Chat" style={{ width: CHAT_WIDTH }} data-instant={chat.instant ? "" : undefined} className={sheetClass}>
      {children}
    </aside>
  );
}
