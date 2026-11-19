import type { MouseEvent, ReactElement, ReactNode } from "react";
import { cloneElement, useCallback, useState } from "react";
import { ConfirmDialog, TypeToConfirmDialog } from "./Dialog";

// Destructive actions (UI ticket 21): every trigger that deletes, removes,
// revokes or clears something the Owner saved has the danger tone (`danger`
// on Button, IconButton and MenuItem) and asks first, naming what goes.

export type ConfirmQuestion = {
  /** The question, naming what goes: "Remove gpt-4o from fast?", "Delete 12 keys?". */
  title: string;
  /** What happens, and whether Undo brings it back. */
  body: ReactNode;
  /** Says what the button does ("Remove model"), never "OK". */
  confirmLabel: string;
  /** Runs on confirm; the dialog stays open and pending until it settles, and shows its error. */
  onConfirm: () => Promise<unknown> | void;
  /** Revokes and other changes that can't be undone: the record's name must be typed first. */
  typeToConfirm?: string;
  agentConfirm?: string;
};

/**
 * Asks a ConfirmQuestion from any handler (a menu item, a bulk bar, a row's × button).
 * Render `dialog` once, anywhere in the component; `ask(q)` opens it. When it
 * closes, focus goes back to what had it before (the trigger, or a menu's trigger).
 */
export function useConfirm(): { ask: (q: ConfirmQuestion) => void; dialog: ReactElement } {
  const [question, setQuestion] = useState<ConfirmQuestion>();
  const [open, setOpen] = useState(false);
  const ask = useCallback((q: ConfirmQuestion) => {
    setQuestion(q);
    setOpen(true);
  }, []);
  const q = question;
  const props = {
    open,
    onOpenChange: setOpen,
    title: q?.title ?? "",
    body: q?.body ?? "",
    confirmLabel: q?.confirmLabel ?? "",
    onConfirm: () => q?.onConfirm(),
    agentConfirm: q?.agentConfirm,
  };
  const dialog = (
    // Popups render in place: keep the dialog's clicks from reaching a clickable row around it.
    <div className="contents" onClick={(e) => e.stopPropagation()}>
      {q?.typeToConfirm !== undefined ? <TypeToConfirmDialog {...props} name={q.typeToConfirm} /> : <ConfirmDialog {...props} />}
    </div>
  );
  return { ask, dialog };
}

/**
 * Wraps one trigger (a Button or IconButton with `danger`) so pressing it asks
 * first: `<ConfirmAction title=... confirmLabel=... onConfirm=...><IconButton danger .../></ConfirmAction>`.
 */
export function ConfirmAction({
  children,
  ...question
}: ConfirmQuestion & { children: ReactElement<{ onClick?: (e: MouseEvent<HTMLButtonElement>) => void }> }) {
  const { ask, dialog } = useConfirm();
  const own = children.props.onClick;
  return (
    <>
      {cloneElement(children, {
        onClick: (e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          own?.(e);
          ask(question);
        },
      })}
      {dialog}
    </>
  );
}
