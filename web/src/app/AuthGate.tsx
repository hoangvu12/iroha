import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { forgetShapes } from "skullet";
import { onSignedOut } from "@/api/client";
import { type SessionStatus, sessionKey, useSession } from "@/api/session";
import { ErrorState } from "@/ui/States";
import { LoginPage } from "@/pages/login/LoginPage";
import { SetupPage } from "@/pages/login/SetupPage";

export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useSession();
  const [notice, setNotice] = useState<string>();

  useEffect(
    () =>
      onSignedOut((e) => {
        const was = qc.getQueryData<SessionStatus>(sessionKey);
        if (was?.signed_in) {
          setNotice(e.code === "owner_session_expired" ? "Your session ended after 30 days. Sign in again." : "You were signed out. Sign in again.");
        }
        qc.setQueryData<SessionStatus>(sessionKey, { password_set: was?.password_set ?? true, signed_in: false });
      }),
    [qc],
  );

  const signedOut = session.data?.signed_in === false;
  useEffect(() => {
    if (signedOut) forgetShapes();
  }, [signedOut]);

  if (session.isPending) return <div className="min-h-dvh bg-bg" aria-busy="true" />;
  if (session.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <ErrorState title="Couldn't reach Iroha" error={session.error} onRetry={() => void session.refetch()} />
      </div>
    );
  }
  if (!session.data.password_set) return <SetupPage />;
  if (!session.data.signed_in) return <LoginPage notice={notice} />;
  return <>{children}</>;
}
