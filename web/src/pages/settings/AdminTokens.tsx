import { useState } from "react";
import { Copy, KeyRound, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { revertEntry } from "@/api/audit";
import { isApiError } from "@/api/client";
import { timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { CopyButton, useCopy } from "@/ui/CopyButton";
import { Mono } from "@/ui/bits";
import { Dialog, TypeToConfirmDialog } from "@/ui/Dialog";
import { Field, Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuIconTrigger } from "@/ui/Menu";
import { EmptyState, ErrorState } from "@/ui/States";
import { Skeleton } from "@/ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/ui/Table";
import { SaveError, useSave } from "@/ui/SaveStatus";
import { notify, notifyChange } from "@/ui/toast";
import { type AdminToken, useAdminTokens, useCreateAdminToken, useInvalidateAll, useRevokeAdminToken } from "./api";
import { lastUsed, shortDate, shortSecret } from "./format";
import { SAMPLE_ADMIN_TOKENS } from "./samples";

/** Settings → Admin Tokens (C28). */
export function AdminTokensTab() {
  const tokens = useAdminTokens();
  const phone = useIsPhone();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AdminToken>();

  return (
    <section aria-label="Admin Tokens">
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p className="text-[15px] text-fg-muted md:text-fg">
          Admin Tokens call the admin API for scripts and agents. They can do anything the Owner can.
        </p>
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)} className="self-start md:self-auto">
          New Admin Token
        </Button>
      </div>

      {tokens.isError ? (
        <ErrorState title="Couldn't load Admin Tokens" error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : (
      <Skeleton data={tokens.data} sample={SAMPLE_ADMIN_TOKENS} id={phone ? "admin-tokens:phone" : "admin-tokens"} label="Loading Admin Tokens">
      {(list) => list.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No Admin Tokens"
          description="Make one for each script or agent that manages Iroha, so each change says who made it."
        />
      ) : (
        <>
          {phone ? (
            <TokenList tokens={list} onRevoke={setRevoking} />
          ) : (
            <TokenTable tokens={list} onRevoke={setRevoking} />
          )}
          <p className="mt-5 text-[13px] text-fg-muted">
            Copy a token whenever a script needs it. Revoke one from its ⋯ menu.
          </p>
        </>
      )}
      </Skeleton>
      )}

      <CreateDialog open={creating} onOpenChange={setCreating} existing={tokens.data ?? []} />
      <RevokeDialog token={revoking} onClose={() => setRevoking(undefined)} />
    </section>
  );
}

function LastUsed({ t }: { t: AdminToken }) {
  const { stale, never } = lastUsed(t.last_used_at, t.created_at);
  return (
    <span
      className={cn(stale && "text-warning")}
      title={stale ? "Not used for a month. Revoke it if nothing needs it any more." : undefined}
    >
      {never ? "Never" : timeAgo(t.last_used_at)}
    </span>
  );
}

function TokenMenu({ t, onRevoke }: { t: AdminToken; onRevoke: (t: AdminToken) => void }) {
  // "Copy token" closes the menu, so the trigger it closes back to shows the result.
  const copied = useCopy();
  return (
    <Menu>
      <MenuIconTrigger icon={MoreHorizontal} label={`More for ${t.name}`} size="sm" copy={copied.state} />
      <MenuContent>
        <MenuItem icon={Copy} onSelect={() => void copied.copy(t.secret, "Admin Token")}>
          Copy token
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={() => onRevoke(t)}>
          Revoke…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function SecretCell({ t }: { t: AdminToken }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Mono className="text-fg-muted">{shortSecret(t.secret)}</Mono>
      <CopyButton icon value={t.secret} what="Admin Token" label={`Copy ${t.name}`} className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100" />
    </span>
  );
}

function TokenTable({ tokens, onRevoke }: { tokens: AdminToken[]; onRevoke: (t: AdminToken) => void }) {
  return (
    <Table>
      <THead>
        <tr>
          <TH className="w-[22%]">Name</TH>
          <TH className="w-[24%]">Token</TH>
          <TH className="w-[16%]">Created</TH>
          <TH>Last used</TH>
          <TH className="w-10">
            <span className="sr-only">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {tokens.map((t) => (
          <TR key={t.id} className="group h-[60px]">
            <TD className="text-[15px] font-medium" title={t.note || undefined}>
              {t.name}
            </TD>
            <TD>
              <SecretCell t={t} />
            </TD>
            <TD className="tabular text-fg">{shortDate(t.created_at)}</TD>
            <TD className="tabular">
              <LastUsed t={t} />
            </TD>
            <TD align="right">
              <TokenMenu t={t} onRevoke={onRevoke} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** Phones: two lines per token, name and menu, then the token and its last use. */
function TokenList({ tokens, onRevoke }: { tokens: AdminToken[]; onRevoke: (t: AdminToken) => void }) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {tokens.map((t) => (
        <li key={t.id} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[16px] font-medium">{t.name}</p>
            <p className="mt-0.5 flex items-center justify-between gap-3 text-[14px] text-fg-muted">
              <Mono>{shortSecret(t.secret)}</Mono>
              <LastUsed t={t} />
            </p>
          </div>
          <TokenMenu t={t} onRevoke={onRevoke} />
        </li>
      ))}
    </ul>
  );
}

function CreateDialog({ open, onOpenChange, existing }: { open: boolean; onOpenChange: (o: boolean) => void; existing: AdminToken[] }) {
  const create = useCreateAdminToken();
  const invalidate = useInvalidateAll();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<{ token: AdminToken; entry?: string }>();
  const undo = useSave({ refresh: invalidate });

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setName("");
      setNote("");
      setError(undefined);
      setMade(undefined);
      undo.clear();
      create.reset();
    }
  };

  const submit = () => {
    const n = name.trim();
    if (!n) return setError("Give the token a name, usually the script or agent that will hold it.");
    if (existing.some((t) => t.name === n)) return setError(`An Admin Token is already named ${n}. Pick another name.`);
    setError(undefined);
    create.mutate(
      { name: n, note: note.trim() || undefined },
      {
        // The dialog stays open on the new token, which says it was created; Undo is in its footer.
        onSuccess: (res) => setMade({ token: res.admin_token, entry: res.audit_entry }),
        onError: (e) => setError(isApiError(e) ? `${e.message} ${e.hint}`.trim() : String(e)),
      },
    );
  };

  if (made) {
    const { token, entry } = made;
    // Undo deletes the token again and closes the dialog; with the dialog gone, a toast says so.
    const undoCreate = async () => {
      if (entry && (await undo.run(() => revertEntry(entry)))) {
        close(false);
        notify.success(`Admin Token ${token.name} deleted`);
      }
    };
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title="Admin Token created"
        description={`Give it to ${token.name}. It works on every admin route, sent as a Bearer token.`}
        footer={
          <>
            {entry && (
              <Button variant="ghost" icon={RotateCcw} className="mr-auto" aria-label={`Undo: delete ${token.name}`} loading={undo.pending} onClick={() => void undoCreate()}>
                Undo
              </Button>
            )}
            <Button variant="primary" onClick={() => close(false)}>
              Done
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-2 rounded-lg border border-border bg-subtle p-1.5 pl-3">
          <Mono className="min-w-0 flex-1 break-all py-1 text-fg">{token.secret}</Mono>
          <CopyButton value={token.secret} what="Admin Token" />
        </div>
        <p className="mt-3 text-[13px] text-fg-muted">You can copy it again later from its row.</p>
        <SaveError save={undo} className="mt-3" />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="New Admin Token"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-admin-token" loading={create.isPending}>
            Create token
          </Button>
        </>
      }
    >
      <form
        id="new-admin-token"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" hint="Usually the script or agent that will hold it. Audit Entries show this name." error={error}>
          {(p) => <Input {...p} autoFocus autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy-script" />}
        </Field>
        <Field label="Note" hint="Optional: who holds it or what it is for.">
          {(p) => <Input {...p} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

function RevokeDialog({ token, onClose }: { token?: AdminToken; onClose: () => void }) {
  const revoke = useRevokeAdminToken();
  return (
    <TypeToConfirmDialog
      open={!!token}
      onOpenChange={(o) => !o && onClose()}
      title={`Revoke ${token?.name ?? ""}?`}
      body="Scripts and agents using this token get 401 straight away. A revoked token can't be turned back on."
      name={token?.name ?? ""}
      confirmLabel="Revoke token"
      onConfirm={async () => {
        if (!token) return;
        const res = await revoke.mutateAsync(token.id);
        // Toast: the confirm dialog has closed.
        notifyChange(`${token.name} revoked`, res, { undoable: false });
      }}
    />
  );
}
