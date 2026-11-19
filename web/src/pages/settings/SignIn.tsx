import { useState } from "react";
import { LogOut, Monitor } from "lucide-react";
import { isApiError } from "@/api/client";
import { type OwnerSession, useSignOut } from "@/api/session";
import { PageBody } from "@/app/PageBody";
import { timeAgo } from "@/lib/format";
import { Button } from "@/ui/Button";
import { useConfirm } from "@/ui/Confirm";
import { type SortingState, DataTable, columnsFor } from "@/ui/DataTable";
import { Dialog } from "@/ui/Dialog";
import { Field, PasswordInput } from "@/ui/Input";
import { EmptyState } from "@/ui/States";
import { describeError, SaveError, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import { useChangePassword, useOwnerSessions, useRevokeOtherSessions, useRevokeOwnerSession } from "./api";
import { shortDate } from "./format";
import { SAMPLE_SESSIONS } from "./samples";

// Settings → Sign-in: the Owner password and the browsers signed in with
// it (ticket 21 built the API; this is its UI).

export function SignInTab() {
  const [changing, setChanging] = useState(false);
  return (
    <PageBody width="readable" className="flex flex-col gap-10">
      <section aria-labelledby="password-h">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 id="password-h" className="text-[15px] font-semibold">
              Owner password
            </h2>
            <p className="mt-1 text-sm text-fg-muted">Changing it signs out every other browser.</p>
          </div>
          {/* "…": it opens the dialog, whose own button is "Save the new password" (distinct names for agents). */}
          <Button onClick={() => setChanging(true)} className="self-start md:self-auto">
            Change password…
          </Button>
        </div>
      </section>
      <Sessions />
      <PasswordDialog open={changing} onOpenChange={setChanging} />
    </PageBody>
  );
}

/** "Chrome on Windows" from a User-Agent; good enough to tell browsers apart. */
export function browserName(ua: string): string {
  if (!ua) return "Unknown browser";
  const browsers: [RegExp, string][] = [
    [/Edg\//, "Edge"],
    [/OPR\//, "Opera"],
    [/Firefox\//, "Firefox"],
    [/Chrome\//, "Chrome"],
    [/Safari\//, "Safari"],
  ];
  const systems: [RegExp, string][] = [
    [/iPhone/, "iPhone"],
    [/iPad/, "iPad"],
    [/Android/, "Android"],
    [/Windows/, "Windows"],
    [/Mac OS X|Macintosh/, "Mac"],
    [/Linux/, "Linux"],
  ];
  const browser = browsers.find(([re]) => re.test(ua))?.[1];
  const os = systems.find(([re]) => re.test(ua))?.[1];
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || ua.split(/[ /]/)[0] || "Unknown browser";
}

const seen = (s: OwnerSession) => s.last_seen_at ?? s.created_at;

const col = columnsFor<OwnerSession>();
const columns = col.columns([
  col.accessor((s) => browserName(s.user_agent), {
    id: "browser",
    header: "Browser",
    sortFn: (a, b) => browserName(a.original.user_agent).localeCompare(browserName(b.original.user_agent)) || b.original.created_at.localeCompare(a.original.created_at),
    meta: { width: "w-[34%]", className: "whitespace-nowrap text-[15px]" },
    cell: ({ row }) => (
      <span title={row.original.user_agent}>
        <span className="font-medium">{browserName(row.original.user_agent)}</span>
        {row.original.current && <span className="ml-2.5 text-fg-muted">This browser</span>}
      </span>
    ),
  }),
  col.accessor("created_at", {
    id: "created",
    header: "Signed in",
    sortFn: (a, b) => a.original.created_at.localeCompare(b.original.created_at),
    meta: { className: "tabular" },
    cell: ({ row }) => shortDate(row.original.created_at),
  }),
  col.accessor(seen, {
    id: "seen",
    header: "Last seen",
    // The most recently seen first; this browser is seen now.
    sortFn: (a, b) => Number(b.original.current) - Number(a.original.current) || seen(b.original).localeCompare(seen(a.original)),
    meta: { className: "tabular" },
    cell: ({ row }) => (row.original.current ? "Now" : timeAgo(seen(row.original))),
  }),
  col.accessor("expires_at", {
    id: "expires",
    header: "Expires",
    sortFn: (a, b) => a.original.expires_at.localeCompare(b.original.expires_at),
    meta: { className: "tabular" },
    cell: ({ row }) => shortDate(row.original.expires_at),
  }),
]);

// The newest sign-in first.
const NEWEST: SortingState = [{ id: "created", desc: true }];

/** A browser's name in its controls; two of the same kind are told apart by when they signed in. */
function sessionName(s: OwnerSession, all: OwnerSession[]): string {
  const name = browserName(s.user_agent);
  return all.filter((x) => browserName(x.user_agent) === name).length > 1 ? `${name}, signed in ${shortDate(s.created_at)}` : name;
}

function Sessions() {
  const sessions = useOwnerSessions();
  const revoke = useRevokeOwnerSession();
  const revokeOthers = useRevokeOtherSessions();
  const confirm = useConfirm();
  const all = sessions.data ?? [];
  const others = all.filter((s) => !s.current).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const askEnd = (s: OwnerSession) => {
    const name = sessionName(s, all);
    confirm.ask({
      title: `Sign out ${name}?`,
      body: `That browser goes back to the login page on its next click. It signed in on ${shortDate(s.created_at)}.`,
      confirmLabel: "Sign it out",
      onConfirm: async () => {
        const res = await revoke.mutateAsync(s.id);
        // Toast: the confirm dialog has closed and the row is gone.
        notifyChange(`${name} signed out`, res, { undoable: false });
      },
    });
  };
  const askEndOthers = () =>
    confirm.ask({
      title: `Sign out ${others.length} other browsers?`,
      body: "Each goes back to the login page on its next click. This browser stays signed in.",
      confirmLabel: "Sign them out",
      onConfirm: async () => {
        const res = await revokeOthers.mutateAsync(others.map((s) => s.id));
        // Toast: the confirm dialog has closed and the rows are gone.
        notifyChange(`${res.succeeded} browsers signed out`, res, { undoable: false });
      },
    });

  return (
    <section aria-labelledby="sessions-h">
      <div className="mb-3 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 id="sessions-h" className="text-[15px] font-semibold">
            Signed-in browsers
          </h2>
          <p className="mt-1 text-sm text-fg-muted">Each stays signed in for 30 days from when it signed in.</p>
        </div>
        {others.length > 1 && (
          <Button danger onClick={askEndOthers} className="self-start md:self-auto">
            Sign out the other browsers…
          </Button>
        )}
      </div>

      <DataTable<OwnerSession>
        id="owner-sessions"
        label="Signed-in browsers"
        columns={columns}
        data={sessions.data}
        sample={SAMPLE_SESSIONS}
        getRowId={(s) => s.id}
        rowName={(s) => sessionName(s, all)}
        error={sessions.isError ? sessions.error : undefined}
        errorTitle="Couldn't load signed-in browsers"
        onRetry={() => void sessions.refetch()}
        defaultSorting={NEWEST}
        rowActions={(s) => <EndButton s={s} name={sessionName(s, all)} onEnd={askEnd} />}
        phoneRow={(s) => (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[16px] font-medium">{browserName(s.user_agent)}</p>
            <p className="mt-0.5 text-[14px] text-fg-muted">{s.current ? "This browser" : `Last seen ${timeAgo(seen(s))}`}</p>
          </div>
        )}
        empty={<EmptyState icon={Monitor} title="No browser is signed in" description="Agents use Admin Tokens, so this stays empty until you sign in." />}
      />
      {confirm.dialog}
    </section>
  );
}

function EndButton({ s, name, onEnd }: { s: OwnerSession; name: string; onEnd: (s: OwnerSession) => void }) {
  const signOut = useSignOut();
  // Signing out works by leaving this page; a failure stays here, under the button.
  const ending = useSave({ describe: (e) => `Couldn't sign out: ${describeError(e)}` });
  if (s.current)
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <Button
          size="sm"
          icon={LogOut}
          aria-label="Sign out this browser"
          loading={ending.pending}
          onClick={() => void ending.run(() => signOut.mutateAsync(undefined), { quiet: true })}
        >
          Sign out
        </Button>
        <SaveError save={ending} className="max-w-64 text-right text-[12.5px] leading-snug" />
      </span>
    );
  return (
    <Button size="sm" danger="hover" aria-label={`Sign out ${name}…`} onClick={() => onEnd(s)}>
      Sign out…
    </Button>
  );
}

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<{ field: "current" | "next"; text: string }>();

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setCurrent("");
      setNext("");
      setError(undefined);
      change.reset();
    }
  };
  const submit = () => {
    if (!current) return setError({ field: "current", text: "Type the password you use now." });
    if (next.length < 8) return setError({ field: "next", text: "Use at least 8 characters." });
    setError(undefined);
    change.mutate(
      { current_password: current, password: next },
      {
        onSuccess: (res) => {
          close(false);
          const others = res.changes.filter((c) => c.resource === "owner_session").length;
          // Toast: the password dialog has closed.
          notifyChange(others ? `Password changed. ${others} other browsers signed out` : "Password changed", res, { undoable: false });
        },
        onError: (e) => {
          const wrong = isApiError(e) && e.code === "owner_password_wrong";
          setError({ field: wrong ? "current" : "next", text: wrong ? "That is not the password in use." : isApiError(e) ? e.message : String(e) });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Change the Owner password"
      description="Every other browser is signed out. Agents keep working: they use Admin Tokens."
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="change-password" loading={change.isPending}>
            Save the new password
          </Button>
        </>
      }
    >
      <form
        id="change-password"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Current password" error={error?.field === "current" ? error.text : undefined}>
          {(p) => <PasswordInput {...p} autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field label="New password" hint="At least 8 characters." error={error?.field === "next" ? error.text : undefined}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
