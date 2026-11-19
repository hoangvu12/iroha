import { useState } from "react";
import { isApiError } from "@/api/client";
import { useSignIn } from "@/api/session";
import { Button } from "@/ui/Button";
import { Field, PasswordInput } from "@/ui/Input";
import { LoginLayout } from "./LoginLayout";

/** C13. Shown at any address while signed out; the page asked for opens after sign-in. */
export function LoginPage({ notice }: { notice?: string }) {
  const signIn = useSignIn();
  const [password, setPassword] = useState("");
  const e = signIn.error;
  const error = !e
    ? undefined
    : isApiError(e) && e.code === "owner_password_wrong"
      ? "That's not the Owner password."
      : isApiError(e) && e.code === "too_many_attempts"
        ? `${e.message} ${e.hint}`
        : e.message;

  return (
    <LoginLayout>
      <h1 className="text-[26px] font-semibold tracking-tight">Sign in to Iroha</h1>
      <p className="mt-1 text-[15px] text-fg-muted">Enter the Owner password</p>
      {notice && !error && <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-[13px] text-fg-muted">{notice}</p>}
      <form
        className="mt-7 flex flex-col gap-6"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (password) signIn.mutate(password);
        }}
      >
        <Field label="Password" error={error}>
          {(p) => (
            <PasswordInput
              {...p}
              autoFocus
              autoComplete="current-password"
              className="h-11"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={signIn.isPending}>
          Sign in
        </Button>
      </form>
      <p className="mt-10 text-sm text-fg-muted">
        Agents sign in with an{" "}
        <a href="/skill.md" className="underline decoration-border-strong underline-offset-2 hover:text-fg">
          Admin Token
        </a>{" "}
        instead
      </p>
    </LoginLayout>
  );
}
