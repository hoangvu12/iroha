import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useChatActions } from "./chat-panel";
import { NAV } from "./nav";
import { popupOpen } from "@/ui/popup";

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
      if (item.action === "chat") chat.toggle({ instant: true });
      else navigate(item.to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, chat]);
}
