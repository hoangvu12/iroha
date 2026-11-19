import type { ReactNode } from "react";
import { OverlayHost } from "@ui-sdk/react/overlays";
import { Toast, ToastAction, ToastDescription, ToastTitle, toast } from "@ui-sdk/react/toast";
import { CircleAlert, CircleCheck, RotateCcw } from "lucide-react";
import { revertEntry } from "@/api/audit";
import { isApiError } from "@/api/client";
import type { AuditResult } from "@/api/types";
import { cn } from "./cn";

// Toasts: bottom right, 6 s (C25), only for a result whose place is gone (a
// menu or dialog that closed, a page that moved on, a background job) or an
// error with nowhere else to go; anything else shows where it happened
// (CopyButton, SaveStatus). Every change that can be put back gets Undo,
// which reverts its Audit Entry through the same API agents use.

export const TOAST_MS = 6000;

type Icon = "ok" | "bad" | "undo";

const icons: Record<Icon, ReactNode> = {
  ok: <CircleCheck size={17} aria-hidden className="shrink-0 text-success" />,
  bad: <CircleAlert size={17} aria-hidden className="shrink-0 text-danger-text" />,
  undo: <RotateCcw size={16} aria-hidden className="shrink-0 text-fg-muted" />,
};

// Mounted once at the root: renders the toasts (and any confirm()).
export function Toaster() {
  return (
    <OverlayHost
      toast={{
        side: "bottom",
        align: "end",
        maxVisible: 5,
        expanded: true,
        // Typed props leave out data attributes; the region passes them on.
        ...({ "data-agent-hidden": true } as object),
        className: cn(
          "fixed bottom-4 right-4 w-[min(380px,calc(100vw-32px))]",
          "h-[calc(var(--toast-stack-height)+(var(--toast-count)-1)*8px)] transition-[height] duration-toast ease-[ease] motion-reduce:transition-none",
        ),
        // Motion ("Toast" recipe, architecture.md "UI motion system"): a new
        // toast rises one own height from the bottom edge while the older ones
        // move up on the same frame and curve; one that times out or is acted
        // on fades in place; a swiped one follows the finger (no transition)
        // and keeps going the way it was thrown. Under reduced motion only
        // opacity transitions: nothing slides, a swiped toast fades where it was let go.
        children: (item) => (
          <Toast
            className={cn(
              "absolute inset-x-0 bottom-0 flex h-(--toast-height) select-none items-center gap-2.5 rounded-xl border border-border bg-elevated px-4 py-3 text-sm text-fg shadow-elevated",
              "translate-x-(--toast-swipe-x,0px) translate-y-[calc(var(--toast-swipe-y,0px)-var(--toast-offset)-var(--toast-index)*8px)]",
              "transition-[translate,opacity,height] duration-toast ease-[ease] data-swiping:transition-none",
              "data-starting-style:translate-y-(--motion-toast-offset) data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-opacity",
              "motion-safe:data-[swipe-direction=right]:translate-x-full motion-safe:data-[swipe-direction=down]:translate-y-[calc(100%-var(--toast-offset)-var(--toast-index)*8px)]",
            )}
          >
            {icons[((item.data as { icon?: Icon } | undefined)?.icon ?? "ok") as Icon]}
            <div className="min-w-0 flex-1">
              <ToastTitle className="font-normal" />
              <ToastDescription className="text-[13px] text-fg-muted" />
            </div>
            <ToastAction className="ml-auto shrink-0 font-medium text-info hover:underline data-pending:opacity-60" />
          </Toast>
        ),
      }}
    />
  );
}

type Action = { label: string; onClick: () => void };

function show(message: ReactNode, icon: Icon, action?: Action) {
  return toast(message, {
    type: icon === "bad" ? "error" : icon === "ok" ? "success" : "default",
    duration: TOAST_MS,
    data: { icon },
    action: action ? { label: action.label, onAction: () => action.onClick() } : undefined,
  });
}

export const notify = {
  // "3 keys disabled  Undo"
  success: (message: ReactNode, action?: Action) => show(message, "ok", action),
  // "Couldn't test team-5: 401 Invalid key  Open"
  error: (message: ReactNode, action?: Action) => show(message, "bad", action),
  // A failed call, worded from its error.
  failure: (what: string, e: unknown) => show(`${what}: ${isApiError(e) ? e.message : e instanceof Error ? e.message : String(e)}`, "bad"),
};

// Toast a change from any mutation response. When it wrote a revertible
// Audit Entry, the toast offers Undo; undoing toasts "Change reverted" with
// its own Undo (reverting the revert redoes the change). onUndone runs after
// each revert so the page can refetch.
export function notifyChange(
  message: ReactNode,
  result: Pick<AuditResult, "audit_entry">,
  opts: { undoable?: boolean; undoneMessage?: string; onUndone?: () => void } = {},
) {
  const entry = result.audit_entry;
  if (!entry || opts.undoable === false) return notify.success(message);
  const undone = opts.undoneMessage ? `Change reverted: ${opts.undoneMessage}` : "Change reverted";
  return notify.success(message, { label: "Undo", onClick: () => void undo(entry, undone, opts.onUndone) });
}

async function undo(entry: string, message: string, onUndone?: () => void) {
  try {
    const res = await revertEntry(entry);
    onUndone?.();
    const again = res.audit_entry;
    show(message, "undo", again ? { label: "Undo", onClick: () => void undo(again, "Change restored", onUndone) } : undefined);
  } catch (e) {
    notify.failure("Couldn't undo", e);
  }
}
