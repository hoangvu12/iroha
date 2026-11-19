import type { ConfirmQuestion } from "@/ui/Confirm";
import { ConfirmDialog, TypeToConfirmDialog } from "@/ui/Dialog";
import { notifyChange } from "@/ui/toast";
import { type GatewayKey, useDeleteKey, useInvalidateKeys, useRevokeKey } from "./api";

// Revoke asks for the name typed (it can't be undone); delete names what
// goes and is undone from its toast, through the Audit Entry (C25).
// The list asks them with `useConfirm` (UI ticket 21); the key page's danger
// zone renders them as dialogs.

/** The questions Revoke… and Delete… ask, for `confirm.ask(...)`. */
export function useKeyQuestions() {
  const revokeKey = useRevokeKey();
  const del = useDeleteKey();
  const invalidate = useInvalidateKeys();
  return {
    revoke: (k: GatewayKey, onDone?: () => void): ConfirmQuestion => ({
      title: `Revoke ${k.name}?`,
      body: "Callers using this key get 401 straight away. A revoked key can't be turned back on; its name stays on record.",
      typeToConfirm: k.name,
      confirmLabel: "Revoke key",
      onConfirm: async () => {
        const res = await revokeKey.mutateAsync(k.id);
        // Toast: the confirm dialog has closed (and the row has moved to Revoked keys).
        notifyChange(`${k.name} revoked`, res, { undoable: false });
        onDone?.();
      },
    }),
    remove: (k: GatewayKey, onDone?: () => void): ConfirmQuestion => ({
      title: `Delete ${k.name}?`,
      body: k.revoked
        ? `${k.name} is removed from the list and its name is free again. Requests already logged keep the name.`
        : `${k.name} stops working and is removed from the list. Requests already logged keep the name. Undo brings it back with the same key.`,
      confirmLabel: "Delete key",
      onConfirm: async () => {
        const res = await del.mutateAsync(k.id);
        // Toast: the confirm dialog has closed and the row is gone (or the key page navigates away), with Undo after a delete.
        notifyChange(`${k.name} deleted`, res, { undoneMessage: `${k.name} is back`, onUndone: invalidate });
        onDone?.();
      },
    }),
  };
}

const NONE: ConfirmQuestion = { title: "", body: "", confirmLabel: "", onConfirm: () => {} };

export function RevokeDialog({ k, onClose, onDone }: { k?: GatewayKey; onClose: () => void; onDone?: () => void }) {
  const ask = useKeyQuestions();
  const q = k ? ask.revoke(k, onDone) : NONE;
  return <TypeToConfirmDialog open={!!k} onOpenChange={(o) => !o && onClose()} title={q.title} body={q.body} confirmLabel={q.confirmLabel} onConfirm={q.onConfirm} name={k?.name ?? ""} />;
}

export function DeleteDialog({ k, onClose, onDone }: { k?: GatewayKey; onClose: () => void; onDone?: () => void }) {
  const ask = useKeyQuestions();
  const q = k ? ask.remove(k, onDone) : NONE;
  return <ConfirmDialog open={!!k} onOpenChange={(o) => !o && onClose()} title={q.title} body={q.body} confirmLabel={q.confirmLabel} onConfirm={q.onConfirm} />;
}
