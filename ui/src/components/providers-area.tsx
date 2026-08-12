import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  activateKey,
  archiveConnection,
  createConnection,
  disableKey,
  duplicateConnection,
  fetchConnections,
  ManagementError,
  purgeConnection,
  testKey,
  updateConnection,
  type ConnectionView,
  type KeyView,
} from '@/lib/providers'

interface ProvidersAreaProps {
  readonly csrfToken: string
  /** Called when the session vanished underneath, so the shell can step back. */
  readonly onSignedOut: () => void
}

/**
 * The Providers area: the Provider Connections the Gateway reaches, and the
 * one Upstream Key each connection carries in this version. Creation keeps to
 * the essential fields; everything else lives on the row it affects.
 */
export function ProvidersArea({ csrfToken, onSignedOut }: ProvidersAreaProps) {
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null)
  const [error, setError] = useState<ManagementError | null>(null)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    try {
      setConnections(await fetchConnections())
      setError(null)
    } catch (cause) {
      if (cause instanceof ManagementError && cause.code === 'authentication_required') {
        onSignedOut()
        return
      }
      setError(toManagementError(cause))
    }
  }, [onSignedOut])

  useEffect(() => {
    void reload()
  }, [reload])

  const active = connections?.filter((connection) => !connection.archived) ?? null
  const archived = connections?.filter((connection) => connection.archived) ?? null

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Provider Connections</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Each connection is one account or server the Gateway reaches, addressed by an ID that
              never changes. Upstream Keys are encrypted at rest and never shown again once saved.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreating((open) => !open)}
            disabled={connections === null}
          >
            {creating ? 'Close form' : 'New connection'}
          </Button>
        </div>

        <Separator className="my-4" />

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Providers unavailable</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {creating && (
          <CreateConnectionForm
            csrfToken={csrfToken}
            onCreated={() => {
              setCreating(false)
              void reload()
            }}
            onFailure={setError}
          />
        )}

        {active === null ? (
          <Skeleton className="h-16 w-full" />
        ) : active.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">
            No Provider Connections yet. Create the first one to give your applications an upstream
            to call.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {active.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                csrfToken={csrfToken}
                onChanged={() => void reload()}
              />
            ))}
          </ul>
        )}
      </section>

      {archived !== null && archived.length > 0 && (
        <section>
          <h2 className="text-base font-semibold tracking-tight">Archived</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Preserved identity and history, removed from active use. Duplicate to bring one back, or
            purge it permanently.
          </p>

          <Separator className="my-4" />

          <ul className="divide-border divide-y">
            {archived.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                csrfToken={csrfToken}
                onChanged={() => void reload()}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function CreateConnectionForm({
  csrfToken,
  onCreated,
  onFailure,
}: {
  csrfToken: string
  onCreated: () => void
  onFailure: (error: ManagementError) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [upstreamKey, setUpstreamKey] = useState('')
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false)
  const form = useSubmission(async () => {
    await createConnection({ displayName, baseUrl, upstreamKey, allowInsecureHttp }, csrfToken)
    onCreated()
  }, onFailure)

  return (
    <form
      className="bg-card mb-4 flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={form.submit}
      noValidate
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">New Provider Connection</h3>
        <p className="text-muted-foreground text-xs">
          Only the essentials: a name, the provider’s OpenAI-compatible base URL, and one Upstream
          Key. Advanced behaviour arrives under settings in later tickets.
        </p>
      </div>

      <Field
        id="new-display-name"
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        problem={form.problemFor('displayName')}
      />
      <Field
        id="new-base-url"
        label="Base URL"
        hint="The provider’s OpenAI-compatible base URL, such as https://api.openai.com/v1."
        value={baseUrl}
        onChange={setBaseUrl}
        problem={form.problemFor('baseUrl')}
      />
      <Field
        id="new-upstream-key"
        label="Upstream key"
        type="password"
        autoComplete="off"
        hint="Encrypted with the installation master key and never shown again."
        value={upstreamKey}
        onChange={setUpstreamKey}
        problem={form.problemFor('upstreamKey')}
      />

      <label className="text-muted-foreground flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={allowInsecureHttp}
          onChange={(event) => setAllowInsecureHttp(event.target.checked)}
          className="mt-0.5 size-3.5"
        />
        <span>
          Allow plain HTTP for this connection. Only for private or local servers — the Upstream Key
          travels unencrypted.
        </span>
      </label>

      <Failure error={form.error} />

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={form.busy}>
          {form.busy ? 'Creating…' : 'Create connection'}
        </Button>
      </div>
    </form>
  )
}

function ConnectionRow({
  connection,
  csrfToken,
  onChanged,
}: {
  connection: ConnectionView
  csrfToken: string
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmingPurge, setConfirmingPurge] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (action: string, perform: () => Promise<unknown>) => {
    setBusy(action)
    setError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setError(toManagementError(cause))
    } finally {
      setBusy(null)
      setConfirmingPurge(false)
    }
  }

  const keys = connection.keys

  return (
    <li className="flex flex-col gap-2 py-4">
      {editing ? (
        <EditConnectionForm
          connection={connection}
          csrfToken={csrfToken}
          onDone={() => {
            setEditing(false)
            onChanged()
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{connection.displayName}</span>
              {connection.archived && <Badge variant="secondary">Archived</Badge>}
              {!connection.archived && !connection.enabled && (
                <Badge variant="secondary">Disabled</Badge>
              )}
              {connection.allowInsecureHttp && <Badge variant="destructive">Insecure HTTP</Badge>}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {!connection.archived && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(true)}
                  disabled={busy !== null}
                >
                  Edit
                </Button>
              )}
              {!connection.archived && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void run('archive', () => archiveConnection(connection.id, csrfToken))}
                  disabled={busy !== null}
                >
                  {busy === 'archive' ? 'Archiving…' : 'Archive'}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void run('duplicate', () => duplicateConnection(connection.id, csrfToken))}
                disabled={busy !== null}
              >
                {busy === 'duplicate' ? 'Duplicating…' : 'Duplicate'}
              </Button>
              {connection.archived && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirmingPurge) {
                      void run('purge', () => purgeConnection(connection.id, csrfToken))
                    } else {
                      setConfirmingPurge(true)
                    }
                  }}
                  onBlur={() => setConfirmingPurge(false)}
                  disabled={busy !== null}
                >
                  {busy === 'purge' ? 'Purging…' : confirmingPurge ? 'Confirm purge' : 'Purge'}
                </Button>
              )}
            </div>
          </div>

          <p className="text-muted-foreground truncate font-mono text-xs">{connection.baseUrl}</p>

          {connection.allowInsecureHttp && (
            <p className="text-status-danger text-xs">
              Insecure connection: the Upstream Key is sent over plain HTTP. Keep this only for
              private or local servers.
            </p>
          )}

          {keys.map((key) => (
            <KeyLine
              key={key.id}
              connectionId={connection.id}
              keyView={key}
              archived={connection.archived}
              csrfToken={csrfToken}
              busy={busy}
              onRun={run}
            />
          ))}
        </>
      )}

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
    </li>
  )
}

function KeyLine({
  connectionId,
  keyView,
  archived,
  csrfToken,
  busy,
  onRun,
}: {
  connectionId: string
  keyView: KeyView
  archived: boolean
  csrfToken: string
  busy: string | null
  onRun: (action: string, perform: () => Promise<unknown>) => void
}) {
  const probe = describeProbe(keyView)

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={keyView.health === 'active' ? 'default' : 'secondary'}>
            {HEALTH_LABELS[keyView.health]}
          </Badge>
          <span className="text-muted-foreground">
            {probe ?? 'Not tested yet. Save traffic by testing before relying on this key.'}
          </span>
        </p>
      </div>

      {!archived && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void onRun('test', () => testKey(connectionId, keyView.id, csrfToken))}
            disabled={busy !== null}
          >
            {busy === 'test' ? 'Testing…' : 'Test'}
          </Button>
          {keyView.health !== 'active' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                void onRun('activate', () => activateKey(connectionId, keyView.id, csrfToken))
              }
              disabled={busy !== null}
            >
              {busy === 'activate' ? 'Activating…' : 'Activate'}
            </Button>
          )}
          {keyView.health !== 'disabled' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                void onRun('disable', () => disableKey(connectionId, keyView.id, csrfToken))
              }
              disabled={busy !== null}
            >
              {busy === 'disable' ? 'Disabling…' : 'Disable'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function EditConnectionForm({
  connection,
  csrfToken,
  onDone,
  onCancel,
}: {
  connection: ConnectionView
  csrfToken: string
  onDone: () => void
  onCancel: () => void
}) {
  const [displayName, setDisplayName] = useState(connection.displayName)
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl)
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(connection.allowInsecureHttp)
  const [enabled, setEnabled] = useState(connection.enabled)
  const form = useSubmission(async () => {
    await updateConnection(
      connection.id,
      { displayName, baseUrl, allowInsecureHttp, enabled },
      csrfToken,
    )
    onDone()
  })

  return (
    <form className="flex flex-col gap-3" onSubmit={form.submit} noValidate>
      <p className="text-muted-foreground text-xs">
        Editing keeps the connection’s ID unchanged, so client URLs stay valid.
      </p>

      <Field
        id={`edit-${connection.id}-name`}
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        problem={form.problemFor('displayName')}
      />
      <Field
        id={`edit-${connection.id}-url`}
        label="Base URL"
        value={baseUrl}
        onChange={setBaseUrl}
        problem={form.problemFor('baseUrl')}
      />

      <div className="flex flex-col gap-1.5">
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-3.5"
          />
          Enabled for inference
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={allowInsecureHttp}
            onChange={(event) => setAllowInsecureHttp(event.target.checked)}
            className="size-3.5"
          />
          Allow plain HTTP
        </label>
      </div>

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

function Failure({ error }: { error: ManagementError | null }) {
  if (error === null) return null

  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{TITLES[error.code] ?? 'That did not work'}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  )
}

const TITLES: Record<string, string> = {
  validation_failed: 'Check these values',
  connection_not_found: 'Connection not found',
  key_not_found: 'Key not found',
  connection_archived: 'Connection archived',
  stored_key_unreadable: 'Stored key unreadable',
  authentication_required: 'Signed out',
  unreachable: 'Gateway unreachable',
}

const HEALTH_LABELS: Record<KeyView['health'], string> = {
  unverified: 'Unverified',
  active: 'Active',
  disabled: 'Disabled',
}

function describeProbe(key: KeyView): string | null {
  if (key.lastProbe === null) return null

  const at = formatTime(key.lastProbe.at)
  switch (key.lastProbe.verdict) {
    case 'usable':
      return `Tested usable ${at}.`
    case 'rejected':
      return `Rejected ${at}${key.lastProbe.reason ? `: ${key.lastProbe.reason}` : ''}.`
    case 'inconclusive':
      return `Inconclusive ${at}${key.lastProbe.reason ? `: ${key.lastProbe.reason}` : ''}.`
  }
}

/** Stored in UTC, shown in the reader's own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'

  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function toManagementError(cause: unknown): ManagementError {
  return cause instanceof ManagementError
    ? cause
    : new ManagementError('request_failed', 'That request could not be completed.')
}

function useSubmission(run: () => Promise<void>, onFatal?: (error: ManagementError) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)

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
          const failure = toManagementError(cause)
          if (failure.code === 'authentication_required' && onFatal) {
            onFatal(failure)
            return
          }
          setError(failure)
        })
        .finally(() => setBusy(false))
    },
  }
}
