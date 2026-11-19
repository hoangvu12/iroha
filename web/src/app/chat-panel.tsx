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
  /** One model of a Provider (`model` without the handle): a Models tab or Pool member row. */
  | { kind: "model"; provider: string; model: string }
  | { kind: "gateway_key"; gatewayKey: string }
  | { kind: "request"; request: string };

/** One "open the chat" call. `seq` changes on every call, so the content can start a new chat even for the same target. */
export type ChatRequest = { seq: number; target?: ChatTarget };

/**
 * How the sheet comes and goes. It slides for a pointer; `instant` is for
 * the C key and for swapping with the /chat page (Full page, Back to the
 * side panel), which never animate (architecture.md "UI motion system").
 */
export type SheetMotion = { instant?: boolean };

type Actions = {
  /** Open the sheet (or the /chat page on phones), optionally set up for a target. Each call with a target starts a new chat. */
  open: (target?: ChatTarget, how?: SheetMotion) => void;
  close: (how?: SheetMotion) => void;
  toggle: (how?: SheetMotion) => void;
};
type State = {
  isOpen: boolean;
  /** The last open or close asked not to animate. */
  instant: boolean;
};
type Ctx = State & Actions & { request: ChatRequest };

// Three contexts, so opening and closing the sheet re-renders only what shows
// whether it is open (the slot, the sidebar button, what sits beside it),
// not every table of Test buttons (useChatActions) or the chat itself.
const ActionsContext = createContext<Actions | null>(null);
const StateContext = createContext<State | null>(null);
const RequestContext = createContext<ChatRequest | null>(null);

export function ChatPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const [request, setRequest] = useState<ChatRequest>({ seq: 0 });
  const phone = useIsPhone();
  const navigate = useNavigate();

  const open = useCallback(
    (target?: ChatTarget, how?: SheetMotion) => {
      if (target) setRequest((r) => ({ seq: r.seq + 1, target }));
      if (phone) navigate("/chat");
      else {
        setInstant(!!how?.instant);
        setOpen(true);
      }
    },
    [phone, navigate],
  );
  const close = useCallback((how?: SheetMotion) => {
    setInstant(!!how?.instant);
    setOpen(false);
  }, []);
  const toggle = useCallback(
    (how?: SheetMotion) => {
      if (phone) navigate("/chat");
      else {
        setInstant(!!how?.instant);
        setOpen((o) => !o);
      }
    },
    [phone, navigate],
  );

  const actions = useMemo(() => ({ open, close, toggle }), [open, close, toggle]);
  const state = useMemo(() => ({ isOpen: isOpen && !phone, instant }), [isOpen, phone, instant]);
  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>
        <RequestContext.Provider value={request}>{children}</RequestContext.Provider>
      </StateContext.Provider>
    </ActionsContext.Provider>
  );
}

function need<T>(v: T | null): T {
  if (v === null) throw new Error("chat panel hook outside ChatPanelProvider");
  return v;
}

/** Open, close and toggle only: a Test button needs nothing else, and doesn't re-render as the sheet comes and goes. */
export function useChatActions(): Actions {
  return need(useContext(ActionsContext));
}

/** The last "open the chat" call, for the chat content. */
export function useChatRequest(): ChatRequest {
  return need(useContext(RequestContext));
}

/** Everything, including whether the sheet is open (re-renders on every open and close). */
export function useChatPanel(): Ctx {
  const actions = useChatActions();
  const state = need(useContext(StateContext));
  const request = useChatRequest();
  return useMemo(() => ({ ...state, ...actions, request }), [state, actions, request]);
}
