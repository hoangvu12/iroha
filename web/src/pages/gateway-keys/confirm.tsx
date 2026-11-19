import { ConfirmDialog, TypeToConfirmDialog } from "@/ui/Dialog";
import { notifyChange } from "@/ui/toast";
import { type GatewayKey, useDeleteKey, useInvalidateKeys, useRevokeKey } from "./api";

// Revoke asks for the name typed (it can't be undone); delete names what
// goes and is undone from its toast, through the Audit Entry (C25).

export function RevokeDialog({ k, onClose, onDone }: { k?: GatewayKey; onClose: () => void; onDone?: () => void }) {
  const revoke = useRevokeKey();
  return (
    <TypeToConfirmDialog
      open={!!k}
      onOpenChange={(o) => !o && onClose()}
      title={`Revoke ${k?.name ?? ""}?`}
      body="Callers using this key get 401 straight away. A revoked key can't be turned back on; its name stays on record."
      name={k?.name ?? ""}
      confirmLabel="Revoke key"
      onConfirm={async () => {
        if (!k) return;
        const res = await revoke.mutateAsync(k.id);
        // Toast: the confirm dialog has closed.
        notifyChange(`${k.name} revoked`, res, { undoable: false });
        onDone?.();
      }}
    />
  );
}

export function DeleteDialog({ k, onClose, onDone }: { k?: GatewayKey; onClose: () => void; onDone?: () => void }) {
  const del = useDeleteKey();
  const invalidate = useInvalidateKeys();
  return (
    <ConfirmDialog
      open={!!k}
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${k?.name ?? ""}?`}
      body={
        k?.revoked
          ? `${k.name} is removed from the list and its name is free again. Requests already logged keep the name.`
          : `${k?.name ?? ""} stops working and is removed from the list. Requests already logged keep the name. Undo brings it back with the same key.`
      }
      confirmLabel="Delete key"
      onConfirm={async () => {
        if (!k) return;
        const res = await del.mutateAsync(k.id);
        // Toast: the confirm dialog has closed (and the key page navigates away), with Undo after a delete.
        notifyChange(`${k.name} deleted`, res, { undoneMessage: `${k.name} is back`, onUndone: invalidate });
        onDone?.();
      }}
    />
  );
}
