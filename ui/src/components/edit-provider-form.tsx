import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { LogoDomainField } from '@/components/logo-domain-field'
import { logoDomainFromBaseUrl, normalizeLogoDomainInput } from '@/lib/logo-domain'
import { ApiError, toApiError } from '@/lib/api-client'
import { GENERIC_PROVIDER_TEMPLATE_ID, updateProvider, type ProviderView } from '@/lib/providers'

export function EditProviderForm({
  provider,
  csrfToken,
  onDone,
  onCancel,
}: {
  readonly provider: ProviderView
  readonly csrfToken: string
  readonly onDone: () => void
  readonly onCancel: () => void
}) {
  const [displayName, setDisplayName] = useState(provider.displayName)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [logoDomain, setLogoDomain] = useState(provider.logoDomain ?? '')
  const logoDomainTouched = useRef(false)
  const [authHeader, setAuthHeader] = useState(provider.authHeader)
  const [authPrefix, setAuthPrefix] = useState(provider.authPrefix)
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(provider.allowInsecureHttp)
  const [enabled, setEnabled] = useState(provider.enabled)
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(String(provider.retryMaxAttempts))
  const [retryAmbiguousNetwork, setRetryAmbiguousNetwork] = useState(
    provider.retryAmbiguousNetwork,
  )
  const form = useSubmission(async () => {
    const normalizedLogoDomain = normalizeLogoDomainInput(logoDomain)
    if (logoDomain.trim() !== '' && normalizedLogoDomain === null) {
      throw new ApiError('validation_failed', 'Check the highlighted field.', [
        { field: 'logoDomain', message: 'Enter a valid hostname or HTTP(S) URL.' },
      ])
    }
    await updateProvider(
      provider.id,
      {
        displayName,
        baseUrl,
        ...(logoDomainTouched.current ? { logoDomain: normalizedLogoDomain } : {}),
        authHeader,
        authPrefix,
        allowInsecureHttp,
        enabled,
        retryMaxAttempts: Number(retryMaxAttempts),
        retryAmbiguousNetwork,
      },
      csrfToken,
    )
    onDone()
  })

  useEffect(() => {
    if (provider.templateId !== GENERIC_PROVIDER_TEMPLATE_ID || logoDomainTouched.current) return
    if (provider.logoDomain !== logoDomainFromBaseUrl(provider.baseUrl)) return
    const timer = window.setTimeout(() => {
      const suggested = logoDomainFromBaseUrl(baseUrl)
      if (suggested !== null && !logoDomainTouched.current) setLogoDomain(suggested)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [baseUrl, provider.baseUrl, provider.logoDomain, provider.templateId])

  return (
    <form className="flex flex-col gap-3" onSubmit={form.submit} noValidate>
      <Field
        id={`edit-${provider.id}-name`}
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        problem={form.problemFor('displayName')}
      />
      <Field
        id={`edit-${provider.id}-url`}
        label="Default base URL"
        value={baseUrl}
        onChange={setBaseUrl}
        problem={form.problemFor('baseUrl')}
      />
      <LogoDomainField
        id={`edit-${provider.id}-logo-domain`}
        value={logoDomain}
        onChange={(value) => { logoDomainTouched.current = true; setLogoDomain(value) }}
        problem={form.problemFor('logoDomain')}
      />
      <Field
        id={`edit-${provider.id}-auth-header`}
        label="Authentication header"
        value={authHeader}
        onChange={setAuthHeader}
        hint="The HTTP header name for authentication."
        problem={form.problemFor('authHeader')}
      />
      <Field
        id={`edit-${provider.id}-auth-prefix`}
        label="Authentication prefix"
        value={authPrefix}
        onChange={setAuthPrefix}
        hint={
          authHeader
            ? `Sent as: ${authHeader}: ${authPrefix}<your-key>`
            : 'Enter a header name above to see the format.'
        }
        problem={form.problemFor('authPrefix')}
      />
      <div className="flex flex-col gap-1.5">
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <Checkbox
            checked={enabled}
            onCheckedChange={(value) => setEnabled(value === true)}
          />
          Enabled for inference
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <Checkbox
            checked={allowInsecureHttp}
            onCheckedChange={(value) => setAllowInsecureHttp(value === true)}
          />
          Allow plain HTTP
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <Checkbox
            checked={retryAmbiguousNetwork}
            onCheckedChange={(value) => setRetryAmbiguousNetwork(value === true)}
          />
          Retry one connection failure before a response. Off by default because this may
          duplicate a request or charge when the Provider completed it without responding.
        </label>
      </div>
      <Field
        id={`edit-${provider.id}-retry-attempts`}
        label="Maximum attempts"
        type="number"
        hint="One to five attempts across retries and alternate credentials."
        value={retryMaxAttempts}
        onChange={setRetryMaxAttempts}
        problem={form.problemFor('retryMaxAttempts')}
      />

      <Failure error={form.error} />

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={form.busy}>
          {form.busy ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={form.busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  hint,
  problem,
}: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly type?: string
  readonly autoComplete?: string
  readonly hint?: string
  readonly problem?: string | undefined
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

export function Failure({ error }: { error: ApiError | null }) {
  if (error === null) return null

  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{TITLES[error.code] ?? 'That did not work'}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  )
}

export const TITLES: Record<string, string> = {
  validation_failed: 'Check these values',
  provider_not_found: 'Provider not found',
  key_not_found: 'Key not found',
  provider_archived: 'Provider archived',
  stored_key_unreadable: 'Stored key unreadable',
  unreachable: 'Gateway unreachable',
}

export function useSubmission(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

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
        .catch((cause: unknown) => setError(toApiError(cause)))
        .finally(() => setBusy(false))
    },
  }
}
