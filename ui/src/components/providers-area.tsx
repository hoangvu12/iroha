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
  addKey,
  archiveConnection,
  createConnection,
  createUpstreamAccount,
  deleteUpstreamAccount,
  disableKey,
  duplicateConnection,
  fetchConnections,
  ManagementError,
  purgeConnection,
  removeKey,
  testKey,
  updateConnection,
  updateKeySettings,
  type ConnectionView,
  type KeyView,
  type UpstreamAccountView,
} from '@/lib/providers'

interface ProvidersAreaProps {
  readonly csrfToken: string
  /** Called when the session vanished underneath, so the shell can step back. */
  readonly onSignedOut: () => void
}

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
          Key. Add more keys and shared accounts from the connection after creation.
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
              accounts={connection.accounts}
              archived={connection.archived}
              csrfToken={csrfToken}
              busy={busy}
              onRun={run}
            />
          ))}

          {!connection.archived && (
            <ConnectionCapacityControls
              connection={connection}
              csrfToken={csrfToken}
              busy={busy}
              onRun={run}
            />
          )}
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
  accounts,
  archived,
  csrfToken,
  busy,
  onRun,
}: {
  connectionId: string
  keyView: KeyView
  accounts: readonly UpstreamAccountView[]
  archived: boolean
  csrfToken: string
  busy: string | null
  onRun: (action: string, perform: () => Promise<unknown>) => void
}) {
  const probe = describeProbe(keyView)
  const [editing, setEditing] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const account = accounts.find((candidate) => candidate.id === keyView.accountId)

  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={keyView.health === 'active' ? 'default' : 'secondary'}>
              {HEALTH_LABELS[keyView.health]}
            </Badge>
            <span className="text-muted-foreground">
              {probe ?? 'Not tested yet. Save traffic by testing before relying on this key.'}
            </span>
            <span className="text-muted-foreground font-mono">{keyView.id}</span>
          </p>
          <p className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 text-xs">
            <span>
              {account === undefined
                ? 'Independent capacity'
                : `Shared account: ${account.displayName}`}
            </span>
            <span>{describeModelPolicy(keyView)}</span>
          </p>
          {keyView.healthReason !== null && (
            <p className="text-muted-foreground mt-1 text-xs">
              {keyView.healthReason}
              {keyView.healthModel === null ? '' : ` · model ${keyView.healthModel}`}
              {keyView.retryAfterAt === null
                ? ''
                : ` · retry eligible ${formatTime(keyView.retryAfterAt)}`}
            </p>
          )}
        </div>

        {!archived && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing((open) => !open)}
              disabled={busy !== null}
            >
              Configure
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirmingRemove) {
                  void onRun(`remove-${keyView.id}`, () =>
                    removeKey(connectionId, keyView.id, csrfToken),
                  )
                } else {
                  setConfirmingRemove(true)
                }
              }}
              onBlur={() => setConfirmingRemove(false)}
              disabled={busy !== null}
            >
              {busy === `remove-${keyView.id}`
                ? 'Removing…'
                : confirmingRemove
                  ? 'Confirm remove'
                  : 'Remove'}
            </Button>
          </div>
        )}
      </div>
      {editing && (
        <KeySettingsForm
          connectionId={connectionId}
          keyView={keyView}
          accounts={accounts}
          csrfToken={csrfToken}
          onRun={onRun}
          onDone={() => setEditing(false)}
        />
      )}
    </div>
  )
}

function ConnectionCapacityControls({
  connection,
  csrfToken,
  busy,
  onRun,
}: {
  connection: ConnectionView
  csrfToken: string
  busy: string | null
  onRun: (action: string, perform: () => Promise<unknown>) => void
}) {
  const [upstreamKey, setUpstreamKey] = useState('')
  const [accountName, setAccountName] = useState('')

  return (
    <div className="bg-muted/30 mt-2 grid gap-4 rounded-md border p-3 md:grid-cols-2">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void onRun('add-key', async () => {
            await addKey(connection.id, upstreamKey, csrfToken)
            setUpstreamKey('')
          })
        }}
      >
        <div>
          <p className="text-xs font-medium">Add Upstream Key</p>
          <p className="text-muted-foreground text-xs">
            New keys start independent, allow all models, and remain Unverified until tested.
          </p>
        </div>
        <Label htmlFor={`add-key-${connection.id}`}>New upstream key</Label>
        <Input
          id={`add-key-${connection.id}`}
          type="password"
          autoComplete="off"
          value={upstreamKey}
          onChange={(event) => setUpstreamKey(event.target.value)}
        />
        <Button type="submit" size="sm" className="self-start" disabled={busy !== null}>
          {busy === 'add-key' ? 'Adding…' : 'Add key'}
        </Button>
      </form>

      <div className="flex flex-col gap-2">
        <div>
          <p className="text-xs font-medium">Upstream Accounts</p>
          <p className="text-muted-foreground text-xs">
            Group keys only when they share provider billing or capacity. Ungrouped keys stay
            independent by default.
          </p>
        </div>
        {connection.accounts.map((account) => (
          <div key={account.id} className="flex items-center justify-between gap-2 text-xs">
            <span>{account.displayName}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void onRun(`delete-account-${account.id}`, () =>
                  deleteUpstreamAccount(connection.id, account.id, csrfToken),
                )
              }
            >
              {busy === `delete-account-${account.id}` ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        ))}
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void onRun('create-account', async () => {
              await createUpstreamAccount(connection.id, accountName, csrfToken)
              setAccountName('')
            })
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor={`account-${connection.id}`}>Account name</Label>
            <Input
              id={`account-${connection.id}`}
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy !== null}>
            {busy === 'create-account' ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      </div>
    </div>
  )
}

function KeySettingsForm({
  connectionId,
  keyView,
  accounts,
  csrfToken,
  onRun,
  onDone,
}: {
  connectionId: string
  keyView: KeyView
  accounts: readonly UpstreamAccountView[]
  csrfToken: string
  onRun: (action: string, perform: () => Promise<unknown>) => void
  onDone: () => void
}) {
  const [accountId, setAccountId] = useState(keyView.accountId ?? '')
  const [allowedModels, setAllowedModels] = useState(keyView.allowedModels?.join(', ') ?? '')
  const [deniedModels, setDeniedModels] = useState(keyView.deniedModels?.join(', ') ?? '')

  return (
    <form
      className="grid gap-3 border-t pt-3 md:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault()
        void onRun(`configure-${keyView.id}`, async () => {
          await updateKeySettings(
            connectionId,
            keyView.id,
            {
              accountId: accountId === '' ? null : accountId,
              allowedModels: parseModelList(allowedModels),
              deniedModels: parseModelList(deniedModels),
            },
            csrfToken,
          )
          onDone()
        })
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`key-${keyView.id}-account`}>Shared account</Label>
        <select
          id={`key-${keyView.id}-account`}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          <option value="">Independent</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.displayName}
            </option>
          ))}
        </select>
      </div>
      <Field
        id={`key-${keyView.id}-allowed`}
        label="Only allow models"
        hint="Comma-separated exact model IDs. Blank allows all."
        value={allowedModels}
        onChange={setAllowedModels}
      />
      <Field
        id={`key-${keyView.id}-denied`}
        label="Exclude models"
        hint="Comma-separated exact model IDs."
        value={deniedModels}
        onChange={setDeniedModels}
      />
      <div className="md:col-span-3">
        <Button type="submit" size="sm">
          Save key settings
        </Button>
      </div>
    </form>
  )
}

function parseModelList(value: string): readonly string[] | null {
  const models = value
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model !== '')
  return models.length === 0 ? null : models
}

function describeModelPolicy(key: KeyView): string {
  if (key.allowedModels !== null) return `Only ${key.allowedModels.join(', ')}`
  if (key.deniedModels !== null) return `All models except ${key.deniedModels.join(', ')}`
  return 'All connection models'
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
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(String(connection.retryMaxAttempts))
  const [retryAmbiguousNetwork, setRetryAmbiguousNetwork] = useState(
    connection.retryAmbiguousNetwork,
  )
  const form = useSubmission(async () => {
    await updateConnection(
      connection.id,
      {
        displayName,
        baseUrl,
        allowInsecureHttp,
        enabled,
        retryMaxAttempts: Number(retryMaxAttempts),
        retryAmbiguousNetwork,
      },
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
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={retryAmbiguousNetwork}
            onChange={(event) => setRetryAmbiguousNetwork(event.target.checked)}
            className="size-3.5"
          />
          Retry ambiguous network failures. Off by default because a generation may have completed.
        </label>
      </div>
      <Field
        id={`edit-${connection.id}-retry-attempts`}
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
  cooling_down: 'Cooling Down',
  invalid_authentication: 'Invalid Authentication',
  exhausted: 'Exhausted',
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
