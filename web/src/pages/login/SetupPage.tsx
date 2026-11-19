import { useState } from "react";
import { isApiError } from "@/api/client";
import { useSetUpPassword } from "@/api/session";
import { Button } from "@/ui/Button";
import { Field, PasswordInput } from "@/ui/Input";
import { LoginLayout } from "./LoginLayout";

const MIN = 8;

/**
 * First visit: choose the Owner password. An Admin Token proves the person
 * setting it runs this Iroha, so whoever reaches a new install first cannot
 * claim it. The UI then signs in with the new password.
 */
export function SetupPage() {
  const setUp = useSetUpPassword();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);

  const local = {
    token: !token.trim() ? "Paste an Admin Token." : undefined,
    password: password.length < MIN ? `Use at least ${MIN} characters.` : undefined,
    confirm: confirm !== password ? "The two passwords differ." : undefined,
  };
  const e = setUp.error;
  const server = {
    token: isApiError(e) && e.status === 401 ? `${e.message} ${e.hint}` : undefined,
    password: isApiError(e) && e.status === 400 ? e.message : undefined,
    other: e && !(isApiError(e) && (e.status === 401 || e.status === 400)) ? e.message : undefined,
  };

  return (
    <LoginLayout>
      <h1 className="text-[26px] font-semibold tracking-tight">Welcome to Iroha</h1>
      <p className="mt-1 text-[15px] text-fg-muted">Set the Owner password you'll sign in with</p>
      <form
        className="mt-7 flex flex-col gap-5"
        onSubmit={(ev) => {
          ev.preventDefault();
          setTried(true);
          if (local.token || local.password || local.confirm) return;
          setUp.mutate({ adminToken: token, password });
        }}
      >
        <Field
          label="Admin Token"
          hint="Proves this Iroha is yours. Its first start printed one named bootstrap to the console."
          error={(tried && local.token) || server.token}
        >
          {(p) => (
            <PasswordInput
              {...p}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="iroha_admin_..."
              value={token}
              onChange={(ev) => setToken(ev.target.value)}
            />
          )}
        </Field>
        <Field label="Password" hint={`At least ${MIN} characters.`} error={(tried && local.password) || server.password}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(ev) => setPassword(ev.target.value)} />}
        </Field>
        <Field label="Confirm password" error={tried ? local.confirm : undefined}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={confirm} onChange={(ev) => setConfirm(ev.target.value)} />}
        </Field>
        {server.other && <p className="text-[13px] text-danger-text">{server.other}</p>}
        <Button type="submit" variant="primary" size="lg" className="mt-1 w-full" loading={setUp.isPending}>
          Set password and sign in
        </Button>
      </form>
    </LoginLayout>
  );
}
