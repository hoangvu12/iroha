import { useState, type FormEvent } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { AuthError, recoverAccess, setupOwner, signIn, type AuthState } from '@/lib/auth'

export type AuthMode = 'setup' | 'sign-in' | 'recover'

interface AuthScreenProps {
  readonly state: AuthState
  readonly onAuthenticated: (state: AuthState) => void
}

/**
 * Everything that happens before the Owner is signed in.
 *
 * Which form appears is decided by the gateway's own state, not by navigation:
 * an unclaimed installation can only be claimed, and a claimed one can only be
 * signed into or recovered.
 */
export function AuthScreen({ state, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(state.setupRequired ? 'setup' : 'sign-in')

  return (
    <div className="bg-canvas flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="relative inline-flex size-6 items-center justify-center rounded-lg bg-[#1A1A1A] shadow-sm"
          >
            <span className="absolute top-1.5 flex gap-1">
              <span className="size-1 rounded-full bg-white" />
              <span className="size-1 rounded-full bg-white" />
            </span>
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">Iroha</span>
            <span className="text-muted-foreground text-xs">Gateway</span>
          </div>
        </div>

        <Separator className="my-5" />

        {state.setupRequired ? (
          <SetupForm onAuthenticated={onAuthenticated} />
        ) : mode === 'recover' ? (
          <RecoverForm onDone={() => setMode('sign-in')} onCancel={() => setMode('sign-in')} />
        ) : (
          <SignInForm
            onAuthenticated={onAuthenticated}
            recoveryEnabled={state.recoveryEnabled}
            onRecover={() => setMode('recover')}
          />
        )}
      </div>
    </div>
  )
}

function SetupForm({ onAuthenticated }: { onAuthenticated: (state: AuthState) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const form = useSubmission(async () => {
    onAuthenticated(await setupOwner({ username, password, setupToken }))
  })

  return (
    <form className="flex flex-col gap-4" onSubmit={form.submit} noValidate>
      <Heading
        title="Claim this installation"
        description="No Owner exists yet. Create the sole Owner account using the setup token from this deployment’s environment."
      />

      <Field
        id="setup-token"
        label="Setup token"
        type="password"
        autoComplete="off"
        value={setupToken}
        onChange={setSetupToken}
        problem={form.problemFor('setupToken')}
      />
      <Field
        id="username"
        label="Username"
        autoComplete="username"
        value={username}
        onChange={setUsername}
        problem={form.problemFor('username')}
      />
      <Field
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters."
        value={password}
        onChange={setPassword}
        problem={form.problemFor('password')}
      />

      <Failure error={form.error} />

      <Button type="submit" disabled={form.busy}>
        {form.busy ? 'Creating…' : 'Create Owner account'}
      </Button>
    </form>
  )
}

function SignInForm({
  onAuthenticated,
  recoveryEnabled,
  onRecover,
}: {
  onAuthenticated: (state: AuthState) => void
  recoveryEnabled: boolean
  onRecover: () => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const form = useSubmission(async () => {
    onAuthenticated(await signIn({ username, password }))
  })

  return (
    <form className="flex flex-col gap-4" onSubmit={form.submit} noValidate>
      <Heading title="Sign in" description="Management is available to the Owner of this gateway." />

      <Field
        id="username"
        label="Username"
        autoComplete="username"
        value={username}
        onChange={setUsername}
      />
      <Field
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
      />

      <Failure error={form.error} />

      <Button type="submit" disabled={form.busy}>
        {form.busy ? 'Signing in…' : 'Sign in'}
      </Button>

      {recoveryEnabled && (
        <button
          type="button"
          onClick={onRecover}
          className="text-muted-foreground hover:text-foreground self-start text-xs underline underline-offset-4"
        >
          Recover access with the recovery token
        </button>
      )}
    </form>
  )
}

function RecoverForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [recoveryToken, setRecoveryToken] = useState('')
  const [password, setPassword] = useState('')
  const [revoked, setRevoked] = useState<number | null>(null)
  const form = useSubmission(async () => {
    setRevoked(await recoverAccess({ recoveryToken, password }))
  })

  if (revoked !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Heading
          title="Password changed"
          description={`Every existing session was revoked${
            revoked === 1 ? ' (1 session)' : ` (${revoked} sessions)`
          }. Sign in with the new password.`}
        />
        <Button type="button" onClick={onDone}>
          Back to sign in
        </Button>
      </div>
    )
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={form.submit} noValidate>
      <Heading
        title="Recover access"
        description="Set a new Owner password using this deployment’s recovery token. Every existing session is revoked."
      />

      <Field
        id="recovery-token"
        label="Recovery token"
        type="password"
        autoComplete="off"
        value={recoveryToken}
        onChange={setRecoveryToken}
      />
      <Field
        id="new-password"
        label="New password"
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters."
        value={password}
        onChange={setPassword}
        problem={form.problemFor('password')}
      />

      <Failure error={form.error} />

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={form.busy}>
          {form.busy ? 'Resetting…' : 'Reset password'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function Heading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-xs">{description}</p>
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  hint,
  problem,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  autoComplete?: string
  hint?: string
  problem?: string | undefined
}) {
  const describedBy = [problem ? `${id}-problem` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        aria-invalid={problem ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
      {problem && (
        <p id={`${id}-problem`} className="text-status-danger text-xs">
          {problem}
        </p>
      )}
    </div>
  )
}

function Failure({ error }: { error: AuthError | null }) {
  if (error === null) return null

  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{TITLES[error.code] ?? 'That did not work'}</AlertTitle>
      <AlertDescription>
        {error.message}
        {error.retryAfterSeconds !== null && ` Try again in ${error.retryAfterSeconds} seconds.`}
      </AlertDescription>
    </Alert>
  )
}

const TITLES: Record<string, string> = {
  invalid_credentials: 'Sign-in failed',
  setup_token_invalid: 'Setup token rejected',
  setup_closed: 'Setup is closed',
  recovery_unavailable: 'Recovery failed',
  too_many_attempts: 'Too many attempts',
  validation_failed: 'Check these values',
  unreachable: 'Gateway unreachable',
}

/** Form submission state shared by the three forms: one attempt at a time. */
function useSubmission(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AuthError | null>(null)

  return {
    busy,
    error,

    problemFor(field: string): string | undefined {
      return error?.problems.find((problem) => problem.field === field)?.message
    },

    submit(event: FormEvent) {
      event.preventDefault()
      if (busy) return

      setBusy(true)
      setError(null)

      void run()
        .catch((cause: unknown) => {
          setError(
            cause instanceof AuthError
              ? cause
              : new AuthError('request_failed', 'That request could not be completed.'),
          )
        })
        .finally(() => setBusy(false))
    },
  }
}
