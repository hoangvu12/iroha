import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowUp, ChevronDown, Code2, KeyRound, Link2, Maximize2, MessageCircle, Minimize2, Square, SquarePen, Trash2, Wrench, X } from "lucide-react";
import { useChatPanel } from "@/app/chat-panel";
import { timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { notify } from "@/ui/toast";
import type { Settings } from "./api";
import { bareModel } from "./api";
import { ModelTile, Picker, type View } from "./Picker";
import { Reply } from "./Reply";
import { SnippetDialog } from "./SnippetDialog";
import type { Chat } from "./store";
import { currentChat, deleteChat, isRunning, newChat, openChat, send, setSettings, stop, useChatState } from "./store";
import { startFor } from "./targets";

// The shared test chat (C15-C17, C23, C27, C33): one chat at a time, no
// tabs; earlier chats in the title's dropdown; every setting behind the
// composer's model button. The shell renders <ChatPanel mode="sheet" /> on
// the right and /chat renders <ChatPanel mode="page" /> (phones, Expand).

/** The last Test button handled, so remounting the panel does not start its chat again. */
let handledSeq = 0;

export function ChatPanel({ mode }: { mode: "sheet" | "page" }) {
  const panel = useChatPanel();
  const navigate = useNavigate();
  const phone = useIsPhone();
  const state = useChatState();
  const chat = currentChat(state);

  useEffect(() => {
    const { seq, target } = panel.request;
    if (!target || seq <= handledSeq) return;
    handledSeq = seq;
    startFor(target).catch((e) => notify.failure("Couldn't set up the chat", e));
  }, [panel.request]);

  useEffect(() => {
    if (!chat) newChat();
  }, [chat]);

  if (!chat) return <div className="h-full bg-subtle" />;
  const earlier = state.chats.filter((c) => c.turns.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-subtle">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3">
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-muted" aria-label={`${chat.title}. Earlier chats`}>
              <h2 className="truncate text-[15px] font-semibold">{chat.title}</h2>
              <ChevronDown size={16} className="shrink-0 text-fg-muted" />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="max-h-[60dvh] w-[min(340px,calc(100vw-32px))] overflow-y-auto">
            <MenuLabel>Earlier chats</MenuLabel>
            {earlier.length === 0 && <p className="px-2 py-2 text-[13.5px] text-fg-muted">Chats you send show here, in this browser.</p>}
            {earlier.map((c) => (
              <MenuItem key={c.id} onSelect={() => openChat(c.id)}>
                <span className="flex min-w-0 items-center gap-2">
                  {c.settings.model && <ModelTile model={c.settings.model} size={18} />}
                  <span className={cn("min-w-0 flex-1 truncate", c.id === chat.id && "font-semibold")}>{c.title}</span>
                  <span className="shrink-0 pl-2 text-[12px] text-fg-subtle">{timeAgo(new Date(c.updatedAt))}</span>
                </span>
              </MenuItem>
            ))}
            {chat.turns.length > 0 && (
              <>
                <MenuSeparator />
                <MenuItem icon={Trash2} danger onSelect={() => deleteChat(chat.id)}>
                  Delete this chat
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        <div className="flex-1" />
        <IconButton icon={SquarePen} label="New chat" size="sm" onClick={() => newChat()} />
        {mode === "sheet" ? (
          <>
            <IconButton
              icon={Maximize2}
              label="Full page"
              size="sm"
              onClick={() => {
                panel.close();
                navigate("/chat");
              }}
            />
            <IconButton icon={X} label="Close" size="sm" onClick={panel.close} />
          </>
        ) : (
          !phone && (
            <IconButton
              icon={Minimize2}
              label="Back to the side panel"
              size="sm"
              onClick={() => {
                navigate(-1);
                panel.open();
              }}
            />
          )
        )}
      </header>
      <ChatBody key={chat.id} chat={chat} running={state.running > 0 && isRunning(chat.id)} wide={mode === "page" && !phone} />
    </div>
  );
}

function ChatBody({ chat, running, wide }: { chat: Chat; running: boolean; wide: boolean }) {
  const [text, setText] = useState(chat.draft ?? "");
  const [picker, setPicker] = useState<View | null>(null);
  const [snippets, setSnippets] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const s = chat.settings;
  const change = (patch: Partial<Settings>) => setSettings(chat.id, patch);

  // Follow the reply while it streams, unless the Owner scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const submit = (t = text) => {
    const v = t.trim();
    if (!v || running) return;
    if (!s.model) {
      setPicker("models");
      return;
    }
    if (t === text) setText("");
    stick.current = true;
    void send(chat.id, v);
  };

  const lastUser = [...chat.turns].reverse().find((t) => t.role === "user");
  const column = cn("mx-auto w-full", wide && "max-w-[760px]");

  return (
    <>
      {s.as && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/50 px-4 py-2.5">
          <KeyRound size={18} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] font-medium">Sending as {s.as}</span>
            <span className="block truncate text-[13px] text-fg-muted">Shows in Requests as Test (as {s.as})</span>
          </span>
          <button type="button" data-picker-toggle onClick={() => setPicker((p) => (p ? null : "as"))} className="shrink-0 text-[14.5px] font-medium text-info hover:underline">
            Change
          </button>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
      >
        <div className={cn(column, "flex min-h-full flex-col gap-5")}>
          {chat.origin && (
            <p className="flex items-center justify-center gap-1.5 text-[13.5px] text-fg-muted">
              <Link2 size={14} className="shrink-0" /> <span className="truncate">Opened from {chat.origin}</span>
            </p>
          )}
          {chat.system && (
            <details className="rounded-lg border border-border bg-bg px-3 py-2 text-[13.5px]">
              <summary className="cursor-pointer text-fg-muted">System prompt</summary>
              <p className="mt-1.5 whitespace-pre-wrap break-words">{chat.system}</p>
            </details>
          )}
          {chat.turns.length === 0 ? (
            <Empty
              chat={chat}
              onPrompt={(prompt, patch) => {
                if (patch) change(patch);
                // Settings land in the store first; send reads them from there.
                queueMicrotask(() => submit(prompt));
              }}
            />
          ) : (
            chat.turns.map((t) =>
              t.role === "user" ? (
                <div key={t.id} className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed">
                  {t.text}
                </div>
              ) : (
                <Reply key={t.id} turn={t} />
              ),
            )
          )}
        </div>
      </div>
      <div className="shrink-0 px-3 pb-3 pt-1">
        <div className={cn(column, "relative")}>
          {picker && (
            <Popover onClose={() => setPicker(null)}>
              <Picker settings={s} onChange={change} initial={picker} onClose={() => setPicker(null)} />
            </Popover>
          )}
          <div className="rounded-2xl border border-border-strong bg-bg px-3 pb-2 pt-2.5 shadow-sm focus-within:border-info">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder={s.model ? `Message ${bareModel(s.model)}` : "Pick a model to start"}
              aria-label="Message"
              className="block max-h-[200px] min-h-[28px] w-full resize-none bg-transparent px-1 text-base leading-relaxed outline-none [field-sizing:content] placeholder:text-fg-subtle md:text-[15px]"
            />
            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                data-picker-toggle
                onClick={() => setPicker((p) => (p ? null : s.model ? "main" : "models"))}
                aria-expanded={!!picker}
                aria-label={s.model ? `Model ${s.model}. Settings` : "Pick a model"}
                className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg bg-muted/70 px-2 text-[14px] font-medium hover:bg-muted"
              >
                {s.model && <ModelTile model={s.model} size={18} />}
                <span className="truncate">{s.model ? bareModel(s.model) : "Pick a model"}</span>
                <ChevronDown size={14} className="shrink-0 text-fg-muted" />
              </button>
              <button
                type="button"
                aria-pressed={s.toolCheck}
                onClick={() => change({ toolCheck: !s.toolCheck })}
                title="Offer a test tool and check the call"
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[14px]",
                  s.toolCheck ? "border-info/40 bg-info/10 text-info" : "border-border text-fg hover:bg-muted",
                )}
              >
                <Wrench size={14} /> Tools
              </button>
              <IconButton icon={Code2} label="Use from code" size="sm" disabled={!s.model} onClick={() => setSnippets(true)} />
              <div className="flex-1" />
              {running ? (
                <button type="button" onClick={() => stop(chat.id)} aria-label="Stop" title="Stop" className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg">
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => submit()}
                  disabled={!text.trim()}
                  aria-label="Send"
                  title="Send"
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg disabled:bg-muted disabled:text-fg-subtle"
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <SnippetDialog open={snippets} onOpenChange={setSnippets} settings={s} prompt={text.trim() || (lastUser?.role === "user" ? lastUser.text : "")} />
    </>
  );
}

/** The settings popover above the composer; closes on a click outside it (its toggles excepted, they close it themselves). */
function Popover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || ref.current?.contains(t) || t.closest("[data-picker-toggle]")) return;
      // Radix portals (menus, dialogs) opened from inside the picker are not outside.
      if (t.closest("[data-radix-popper-content-wrapper],[role=dialog][data-state]")) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <div ref={ref} className="absolute inset-x-0 bottom-full z-20 mb-2">
      {children}
    </div>
  );
}

function Empty({ chat, onPrompt }: { chat: Chat; onPrompt: (prompt: string, patch?: Partial<Settings>) => void }) {
  const s = chat.settings;
  const who = s.as ?? (s.model ? bareModel(s.model) : "a model");
  return (
    <div className="m-auto flex max-w-[360px] flex-col items-center py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-fg-muted">{s.as ? <KeyRound size={20} /> : <MessageCircle size={20} />}</span>
      <h3 className="mt-4 text-[18px] font-semibold">Test {who}</h3>
      <p className="mt-2 text-[14.5px] leading-relaxed text-fg-muted">
        {s.as
          ? `Messages go through Iroha with this key's access, so only the models it allows can answer. They show in Requests as Test (as ${s.as}) and never count as its traffic.`
          : "Messages go through Iroha exactly as a Caller's would, and show in Requests as Test."}
      </p>
      {s.model ? (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Chip onClick={() => onPrompt("Reply with one short sentence so I know you work.")}>Say hello</Chip>
          <Chip onClick={() => onPrompt("What's the weather in Hanoi right now? Use the tool.", s.toolCheck ? undefined : { toolCheck: true })}>Call a tool</Chip>
          <Chip onClick={() => onPrompt("Which is larger, 9.11 or 9.9? Think it through, then answer in one line.", s.reasoning === "off" ? { reasoning: "medium" } : undefined)}>
            Think it through
          </Chip>
        </div>
      ) : (
        <p className="mt-4 text-[13.5px] text-fg-muted">Pick a model with the button below first.</p>
      )}
    </div>
  );
}

function Chip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-9 rounded-full border border-border-strong bg-bg px-4 text-[14.5px] hover:bg-muted">
      {children}
    </button>
  );
}
