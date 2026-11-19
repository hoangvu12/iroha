import type { ReactNode, Ref } from "react";
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
import { Field, Input } from "./Input";
import { ScrollArea } from "./ScrollArea";
import { isApiError } from "@/api/client";

// Dialogs grow from the middle and dim the page; the content keeps showing
// what it showed while open until its exit has finished. Motion: the "Dialog"
// recipe of architecture.md "UI motion system" (no trigger origin; out faster
// than in; under reduced motion the scale token is 1, so it only fades).

const backdropClass =
  "fixed inset-0 bg-overlay transition-opacity duration-dialog-in ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-dialog-out";

const contentClass = cn(
  "fixed inset-0 m-auto flex h-fit w-[calc(100vw-32px)] max-h-[calc(100dvh-32px)] flex-col",
  "rounded-xl border border-border bg-elevated p-6 text-fg shadow-elevated outline-none",
  "transition-[opacity,scale] duration-dialog-in ease-out data-starting-style:scale-(--motion-scale-popup) data-starting-style:opacity-0",
  "data-ending-style:scale-(--motion-scale-popup) data-ending-style:opacity-0 data-ending-style:duration-dialog-out",
);

const titleClass = "pr-8 text-[17px] font-semibold text-fg";
const descriptionClass = "mt-2 text-sm text-fg-muted";

// Callers often clear the record a dialog is about when it closes; keep the
// last open render on screen while the dialog animates out.
function useWhileOpen<T>(open: boolean, value: T): T {
  const last = useRef(value);
  if (open) last.current = value;
  return open ? value : last.current;
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
  return (
    <SdkDialog open={open} onOpenChange={(o) => onOpenChange(o)}>
      <DialogBackdrop className={backdropClass} />
      <DialogContent style={{ maxWidth: width }} className={contentClass}>
        <DialogTitle className={titleClass}>{shown.title}</DialogTitle>
        {shown.description && (
          <DialogDescription render={<div />} className={descriptionClass}>
            {shown.description}
          </DialogDescription>
        )}
        {shown.children && (
          <ScrollArea className="-mx-6 mt-4 min-h-0 flex-1" contentClassName="px-6 py-0.5">
            {shown.children}
          </ScrollArea>
        )}
        {shown.footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{shown.footer}</div>}
        {closeButton && (
          // An icon button like any other (its press and hover); centred where the old 24 px one was.
          <DialogClose aria-label="Close" className={iconButtonClass("sm", false, "absolute right-3.5 top-3.5")}>
            <X size={16} aria-hidden />
          </DialogClose>
        )}
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
      <AlertDialogContent style={{ maxWidth: 480 }} initialFocus={initialFocus} className={contentClass}>
        <AlertDialogTitle className={titleClass}>{shown.title}</AlertDialogTitle>
        <AlertDialogDescription render={<div />} className={descriptionClass}>
          {shown.body}
        </AlertDialogDescription>
        {shown.children && (
          <ScrollArea className="-mx-6 mt-4 min-h-0 flex-1" contentClassName="px-6 py-0.5">
            {shown.children}
          </ScrollArea>
        )}
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-danger-text transition-opacity duration-list-in ease-out starting:opacity-0">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <AlertDialogClose className={buttonClass("secondary")}>Cancel</AlertDialogClose>
          {/* While onConfirm runs the button dims at once (no spinner, not in the press transition). */}
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
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Confirm only actions that can't be undone or that remove something (C25).
// Name exactly what goes; the confirm button is the only red. The dialog
// stays open, pending, while onConfirm runs, and shows its error if it fails.
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

// Revoke-style confirmation: type the record's name to enable the button (C25).
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
