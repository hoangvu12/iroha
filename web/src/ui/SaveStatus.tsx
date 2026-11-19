import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "@ui-sdk/core";
import { CircleAlert, CircleCheck, RotateCcw } from "lucide-react";
import { revertEntry } from "@/api/audit";
import { isApiError } from "@/api/client";
import { Button } from "./Button";
import { cn } from "./cn";
import { notify, notifyChange } from "./toast";

// Results of inline changes show on the control that made them (spec:
// "Results show where they happened"): a field, a switch, a toolbar or a
// dialog that stays open. useSave runs the change and keeps its state;
// SaveStatus shows "Saving…", then the result with Undo when the change wrote
// a revertible Audit Entry; SaveError shows a failure under the field. A
// toast is only for results whose place is gone (toastDone).

/** How long a result stays when there is nothing to undo, and when there is. */
export const DONE_MS = 2500;
export const UNDO_MS = 6000;

type Action = { label: string; onClick: () => void };

/** A finished change: what to say, the Audit Entry Undo reverts, and an optional second action ("Details"). */
export type Done = { message: string; entry?: string; tone?: "ok" | "bad"; action?: Action; undone?: boolean };

type RunOptions<R> = {
  message?: string | ((r: R) => string | Done);
  undoable?: boolean;
  /** Shows no result here: the change's place goes away and `fn` toasts it. */
  quiet?: boolean;
};

export type Save = {
  pending: boolean;
  done?: Done;
  error?: string;
  /**
   * Runs a change; resolves true when it worked. `message` words the result
   * ("Saved" by default). `undoable: false` drops Undo, for a switch, which
   * undoes itself.
   */
  run<R>(fn: () => Promise<R>, opts?: RunOptions<R>): Promise<boolean>;
  /** Shows a result worked out elsewhere. */
  show(d: Done): void;
  undo(): Promise<void>;
  clear(): void;
  /** Keeps the result on screen while the pointer or focus is on it. */
  hold(on: boolean): void;
};

/** "team-6 is taken. Pick another name." */
export function describeError(e: unknown): string {
  if (isApiError(e)) return e.hint ? `${e.message} ${e.hint}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

const entryOf = (r: unknown) => (r && typeof r === "object" && "audit_entry" in r ? (r as { audit_entry?: string }).audit_entry : undefined);

export function useSave({ refresh, describe = describeError }: { refresh?: () => unknown; describe?: (e: unknown) => string } = {}): Save {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<Done>();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false);
  const shown = useRef<Done>(undefined);
  const busy = useRef(false);
  const opts = useRef({ refresh, describe });
  opts.current = { refresh, describe };
  useEffect(() => () => clearTimeout(timer.current), []);

  const schedule = useCallback((d: Done) => {
    clearTimeout(timer.current);
    if (held.current) return;
    timer.current = setTimeout(() => setDone(undefined), d.entry || d.action || d.tone === "bad" ? UNDO_MS : DONE_MS);
  }, []);

  const show = useCallback(
    (d: Done) => {
      shown.current = d;
      setError(undefined);
      setDone(d);
      announce(d.message, d.tone === "bad" ? { priority: "assertive" } : undefined);
      schedule(d);
    },
    [schedule],
  );

  const fail = useCallback((e: unknown, prefix = "") => {
    clearTimeout(timer.current);
    setDone(undefined);
    setError(prefix + opts.current.describe(e));
  }, []);

  const run = useCallback(
    async <R,>(fn: () => Promise<R>, o: RunOptions<R> = {}) => {
      if (busy.current) return false;
      busy.current = true;
      clearTimeout(timer.current);
      setPending(true);
      setDone(undefined);
      setError(undefined);
      try {
        const res = await fn();
        await opts.current.refresh?.();
        const m = typeof o.message === "function" ? o.message(res) : o.message;
        if (o.quiet) return true;
        const entry = o.undoable === false ? undefined : entryOf(res);
        const d: Done = typeof m === "object" ? { entry, ...m } : { message: m ?? "Saved", entry };
        show(d);
        return true;
      } catch (e) {
        fail(e);
        return false;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [show, fail],
  );

  const undo = useCallback(async () => {
    const entry = shown.current?.entry;
    if (!entry || busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const res = await revertEntry(entry);
      await opts.current.refresh?.();
      show({ message: shown.current?.undone ? "Change restored" : "Change reverted", entry: res.audit_entry, undone: !shown.current?.undone });
    } catch (e) {
      fail(e, "Couldn't undo: ");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [show, fail]);

  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setDone(undefined);
    setError(undefined);
  }, []);

  const hold = useCallback(
    (on: boolean) => {
      held.current = on;
      if (on) clearTimeout(timer.current);
      else if (shown.current) schedule(shown.current);
    },
    [schedule],
  );

  return { pending, done, error, run, show, undo, clear, hold };
}

/**
 * The result of a change, next to the control that made it: "Saving…", then
 * "✓ Renamed to team-6  Undo". Renders nothing when idle.
 */
export function SaveStatus({ save, className, saving = true }: { save: Save; className?: string; saving?: boolean }) {
  const d = save.done;
  if (save.pending && saving && !d) return <span className={cn("whitespace-nowrap text-[13px] text-fg-subtle", className)}>Saving…</span>;
  if (!d) return null;
  const Icon = d.tone === "bad" ? CircleAlert : d.undone ? RotateCcw : CircleCheck;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-[13px] text-fg-muted",
        "transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none",
        d.tone === "bad" && "text-danger-text",
        className,
      )}
      onPointerEnter={() => save.hold(true)}
      onPointerLeave={() => save.hold(false)}
      onFocus={() => save.hold(true)}
      onBlur={() => save.hold(false)}
    >
      <Icon size={15} aria-hidden className={cn("shrink-0", d.tone === "bad" ? "text-danger-text" : d.undone ? "text-fg-muted" : "text-success")} />
      <span className="min-w-0">{d.message}</span>
      {d.action && (
        <Button size="sm" variant="ghost" className="h-6 px-1.5 font-medium text-info" onClick={d.action.onClick}>
          {d.action.label}
        </Button>
      )}
      {d.entry && (
        <Button size="sm" variant="ghost" className="h-6 px-1.5 font-medium text-info" aria-label={`Undo: ${d.message}`} loading={save.pending} onClick={() => void save.undo()}>
          Undo
        </Button>
      )}
    </span>
  );
}

/** A failed change, under the field that made it. */
export function SaveError({ save, className }: { save: Save; className?: string }) {
  if (!save.error) return null;
  return (
    <p role="alert" className={cn("text-[13px] text-danger-text", className)}>
      {save.error}
    </p>
  );
}

/**
 * A result whose place is gone (its menu or dialog closed, the page moved on):
 * the toast, with Undo when it wrote a revertible Audit Entry.
 */
export function toastDone(d: Done, onUndone?: () => void) {
  if (d.tone === "bad") return notify.error(d.message, d.action);
  if (d.entry && !d.action) return notifyChange(d.message, { audit_entry: d.entry }, { onUndone });
  return notify.success(d.message, d.action);
}
