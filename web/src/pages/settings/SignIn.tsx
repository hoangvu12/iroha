import { useState } from "react";
import { LogOut, Monitor } from "lucide-react";
import { isApiError } from "@/api/client";
import { type OwnerSession, useSignOut } from "@/api/session";
import { PageBody } from "@/app/PageBody";
import { timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button } from "@/ui/Button";
import { ConfirmDialog, Dialog } from "@/ui/Dialog";
import { Field, PasswordInput } from "@/ui/Input";
import { EmptyState, ErrorState } from "@/ui/States";
import { Skeleton } from "@/ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/ui/Table";
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
          <Button onClick={() => setChanging(true)} className="self-start md:self-auto">
            Change password
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

function Sessions() {
  const sessions = useOwnerSessions();
  const phone = useIsPhone();
  const revokeOthers = useRevokeOtherSessions();
  const [ending, setEnding] = useState<OwnerSession>();
  const [endingOthers, setEndingOthers] = useState(false);
  const others = (sessions.data ?? []).filter((s) => !s.current);

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
          <Button danger onClick={() => setEndingOthers(true)} className="self-start md:self-auto">
            Sign out the others…
          </Button>
        )}
      </div>

      {sessions.isError ? (
        <ErrorState title="Couldn't load signed-in browsers" error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : (
      <Skeleton data={sessions.data} sample={SAMPLE_SESSIONS} id={phone ? "owner-sessions:phone" : "owner-sessions"} label="Loading signed-in browsers">
      {(list) => list.length === 0 ? (
        <EmptyState icon={Monitor} title="No browser is signed in" description="Agents use Admin Tokens, so this stays empty until you sign in." />
      ) : phone ? (
        <ul className="divide-y divide-border border-y border-border">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[16px] font-medium">{browserName(s.user_agent)}</p>
                <p className="mt-0.5 text-[14px] text-fg-muted">
                  {s.current ? "This browser" : `Last seen ${timeAgo(s.last_seen_at ?? s.created_at)}`}
                </p>
              </div>
              <EndButton s={s} onEnd={setEnding} />
            </li>
          ))}
        </ul>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH className="w-[30%]">Browser</TH>
              <TH>Signed in</TH>
              <TH>Last seen</TH>
              <TH>Expires</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {list.map((s) => (
              <TR key={s.id} className="h-[60px]">
                <TD className="text-[15px]" title={s.user_agent}>
                  <span className="font-medium">{browserName(s.user_agent)}</span>
                  {s.current && <span className="ml-2.5 text-fg-muted">This browser</span>}
                </TD>
                <TD className="tabular">{shortDate(s.created_at)}</TD>
                <TD className="tabular">{s.current ? "Now" : timeAgo(s.last_seen_at ?? s.created_at)}</TD>
                <TD className="tabular">{shortDate(s.expires_at)}</TD>
                <TD align="right">
                  <EndButton s={s} onEnd={setEnding} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      </Skeleton>
      )}

      <EndDialog session={ending} onClose={() => setEnding(undefined)} />
      <ConfirmDialog
        open={endingOthers}
        onOpenChange={setEndingOthers}
        title={`Sign out ${others.length} other browsers?`}
        body="Each goes back to the login page on its next click. This browser stays signed in."
        confirmLabel="Sign them out"
        onConfirm={async () => {
          const res = await revokeOthers.mutateAsync(others.map((s) => s.id));
          // Toast: the confirm dialog has closed.
          notifyChange(`${res.succeeded} browsers signed out`, res, { undoable: false });
        }}
      />
    </section>
  );
}

function EndButton({ s, onEnd }: { s: OwnerSession; onEnd: (s: OwnerSession) => void }) {
  const signOut = useSignOut();
  // Signing out works by leaving this page; a failure stays here, under the button.
  const ending = useSave({ describe: (e) => `Couldn't sign out: ${describeError(e)}` });
  if (s.current)
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <Button size="sm" icon={LogOut} loading={ending.pending} onClick={() => void ending.run(() => signOut.mutateAsync(undefined), { quiet: true })}>
          Sign out
        </Button>
        <SaveError save={ending} className="max-w-64 text-right text-[12.5px] leading-snug" />
      </span>
    );
  return (
    <Button size="sm" danger="hover" aria-label={`Sign out ${browserName(s.user_agent)}`} onClick={() => onEnd(s)}>
      Sign out…
    </Button>
  );
}

function EndDialog({ session, onClose }: { session?: OwnerSession; onClose: () => void }) {
  const revoke = useRevokeOwnerSession();
  const name = session ? browserName(session.user_agent) : "";
  return (
    <ConfirmDialog
      open={!!session}
      onOpenChange={(o) => !o && onClose()}
      title={`Sign out ${name}?`}
      body={`That browser goes back to the login page on its next click. It signed in on ${session ? shortDate(session.created_at) : ""}.`}
      confirmLabel="Sign it out"
      onConfirm={async () => {
        if (!session) return;
        const res = await revoke.mutateAsync(session.id);
        // Toast: the confirm dialog has closed.
        notifyChange(`${name} signed out`, res, { undoable: false });
      }}
    />
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
            Change password
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
