import type { MouseEvent, ReactElement, ReactNode } from "react";
import { cloneElement, useCallback, useState } from "react";
import { ConfirmDialog, TypeToConfirmDialog } from "./Dialog";

export type ConfirmQuestion = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | void;
  typeToConfirm?: string;
  agentConfirm?: string;
};

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
