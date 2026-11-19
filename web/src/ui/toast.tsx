import type { ReactNode } from "react";
import { toast, Toaster as SonnerToaster } from "sonner";
import { CircleAlert, CircleCheck, Copy, RotateCcw } from "lucide-react";
import { revertEntry } from "@/api/audit";
import { isApiError } from "@/api/client";
import type { AuditResult } from "@/api/types";

// Toasts: bottom right, 6 s (C25). Every change that can be put back gets
// Undo, which reverts its Audit Entry through the same API agents use.

export const TOAST_MS = 6000;

export function Toaster({ theme }: { theme: "light" | "dark" }) {
  return (
    <SonnerToaster
      position="bottom-right"
      duration={TOAST_MS}
      theme={theme}
      visibleToasts={5}
      expand
      gap={8}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex w-[min(380px,calc(100vw-32px))] items-center gap-2.5 rounded-xl border border-border bg-elevated px-4 py-3 text-sm text-fg shadow-elevated",
          title: "flex-1 font-normal",
          description: "text-[13px] text-fg-muted",
          actionButton: "ml-auto shrink-0 font-medium text-info hover:underline",
          cancelButton: "shrink-0 text-fg-muted",
          icon: "shrink-0",
        },
      }}
    />
  );
}

type Action = { label: string; onClick: () => void };

function show(message: ReactNode, icon: ReactNode, action?: Action, description?: ReactNode) {
  return toast(message, { icon, description, action: action ? { label: action.label, onClick: action.onClick } : undefined });
}

const ok = <CircleCheck size={17} className="text-success" />;
const bad = <CircleAlert size={17} className="text-danger-text" />;

export const notify = {
  /** "3 keys disabled  Undo" */
  success: (message: ReactNode, action?: Action) => show(message, ok, action),
  /** "Couldn't test team-5: 401 Invalid key  Open" */
  error: (message: ReactNode, action?: Action) => show(message, bad, action),
  /** "Base URL copied" */
  copied: (what: string) => show(`${what} copied`, <Copy size={16} className="text-fg-muted" />),
  /** A failed call, worded from its error. */
  failure: (what: string, e: unknown) =>
    show(`${what}: ${isApiError(e) ? e.message : e instanceof Error ? e.message : String(e)}`, bad),
};

/**
 * Toast a change from any mutation response. When it wrote a revertible
 * Audit Entry, the toast offers Undo; undoing toasts "Change reverted" with
 * its own Undo (reverting the revert redoes the change). onUndone runs
 * after each revert so the page can refetch.
 */
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
    show(
      message,
      <RotateCcw size={16} className="text-fg-muted" />,
      again ? { label: "Undo", onClick: () => void undo(again, "Change restored", onUndone) } : undefined,
    );
  } catch (e) {
    notify.failure("Couldn't undo", e);
  }
}

export { toast };
