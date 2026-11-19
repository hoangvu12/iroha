import * as RD from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "./Button";
import { cn } from "./cn";
import { Input } from "./Input";
import { isApiError } from "@/api/client";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 480,
  closeButton = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  closeButton?: boolean;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <RD.Content
          style={{ maxWidth: width }}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "max-h-[calc(100dvh-32px)] overflow-y-auto rounded-xl border border-border bg-elevated p-6 shadow-elevated outline-none",
          )}
        >
          <RD.Title className="pr-8 text-[17px] font-semibold text-fg">{title}</RD.Title>
          {description ? (
            <RD.Description className="mt-2 text-sm text-fg-muted">{description}</RD.Description>
          ) : (
            <RD.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RD.Description>
          )}
          {children && <div className="mt-4">{children}</div>}
          {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
          {closeButton && (
            <RD.Close aria-label="Close" className="absolute right-4 top-4 rounded-md p-1 text-fg-muted hover:bg-muted hover:text-fg">
              <X size={16} />
            </RD.Close>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function errorText(e: unknown): string {
  if (isApiError(e)) return e.hint ? `${e.message} ${e.hint}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Confirm only actions that can't be undone or that remove something
 * (C25). Name exactly what goes; the confirm button is the only red.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  danger = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | void;
  danger?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setPending(true);
    setError(undefined);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(undefined);
        onOpenChange(o);
      }}
      title={title}
      description={body}
      closeButton={false}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} loading={pending} onClick={run}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error && <p className="text-[13px] text-danger-text">{error}</p>}
    </Dialog>
  );
}

/** Revoke-style confirmation: type the record's name to enable the button (C25). */
export function TypeToConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  name,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  body: ReactNode;
  name: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | void;
}) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const close = (o: boolean) => {
    if (!o) {
      setTyped("");
      setError(undefined);
    }
    onOpenChange(o);
  };
  const run = async () => {
    if (typed !== name) return;
    setPending(true);
    setError(undefined);
    try {
      await onConfirm();
      close(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={body}
      closeButton={false}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="danger" loading={pending} disabled={typed !== name} onClick={run}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        className="flex flex-col gap-1.5"
      >
        <label className="text-sm text-fg-muted">
          Type <code className="font-mono text-fg">{name}</code> to confirm
        </label>
        <Input mono autoFocus autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        {error && <p className="text-[13px] text-danger-text">{error}</p>}
      </form>
    </Dialog>
  );
}
