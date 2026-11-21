import type { ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { animateIn, animateOut } from "@ui-sdk/core";
import { useChatPanel, useReportChatSlideStart } from "./chat-panel";

export const CHAT_WIDTH = 460;

const sheetClass = [
  "fixed inset-y-0 right-0 z-30 flex max-w-full flex-col border-l border-border bg-subtle shadow-elevated",
  "[transition:translate_var(--duration-sheet-in)_var(--ease-drawer),opacity_var(--duration-fade)_var(--ease-out)]",
  "data-ending-style:[transition-duration:var(--duration-sheet-out),var(--duration-fade)]",
  "data-starting-style:translate-x-(--motion-sheet-offset) data-starting-style:opacity-0",
  "data-ending-style:translate-x-(--motion-sheet-offset) data-ending-style:opacity-0",
  "data-instant:transition-none",
].join(" ");

function slideIn(el: HTMLElement, onSlideStart: () => void): () => void {
  const leftStartingStyle = new MutationObserver(() => {
    if (el.hasAttribute("data-starting-style")) return;
    leftStartingStyle.disconnect();
    flushSync(onSlideStart);
  });
  leftStartingStyle.observe(el, { attributeFilter: ["data-starting-style"] });
  const stop = animateIn(el);
  return () => {
    leftStartingStyle.disconnect();
    stop();
  };
}

function useReturnFocus(panel: RefObject<HTMLElement | null>): () => void {
  const lastFocusOutside = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const note = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && !panel.current?.contains(e.target)) lastFocusOutside.current = e.target;
    };
    document.addEventListener("focusin", note);
    return () => document.removeEventListener("focusin", note);
  }, [panel]);
  return () => {
    if (panel.current?.contains(document.activeElement) && lastFocusOutside.current?.isConnected) lastFocusOutside.current.focus({ preventScroll: true });
  };
}

export function ChatSheet({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const chat = useChatPanel();
  const reportSlideStart = useReportChatSlideStart();
  const show = chat.isOpen && !hidden;
  const [present, setPresent] = useState(show);
  if (show && !present) setPresent(true);
  const ref = useRef<HTMLElement>(null);
  const leaving = useRef(false);
  const wasOpen = useRef(chat.isOpen);
  const returnFocus = useReturnFocus(ref);

  useLayoutEffect(() => {
    const instant = chat.instant || wasOpen.current === chat.isOpen;
    wasOpen.current = chat.isOpen;
    const el = ref.current;
    if (!el) return;
    if (!show && !chat.isOpen) returnFocus();
    if (show) {
      if (leaving.current || instant) {
        leaving.current = false;
        reportSlideStart();
        return;
      }
      return slideIn(el, reportSlideStart);
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
  }, [show]);

  if (!present) return null;
  return (
    <aside ref={ref} aria-label="Chat" style={{ width: CHAT_WIDTH }} data-instant={chat.instant ? "" : undefined} className={sheetClass}>
      {children}
    </aside>
  );
}
