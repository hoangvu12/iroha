import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useChatActions } from "./chat-panel";
import { NAV } from "./nav";
import { popupOpen } from "@/ui/popup";

/** True when a key press belongs to whatever has focus, not to the app. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return false;
}

/**
 * Single-key navigation from every page: P, G, R open their pages and C
 * toggles the chat. Ignored while typing, with modifier keys, and while a
 * modal dialog or menu is open.
 */
export function useNavShortcuts() {
  const navigate = useNavigate();
  const chat = useChatActions();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typingInto(e.target)) return;
      if (popupOpen()) return;
      const item = NAV.find((n) => n.key.toLowerCase() === e.key.toLowerCase());
      if (!item) return;
      e.preventDefault();
      if (item.action === "chat") chat.toggle({ instant: true }); // a key: no slide
      else navigate(item.to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, chat]);
}
