import type { MouseEvent, ReactNode, Ref } from "react";
import { useRef, useState } from "react";
import { X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog";
import { Dialog as SdkDialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/react/dialog";
import { buttonClass, iconButtonClass } from "./Button";
import { cn } from "./cn";
import { appearClass } from "./motion";
import { Field, Input } from "./Input";
import { isApiError } from "@/api/client";

const backdropClass =
  "fixed inset-0 bg-overlay transition-opacity duration-dialog-in ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-dialog-out";

const contentClass = cn(
  "fixed inset-0 m-0 h-auto max-h-none w-auto max-w-none overflow-y-auto overscroll-contain bg-transparent p-0 text-fg outline-none",
  "transition-[opacity,scale] duration-dialog-in ease-out data-starting-style:scale-(--motion-scale-popup) data-starting-style:opacity-0",
  "data-ending-style:scale-(--motion-scale-popup) data-ending-style:opacity-0 data-ending-style:duration-dialog-out",
);

const frameClass = "flex min-h-full items-center justify-center p-4 pb-[calc(16px+var(--keyboard-inset,0px))] md:py-12";

const panelClass = "relative flex w-full flex-col rounded-xl border border-border bg-elevated p-6 text-fg shadow-elevated";

const titleClass = "pr-8 text-[17px] font-semibold text-fg";
const descriptionClass = "mt-2 text-sm text-fg-muted";

function useWhileOpen<T>(open: boolean, value: T): T {
  const last = useRef(value);
  if (open) last.current = value;
  return open ? value : last.current;
}

// The layer covers the window, so UI SDK sees every press as inside the dialog: a press that starts and ends on the layer or the frame (not its scroll bar) closes it here.
function useAroundPress(close: () => void) {
  const frame = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const around = (e: MouseEvent<HTMLElement>) => {
    const layer = e.currentTarget;
    if (e.target !== layer && e.target !== frame.current) return false;
    const bar = layer.offsetWidth - layer.clientWidth;
    return !(bar > 0 && e.clientX >= layer.getBoundingClientRect().right - bar);
  };
  return {
    frame,
    onPointerDown: (e: MouseEvent<HTMLElement>) => {
      started.current = e.button === 0 && around(e);
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (started.current && around(e)) close();
      started.current = false;
    },
  };
}

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
  const shown = useWhileOpen(open, { title, description, children, footer });
  const { frame, onPointerDown, onClick } = useAroundPress(() => onOpenChange(false));
  return (
    <SdkDialog open={open} onOpenChange={(o) => onOpenChange(o)}>
      <DialogBackdrop className={backdropClass} />
      <DialogContent className={contentClass} onPointerDown={onPointerDown} onClick={onClick}>
        <div ref={frame} className={frameClass}>
          <div data-dialog-panel="" style={{ maxWidth: width }} className={panelClass}>
            <DialogTitle className={titleClass}>{shown.title}</DialogTitle>
            {shown.description && (
              <DialogDescription render={<div />} className={descriptionClass}>
                {shown.description}
              </DialogDescription>
            )}
            {shown.children && <div className="mt-4">{shown.children}</div>}
            {shown.footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{shown.footer}</div>}
            {closeButton && (
              <DialogClose aria-label="Close" className={iconButtonClass("sm", false, "absolute right-3.5 top-3.5")}>
                <X size={16} aria-hidden />
              </DialogClose>
            )}
          </div>
        </div>
      </DialogContent>
    </SdkDialog>
  );
}

function errorText(e: unknown): string {
  if (isApiError(e)) return e.hint ? `${e.message} ${e.hint}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

function Confirmation({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  danger,
  agentConfirm,
  disabled,
  children,
  onClosed,
  confirmRef,
  initialFocus,
}: {
  initialFocus?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | void;
  danger: boolean;
  agentConfirm?: string;
  disabled?: boolean;
  children?: ReactNode;
  onClosed?: () => void;
  confirmRef?: Ref<HTMLButtonElement>;
}) {
  const [error, setError] = useState<string>();
  const shown = useWhileOpen(open, { title, body, confirmLabel, children });
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => onOpenChange(o)}
      onOpenChangeComplete={(o) => {
        if (o) return;
        setError(undefined);
        onClosed?.();
      }}
    >
      <AlertDialogBackdrop className={backdropClass} />
      <AlertDialogContent initialFocus={initialFocus} className={contentClass}>
        <div className={frameClass}>
          <div data-dialog-panel="" style={{ maxWidth: 480 }} className={panelClass}>
            <AlertDialogTitle className={titleClass}>{shown.title}</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className={descriptionClass}>
              {shown.body}
            </AlertDialogDescription>
            {shown.children && <div className="mt-4">{shown.children}</div>}
            {error && (
              <p role="alert" className={cn("mt-4 text-[13px] text-danger-text", appearClass)}>
                {error}
              </p>
            )}
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <AlertDialogClose className={buttonClass("secondary")}>Cancel</AlertDialogClose>
              <AlertDialogClose
                ref={confirmRef}
                value="confirm"
                disabled={disabled}
                data-agent-confirm={agentConfirm ?? (typeof title === "string" ? title : confirmLabel)}
                className={buttonClass(danger ? "danger" : "primary", "md", "data-pending:opacity-70")}
                action={async () => {
                  setError(undefined);
                  try {
                    await onConfirm();
                  } catch (e) {
                    setError(errorText(e));
                    throw e;
                  }
                }}
              >
                {shown.confirmLabel}
              </AlertDialogClose>
            </div>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  danger = true,
  agentConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | void;
  danger?: boolean;
  agentConfirm?: string;
}) {
  return (
    <Confirmation
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      onConfirm={onConfirm}
      danger={danger}
      agentConfirm={agentConfirm}
    />
  );
}

export function TypeToConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  name,
  confirmLabel,
  onConfirm,
  agentConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  body: ReactNode;
  name: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | void;
  agentConfirm?: string;
}) {
  const [typed, setTyped] = useState("");
  const confirm = useRef<HTMLButtonElement>(null);
  return (
    <Confirmation
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => setTyped("")}
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      onConfirm={onConfirm}
      danger
      agentConfirm={agentConfirm}
      disabled={typed !== name}
      confirmRef={confirm}
      initialFocus="input"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (typed === name) confirm.current?.click();
        }}
      >
        <Field
          label={
            <span className="font-normal text-fg-muted">
              Type <code className="font-mono text-fg">{name}</code> to confirm
            </span>
          }
        >
          {(p) => <Input {...p} mono autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
      </form>
    </Confirmation>
  );
}
