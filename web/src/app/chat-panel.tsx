import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useIsPhone } from "@/lib/media";

export type ChatTarget =
  | { kind: "provider"; provider: string }
  | { kind: "pool"; pool: string }
  | { kind: "upstream_key"; provider: string; key: string }
  | { kind: "model"; provider: string; model: string }
  | { kind: "gateway_key"; gatewayKey: string }
  | { kind: "request"; request: string };

export type ChatRequest = { seq: number; target?: ChatTarget };

export type SheetMotion = { instant?: boolean };

type Actions = {
  open: (target?: ChatTarget, how?: SheetMotion) => void;
  close: (how?: SheetMotion) => void;
  toggle: (how?: SheetMotion) => void;
};
type State = {
  isOpen: boolean;
  instant: boolean;
  slideStarted: boolean;
};
type Ctx = State & Actions & { request: ChatRequest };

const ActionsContext = createContext<Actions | null>(null);
const StateContext = createContext<State | null>(null);
const RequestContext = createContext<ChatRequest | null>(null);
const SlideStartContext = createContext<(() => void) | null>(null);

const opened = (p: State, instant: boolean): State => ({ isOpen: true, instant, slideStarted: p.isOpen && p.slideStarted });
const closed = (p: State, instant: boolean): State => ({ ...p, isOpen: false, instant });

export function ChatPanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<State>({ isOpen: false, instant: false, slideStarted: false });
  const [request, setRequest] = useState<ChatRequest>({ seq: 0 });
  const phone = useIsPhone();
  const navigate = useNavigate();

  const open = useCallback(
    (target?: ChatTarget, how?: SheetMotion) => {
      if (target) setRequest((r) => ({ seq: r.seq + 1, target }));
      if (phone) navigate("/chat");
      else setPanel((p) => opened(p, !!how?.instant));
    },
    [phone, navigate],
  );
  const close = useCallback((how?: SheetMotion) => setPanel((p) => closed(p, !!how?.instant)), []);
  const toggle = useCallback(
    (how?: SheetMotion) => {
      if (phone) navigate("/chat");
      else setPanel((p) => (p.isOpen ? closed : opened)(p, !!how?.instant));
    },
    [phone, navigate],
  );
  const reportSlideStart = useCallback(() => setPanel((p) => (p.isOpen && !p.slideStarted ? { ...p, slideStarted: true } : p)), []);

  const actions = useMemo(() => ({ open, close, toggle }), [open, close, toggle]);
  const { isOpen, instant, slideStarted } = panel;
  const state = useMemo(() => ({ isOpen: isOpen && !phone, instant, slideStarted }), [isOpen, phone, instant, slideStarted]);
  return (
    <ActionsContext.Provider value={actions}>
      <SlideStartContext.Provider value={reportSlideStart}>
        <StateContext.Provider value={state}>
          <RequestContext.Provider value={request}>{children}</RequestContext.Provider>
        </StateContext.Provider>
      </SlideStartContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useReportChatSlideStart(): () => void {
  return need(useContext(SlideStartContext));
}

function need<T>(v: T | null): T {
  if (v === null) throw new Error("chat panel hook outside ChatPanelProvider");
  return v;
}

export function useChatActions(): Actions {
  return need(useContext(ActionsContext));
}

export function useChatRequest(): ChatRequest {
  return need(useContext(RequestContext));
}

export function useChatPanel(): Ctx {
  const actions = useChatActions();
  const state = need(useContext(StateContext));
  const request = useChatRequest();
  return useMemo(() => ({ ...state, ...actions, request }), [state, actions, request]);
}
