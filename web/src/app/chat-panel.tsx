import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useIsPhone } from "@/lib/media";

// The right-side chat panel slot (README "Chat"). One shared sheet, 460 px
// wide, that does not block the page and stays open across pages. The shell
// owns opening and closing; ticket 23 fills the content
// (src/pages/chat/ChatPanel.tsx) and reads `request` to start a chat set up
// from wherever Test was pressed. On phones Chat is the full page /chat.

/** What a Test button asks the chat to start with. */
export type ChatTarget =
  | { kind: "provider"; provider: string }
  | { kind: "pool"; pool: string }
  | { kind: "upstream_key"; provider: string; key: string }
  | { kind: "gateway_key"; gatewayKey: string }
  | { kind: "request"; request: string };

/** One "open the chat" call. `seq` changes on every call, so the content can start a new chat even for the same target. */
export type ChatRequest = { seq: number; target?: ChatTarget };

type Ctx = {
  isOpen: boolean;
  request: ChatRequest;
  /** Open the sheet (or the /chat page on phones), optionally set up for a target. Each call with a target starts a new chat. */
  open: (target?: ChatTarget) => void;
  close: () => void;
  toggle: () => void;
};

const ChatPanelContext = createContext<Ctx | null>(null);

export function ChatPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [request, setRequest] = useState<ChatRequest>({ seq: 0 });
  const phone = useIsPhone();
  const navigate = useNavigate();

  const open = useCallback(
    (target?: ChatTarget) => {
      if (target) setRequest((r) => ({ seq: r.seq + 1, target }));
      if (phone) navigate("/chat");
      else setOpen(true);
    },
    [phone, navigate],
  );
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => {
    if (phone) navigate("/chat");
    else setOpen((o) => !o);
  }, [phone, navigate]);

  const value = useMemo(() => ({ isOpen: isOpen && !phone, request, open, close, toggle }), [isOpen, phone, request, open, close, toggle]);
  return <ChatPanelContext.Provider value={value}>{children}</ChatPanelContext.Provider>;
}

export function useChatPanel(): Ctx {
  const ctx = useContext(ChatPanelContext);
  if (!ctx) throw new Error("useChatPanel outside ChatPanelProvider");
  return ctx;
}
