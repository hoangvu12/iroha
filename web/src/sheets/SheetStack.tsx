import type { ComponentType, CSSProperties, KeyboardEvent } from "react";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent } from "@ui-sdk/react/dialog";
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

type Shown = { entry: SheetEntry; open: boolean; depth: number };

/** Open sheets first, in stack order; sheets that just closed stay after them until their exit ends. */
function merge(prev: Shown[], stack: SheetEntry[]): Shown[] {
  const ids = new Set(stack.map((e) => e.id));
  const open = stack.map((entry, i) => ({ entry, open: true, depth: stack.length - 1 - i }));
  const leaving = prev.filter((s) => !ids.has(s.entry.id)).map((s) => ({ ...s, open: false }));
  return [...open, ...leaving];
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
 * and stay mounted. Phones show only the top sheet, full width. `right`
 * leaves room for the chat panel.
 */
export function SheetStack({ right = 0 }: { right?: number }) {
  const sheets = useSheets();
  const { stack, close } = sheets;
  const phone = useIsPhone();
  const viewport = useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1280);

  const [view, setView] = useState(() => ({ stack, shown: merge([], stack) }));
  let shown = view.shown;
  if (view.stack !== stack) {
    shown = merge(view.shown, stack);
    setView({ stack, shown });
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

  const room = viewport - (phone ? 0 : right);
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
        style={{ "--sheet-depth": depth, width, right: phone ? 0 : right } as CSSProperties}
        onGone={() => setView((v) => ({ ...v, shown: v.shown.filter((s) => s.open || s.entry.id !== entry.id) }))}
      />
    );
  });
}

function SheetFrame({
  entry,
  index,
  open,
  top,
  depth,
  away,
  style,
  onGone,
}: {
  entry: SheetEntry;
  index: number;
  open: boolean;
  top: boolean;
  depth: number;
  away: boolean;
  style: CSSProperties;
  onGone: () => void;
}) {
  const sheets = useSheets();
  const Body = bodies[entry.record.kind] as ComponentType<SheetBodyProps>;
  // A closed sheet keeps its last record on screen while it slides out.
  const last = useRef({ index, record: entry.record });
  if (open) last.current = { index, record: entry.record };

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
        data-depth={depth}
        data-top={top || undefined}
        initialFocus="content"
        finalFocus={focusAfter}
        inert={away || undefined}
        onKeyDown={onKeyDown}
        style={style}
        className={cn(
          "fixed inset-y-0 left-auto m-0 flex h-dvh max-h-none max-w-full flex-col border-l border-border bg-bg text-fg shadow-elevated outline-none",
          "translate-x-[calc(var(--sheet-depth)*-100%)] transition-[translate] duration-200 ease-out motion-reduce:transition-none",
          "data-starting-style:translate-x-full data-ending-style:translate-x-full",
          away && "invisible",
        )}
      >
        <SheetLevel value={last.current.index}>
          <Suspense
            fallback={
              <>
                <SheetBar kind={kindLabel[last.current.record.kind]} />
                <SheetLoading name={`${kindLabel[last.current.record.kind]} ${recordName(last.current.record)}`} />
              </>
            }
          >
            <Body record={last.current.record} index={last.current.index} top={top} />
          </Suspense>
        </SheetLevel>
      </DialogContent>
    </Dialog>
  );
}
