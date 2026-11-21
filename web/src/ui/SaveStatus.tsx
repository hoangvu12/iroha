import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "@ui-sdk/core";
import { CircleAlert, CircleCheck, RotateCcw } from "lucide-react";
import { revertEntry } from "@/api/audit";
import { errorText } from "@/api/client";
import { Button } from "./Button";
import { cn } from "./cn";
import { useLeaving } from "./presence";
import { notify, notifyChange } from "./toast";

export const DONE_MS = 2500;
export const UNDO_MS = 6000;

type Action = { label: string; onClick: () => void };

export type Done = { message: string; entry?: string; tone?: "ok" | "bad"; action?: Action; undone?: boolean };

type RunOptions<R> = {
  message?: string | ((r: R) => string | Done);
  undoable?: boolean;
  quiet?: boolean;
};

export type Save = {
  pending: boolean;
  done?: Done;
  error?: string;
  run<R>(fn: () => Promise<R>, opts?: RunOptions<R>): Promise<boolean>;
  show(d: Done): void;
  undo(): Promise<void>;
  clear(): void;
  hold(on: boolean): void;
};

export const describeError = errorText;

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

export function SaveStatus({ save, className, saving = true }: { save: Save; className?: string; saving?: boolean }) {
  const result = useLeaving<Done, HTMLSpanElement>(save.done);
  if (save.pending && saving && !save.done) return <span className={cn("whitespace-nowrap text-[13px] text-fg-subtle", className)}>Saving…</span>;
  const d = result.shown;
  if (!d) return null;
  const Icon = d.tone === "bad" ? CircleAlert : d.undone ? RotateCcw : CircleCheck;
  return (
    <span
      ref={result.ref}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-[13px] text-fg-muted",
        "transition-opacity duration-fade ease-out starting:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-list-out",
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

export function SaveError({ save, error, className }: { save: Save; error?: string | null; className?: string }) {
  const text = error || save.error;
  if (!text) return null;
  return (
    <p role="alert" className={cn("text-[13px] text-danger-text", className)}>
      {text}
    </p>
  );
}

export function toastDone(d: Done, onUndone?: () => void) {
  if (d.tone === "bad") return notify.error(d.message, d.action);
  if (d.entry && !d.action) return notifyChange(d.message, { audit_entry: d.entry }, { onUndone });
  return notify.success(d.message, d.action);
}

export function UndoCreate({ save, entry, name, deleted, onClose }: { save: Save; entry?: string; name: string; deleted: string; onClose: () => void }) {
  if (!entry) return null;
  const undo = async () => {
    if (await save.run(() => revertEntry(entry))) {
      onClose();
      notify.success(deleted);
    }
  };
  return (
    <Button variant="ghost" icon={RotateCcw} className="mr-auto" aria-label={`Undo: delete ${name}`} loading={save.pending} onClick={() => void undo()}>
      Undo
    </Button>
  );
}
