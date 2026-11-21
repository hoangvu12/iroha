import { useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { errorText, isApiError } from "@/api/client";
import { timeAgo } from "@/lib/format";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { useConfirm } from "@/ui/Confirm";
import { CopyButton, useCopy } from "@/ui/CopyButton";
import { type SortingState, DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { Mono } from "@/ui/bits";
import { riseIn } from "@/ui/Reveal";
import { Dialog } from "@/ui/Dialog";
import { Field, Input } from "@/ui/Input";
import { MenuItem, MenuSeparator } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { SaveError, UndoCreate, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import { type AdminToken, useAdminTokens, useCreateAdminToken, useInvalidateAll, useRevokeAdminToken } from "./api";
import { lastUsed, shortDate, shortSecret } from "./format";
import { SAMPLE_ADMIN_TOKENS } from "./samples";

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const col = columnsFor<AdminToken>();
const columns = col.columns([
  col.accessor("name", {
    header: "Name",
    sortFn: (a, b) => natural(a.original.name, b.original.name),
    meta: { width: "w-[22%]", className: "text-[15px] font-medium" },
    cell: ({ row }) => <span title={row.original.note || undefined}>{row.original.name}</span>,
  }),
  col.display({ id: "token", header: "Token", meta: { width: "w-[24%]" }, cell: ({ row }) => <SecretCell t={row.original} /> }),
  col.accessor("created_at", {
    id: "created",
    header: "Created",
    sortFn: (a, b) => a.original.created_at.localeCompare(b.original.created_at) || natural(a.original.name, b.original.name),
    meta: { width: "w-[16%]", className: "tabular" },
    cell: ({ row }) => shortDate(row.original.created_at),
  }),
  col.accessor((t) => t.last_used_at ?? "", {
    id: "used",
    header: "Last used",
    sortFn: (a, b) => (b.original.last_used_at ?? "").localeCompare(a.original.last_used_at ?? "") || natural(a.original.name, b.original.name),
    meta: { className: "tabular" },
    cell: ({ row }) => <LastUsed t={row.original} />,
  }),
]);

const BY_CREATED: SortingState = [{ id: "created", desc: false }];

export function AdminTokensTab() {
  const tokens = useAdminTokens();
  const [creating, setCreating] = useState(false);
  const confirm = useConfirm();
  const revoke = useRevokeAdminToken();
  const askRevoke = (token: AdminToken) =>
    confirm.ask({
      title: `Revoke ${token.name}?`,
      body: "Scripts and agents using this token get 401 straight away. A revoked token can't be turned back on.",
      typeToConfirm: token.name,
      confirmLabel: "Revoke token",
      onConfirm: async () => {
        const res = await revoke.mutateAsync(token.id);
        notifyChange(`${token.name} revoked`, res, { undoable: false });
      },
    });

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

      <DataTable<AdminToken>
        id="admin-tokens"
        label="Admin Tokens"
        columns={columns}
        data={tokens.data}
        sample={SAMPLE_ADMIN_TOKENS}
        getRowId={(t) => t.id}
        rowName={(t) => t.name}
        error={tokens.isError ? tokens.error : undefined}
        onRetry={() => void tokens.refetch()}
        defaultSorting={BY_CREATED}
        rowActions={(t) => <TokenMenu t={t} onRevoke={askRevoke} />}
        phoneRow={(t) => <TokenLine t={t} />}
        empty={
          <EmptyState
            icon={KeyRound}
            title="No Admin Tokens"
            description="Make one for each script or agent that manages Iroha, so each change says who made it."
          />
        }
        footer={({ total }) => `${total} Admin Token${total === 1 ? "" : "s"}. Copy a token whenever a script needs it. Revoke one from its ⋯ menu.`}
      />

      {confirm.dialog}
      <CreateDialog open={creating} onOpenChange={setCreating} />
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
  const copied = useCopy();
  return (
    <RowMenu name={t.name} copy={copied.state}>
      <MenuItem icon={Copy} onSelect={() => void copied.copy(t.secret, "Admin Token")}>
        Copy token
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Trash2} danger onSelect={() => onRevoke(t)}>
        Revoke…
      </MenuItem>
    </RowMenu>
  );
}

function SecretCell({ t }: { t: AdminToken }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Mono className="text-fg-muted">{shortSecret(t.secret)}</Mono>
      <CopyButton icon value={t.secret} what="Admin Token" label={`Copy ${t.name}`} className="row-reveal" />
    </span>
  );
}

function TokenLine({ t }: { t: AdminToken }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-[16px] font-medium">{t.name}</p>
      <p className="mt-0.5 flex items-center justify-between gap-3 text-[14px] text-fg-muted">
        <Mono>{shortSecret(t.secret)}</Mono>
        <LastUsed t={t} />
      </p>
    </div>
  );
}
function createError(e: unknown, name: string): string {
  if (isApiError(e) && e.code === "name_taken") return `An Admin Token is already named ${name}. Pick another name.`;
  if (isApiError(e) && e.code === "admin_token_revoked") return `${name} was revoked and its name stays on record. Pick another name.`;
  return errorText(e);
}

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
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
    setError(undefined);
    create.mutate(
      { name: n, note: note.trim() || undefined },
      {
        onSuccess: (res) => setMade({ token: res.admin_token, entry: res.audit_entry }),
        onError: (e) => setError(createError(e, n)),
      },
    );
  };

  if (made) {
    const { token, entry } = made;
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title={<span className={cn("block", riseIn)}>Admin Token created</span>}
        description={<span className={cn("block", riseIn)}>Give it to {token.name}. It works on every admin route, sent as a Bearer token.</span>}
        footer={
          <>
            <UndoCreate save={undo} entry={entry} name={token.name} deleted={`Admin Token ${token.name} deleted`} onClose={() => close(false)} />
            <Button variant="primary" onClick={() => close(false)}>
              Done
            </Button>
          </>
        }
      >
        <div className={riseIn}>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-subtle p-1.5 pl-3">
            <Mono className="min-w-0 flex-1 break-all py-1 text-fg">{token.secret}</Mono>
            <CopyButton value={token.secret} what="Admin Token" />
          </div>
          <p className="mt-3 text-[13px] text-fg-muted">You can copy it again later from its row.</p>
        </div>
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
