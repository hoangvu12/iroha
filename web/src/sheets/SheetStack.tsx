import type { ComponentType, CSSProperties, KeyboardEvent } from "react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Dialog, DialogContent } from "@ui-sdk/react/dialog";
import { useChatPanel } from "@/app/chat-panel";
import { CHAT_WIDTH } from "@/app/ChatSheet";
import { useIsPhone } from "@/lib/media";
import { cn } from "@/ui/cn";
import { popupOpen } from "@/ui/popup";
import { kindLabel, recordName, type SheetKind, type SheetRecord } from "./records";
import { SheetBar, SheetLoading } from "./Sheet";
import { type SheetEntry, SheetLevel, useSheets } from "./stack";

/** What a sheet's body receives. */
export type SheetBodyProps<K extends SheetKind = SheetKind> = { record: Extract<SheetRecord, { kind: K }>; index: number; top: boolean };

// Bodies load with the sheet, so the shell does not carry every page's code.
const bodies: { [K in SheetKind]: ComponentType<SheetBodyProps<K>> } = {
  request: lazy(() => import("@/pages/requests/Drawer").then((m) => ({ default: m.RequestSheet }))),
  provider: lazy(() => import("./records/ProviderSheet")),
  key: lazy(() => import("./records/KeySheet")),
  endpoint: lazy(() => import("./records/EndpointSheet")),
  "gateway-key": lazy(() => import("./records/GatewayKeySheet")),
  pool: lazy(() => import("./records/PoolSheet")),
};

export const SHEET_WIDTH = 540;

/**
 * How the last change moves the sheets (`data-motion`): `in` when one opened
 * or the chat slid in (the entrance's duration), `out` when one closed or the
 * chat slid out (the exit's, so the sheet sliding back moves with the one
 * leaving), `instant` for the sheets the page loaded with, the C key and a
 * route change (architecture.md "UI motion system": never animate a key).
 */
type Motion = "in" | "out" | "instant";

type Shown = { entry: SheetEntry; open: boolean; depth: number };

/** Open sheets first, in stack order; sheets that just closed stay after them until their exit ends. */
function merge(prev: Shown[], stack: SheetEntry[]): Shown[] {
  const ids = new Set(stack.map((e) => e.id));
  const open = stack.map((entry, i) => ({ entry, open: true, depth: stack.length - 1 - i }));
  const leaving = prev.filter((s) => !ids.has(s.entry.id)).map((s) => ({ ...s, open: false }));
  return [...open, ...leaving];
}

function moved(prev: SheetEntry[], next: SheetEntry[]): Motion | undefined {
  if (next.length < prev.length) return "out";
  if (next.some((e) => !prev.some((p) => p.id === e.id))) return "in";
  return undefined; // the same sheets: a record or tab swapped in place
}

/**
 * How far the sheets move aside for the chat, and whether that counts the
 * chat as open. A pointer opening the chat starts its slide a frame after it
 * mounts (`animateIn` lifts the starting style on the next frame), so the
 * sheets wait the same frame and start with it: their edges stay together
 * instead of opening a strip of page between them. Everything else (closing,
 * the C key, a route change) moves with the chat at once.
 */
function useChatShift(target: number, chatOpen: boolean, instant: boolean) {
  const [now, setNow] = useState({ shift: target, chatOpen });
  const follow = target > now.shift && chatOpen && !now.chatOpen && !instant;
  if ((target !== now.shift || chatOpen !== now.chatOpen) && !follow) setNow({ shift: target, chatOpen });
  useLayoutEffect(() => {
    if (!follow) return;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => flushSync(() => setNow({ shift: target, chatOpen: true })));
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [follow, target]);
  return now;
}

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

function typingInto(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/**
 * The stack of record sheets (spec "Stacked sheets"): one non-modal UI SDK
 * Dialog per sheet, side by side, newest on the right and focused; older
 * ones step left by one sheet width each, off screen when there is no room,
 * and stay mounted. Phones show only the top sheet, full width. `chat` leaves
 * room for the chat panel while it is open (false on the /chat page): the
 * sheets move aside with it, by translate, on its own timing.
 */
export function SheetStack({ chat = true }: { chat?: boolean }) {
  const sheets = useSheets();
  const { stack, close } = sheets;
  const phone = useIsPhone();
  const panel = useChatPanel();
  const viewport = useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1280);
  const { shift, chatOpen } = useChatShift(chat && panel.isOpen && !phone ? CHAT_WIDTH : 0, panel.isOpen, panel.instant);

  const [view, setView] = useState(() => ({ stack, shift, chatOpen, shown: merge([], stack), motion: "instant" as Motion }));
  let { shown, motion } = view;
  if (view.stack !== stack || view.shift !== shift || view.chatOpen !== chatOpen) {
    // The chat's own open or close slides them with it; a route change or the C key moves them at once.
    if (view.shift !== shift) motion = view.chatOpen === chatOpen || panel.instant ? "instant" : shift > view.shift ? "in" : "out";
    else motion = moved(view.stack, stack) ?? motion;
    shown = view.stack === stack ? shown : merge(view.shown, stack);
    setView({ stack, shift, chatOpen, shown, motion });
  }

  const latest = useRef(stack);
  latest.current = stack;

  // Escape on the page (focus outside every sheet and popup) closes the top sheet, as the drawer did.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || latest.current.length === 0) return;
      const t = e.target as Element | null;
      if (t?.closest?.("[popover]") || typingInto(t) || popupOpen()) return;
      e.preventDefault();
      close();
    };
    // Capture: with a sheet open, UI SDK marks Escape handled even when it leaves the sheet open.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const room = viewport - shift;
  const width = phone ? room : Math.min(SHEET_WIDTH, room);

  return shown.map(({ entry, open, depth }) => {
    const index = stack.findIndex((e) => e.id === entry.id);
    const top = open && index === stack.length - 1;
    // Wholly off screen (or behind the top sheet on a phone): out of reach of Tab and screen readers.
    const away = open && !top && (phone || depth * width >= room);
    return (
      <SheetFrame
        key={entry.id}
        entry={entry}
        index={index}
        open={open}
        top={top}
        depth={depth}
        away={away}
        motion={motion}
        beside={shift > 0}
        style={{ "--sheet-depth": depth, "--sheet-shift": `${shift}px`, width, right: 0 } as CSSProperties}
        onGone={() => setView((v) => ({ ...v, shown: v.shown.filter((s) => s.open || s.entry.id !== entry.id) }))}
      />
    );
  });
}

// The Sheet recipe (architecture.md "UI motion system") for a stack. Each
// sheet rests at `--sheet-depth` widths left of the right edge, less the
// chat's width while it is open (`--sheet-shift`); it enters and leaves along
// the right edge (only the top one travels in: one mounted under it, after a
// reload or Forward, fades in its place), opacity on its own short fade so
// reduced motion (slide tokens at 0) still fades. Every move of one change
// shares `--sheet-move`: the entrance's 300 ms when the stack grows, the
// exit's 240 ms when it shrinks, so a sheet sliding back moves with the one
// leaving. Beside the chat the sheet is clipped by as much as it is moved, so
// it slides out from under the chat rather than over it. A sheet pushed wholly
// off screen keeps painting until its move ends (visibility waits).
const frameClass = cn(
  "fixed inset-y-0 left-auto m-0 flex h-dvh max-h-none max-w-full flex-col border-l border-border bg-bg text-fg shadow-elevated outline-none",
  // Edge to edge on a phone, its content clear of a notch and the home bar (viewport-fit=cover).
  "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] max-md:pl-[env(safe-area-inset-left)]",
  "translate-x-[calc(var(--sheet-depth)*-100%_-_var(--sheet-shift))] [--sheet-move:var(--duration-sheet-in)] [--sheet-hide:0s]",
  "[transition:translate_var(--sheet-move)_var(--ease-drawer),opacity_var(--duration-fade)_var(--ease-out),clip-path_var(--sheet-move)_var(--ease-drawer),visibility_0s_linear_var(--sheet-hide)]",
  "data-[motion=out]:[--sheet-move:var(--duration-sheet-out)] data-ending-style:[--sheet-move:var(--duration-sheet-out)]",
  "data-[motion=instant]:transition-none",
  "data-top:data-starting-style:translate-x-[calc(var(--motion-sheet-offset)_-_var(--sheet-shift))] data-ending-style:translate-x-[calc(var(--motion-sheet-offset)_-_var(--sheet-shift))]",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
  "data-beside:[clip-path:inset(0_0_0_0)] data-beside:data-top:data-starting-style:[clip-path:inset(0_var(--motion-sheet-offset)_0_0)] data-beside:data-ending-style:[clip-path:inset(0_var(--motion-sheet-offset)_0_0)]",
  "data-away:invisible data-away:[--sheet-hide:var(--sheet-move)]",
);

function SheetFrame({
  entry,
  index,
  open,
  top,
  depth,
  away,
  motion,
  beside,
  style,
  onGone,
}: {
  entry: SheetEntry;
  index: number;
  open: boolean;
  top: boolean;
  depth: number;
  away: boolean;
  motion: Motion;
  beside: boolean;
  style: CSSProperties;
  onGone: () => void;
}) {
  const sheets = useSheets();
  const Body = bodies[entry.record.kind] as ComponentType<SheetBodyProps>;
  // A closed sheet keeps its last record on screen while it slides out.
  const last = useRef({ index, record: entry.record });
  if (open) last.current = { index, record: entry.record };
  const { index: shownIndex, record: shownRecord } = last.current;

  // A record opened in this sheet's place (same kind) takes focus, as a new sheet does when it mounts.
  const openedAt = useRef(entry.opened);
  useEffect(() => {
    if (entry.opened === openedAt.current) return;
    openedAt.current = entry.opened;
    if (open) document.querySelector<HTMLElement>(`[data-sheet-id="${entry.id}"]`)?.focus();
  }, [entry.opened, entry.id, open]);

  // Focus goes back to the link that opened the sheet, else into the sheet now on top.
  const focusAfter = () => {
    const o = sheets.opener(entry.id);
    const opener = o instanceof HTMLElement && o.isConnected ? o : null;
    const nowTop = document.querySelector<HTMLElement>("[data-sheet][data-top]");
    if (opener && (!nowTop || nowTop.contains(opener))) return opener;
    return nowTop ?? opener;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // UI SDK sends Escape to the topmost layer only while focus is in it; from an older sheet, close the top one.
    if (e.key !== "Escape" || top || e.defaultPrevented) return;
    if ((e.target as Element).closest("[popover]") !== e.currentTarget) return;
    e.preventDefault();
    sheets.close();
  };

  // The body doesn't re-render when only the stack's motion moves it (the chat coming and going, a sheet above opening).
  const body = useMemo(
    () => (
      <SheetLevel value={shownIndex}>
        <Suspense
          fallback={
            <>
              <SheetBar kind={kindLabel[shownRecord.kind]} />
              <SheetLoading name={`${kindLabel[shownRecord.kind]} ${recordName(shownRecord)}`} />
            </>
          }
        >
          <Body record={shownRecord} index={shownIndex} top={top} />
        </Suspense>
      </SheetLevel>
    ),
    [Body, shownIndex, shownRecord, top],
  );

  return (
    <Dialog
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (next) return;
        if (details.reason === "close-press") sheets.close(index);
        else {
          // Escape and Back close the top sheet only.
          if (!top) details.cancel();
          sheets.close();
        }
      }}
      onOpenChangeComplete={(o) => {
        if (!o) onGone();
      }}
    >
      <DialogContent
        data-sheet=""
        data-sheet-id={entry.id}
        data-depth={depth}
        data-top={top || undefined}
        data-away={away || undefined}
        data-motion={motion}
        data-beside={beside || undefined}
        initialFocus="content"
        finalFocus={focusAfter}
        inert={away || undefined}
        onKeyDown={onKeyDown}
        style={style}
        className={frameClass}
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
