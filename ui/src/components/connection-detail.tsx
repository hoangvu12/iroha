import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  fetchConnections,
  activateKey,
  addKey,
  archiveConnection,
  createUpstreamAccount,
  deleteUpstreamAccount,
  disableKey,
  duplicateConnection,
  ManagementError,
  purgeConnection,
  removeKey,
  testKey,
  updateConnection,
  updateKeySettings,
  type ConnectionView,
} from '@/lib/providers'
import { refreshCatalog } from '@/lib/catalog'
import type { ConnectionSection } from '@/components/navigation'
import { SectionTabs } from '@/components/section-tabs'
import { ConnectionUsageView } from '@/components/connection-usage-view'
import { ConnectionCatalogView } from '@/components/connection-catalog-view'
import { ConnectionLogsView } from '@/components/connection-logs-view'
import { HealthDistribution } from '@/components/health-distribution'
import { StatusBadge } from '@/components/status-badge'
import { HEALTH_LABELS, HEALTH_ORDER, KeyHealthBadge, keyNeedsAttention } from '@/components/key-health'

interface ConnectionDetailProps {
  readonly connectionId: string
  readonly csrfToken: string
  readonly onBack: () => void
  readonly onDeleted: () => void
}

/**
 * The Provider Connection detail view. Its sub-areas are Overview, Upstream
 * Keys, Models, Usage, Logs, and Settings; the global navigation does not
 * appear inside the detail, only the back link and the segmented control.
 */
export function ConnectionDetail({
  connectionId,
  csrfToken,
  onBack,
  onDeleted,
}: ConnectionDetailProps) {
  const [connection, setConnection] = useState<ConnectionView | null>(null)
  const [error, setError] = useState<ManagementError | null>(null)
  const [section, setSection] = useState<ConnectionSection>('overview')

  const reload = useCallback(async () => {
    try {
      const all = await fetchConnections()
      const match = all.find((c) => c.id === connectionId)
      if (match === undefined) {
        setError(new ManagementError('connection_not_found', 'No such Provider Connection.'))
        setConnection(null)
      } else {
        setConnection(match)
        setError(null)
      }
    } catch (cause) {
      if (cause instanceof ManagementError && cause.code === 'authentication_required') {
        onBack()
        return
      }
      setError(
        cause instanceof ManagementError ? cause : new ManagementError('request_failed', 'Load failed.'),
      )
    }
  }, [connectionId, onBack])

  useEffect(() => {
    void reload()
  }, [reload])

  if (connection === null && error === null) {
    return <Skeleton className="h-48 w-full" />
  }

  if (connection === null && error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5" aria-hidden /> Back to Providers
        </Button>
        <Alert variant="destructive" role="alert">
          <AlertTitle>Connection unavailable</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (connection === null) return null

  return (
    <div className="flex flex-col gap-6">
      <ConnectionHeader
        connection={connection}
        onBack={onBack}
        csrfToken={csrfToken}
        onChanged={reload}
        onDeleted={onDeleted}
      />

      <div className="flex items-center justify-between gap-3">
        <SectionTabs active={section} onChange={setSection} />
      </div>

      {section === 'overview' && <ConnectionOverviewPane connection={connection} csrfToken={csrfToken} onChanged={reload} />}
      {section === 'upstream-keys' && (
        <UpstreamKeysPane connection={connection} csrfToken={csrfToken} onChanged={reload} />
      )}
      {section === 'models' && <ConnectionCatalogView connectionId={connection.id} csrfToken={csrfToken} />}
      {section === 'usage' && <ConnectionUsageView connectionId={connection.id} csrfToken={csrfToken} />}
      {section === 'logs' && <ConnectionLogsView connectionId={connection.id} />}
      {section === 'settings' && (
        <ConnectionSettingsPane connection={connection} csrfToken={csrfToken} onChanged={reload} />
      )}
    </div>
  )
}

function ConnectionHeader({
  connection,
  onBack,
  csrfToken,
  onChanged,
  onDeleted,
}: {
  readonly connection: ConnectionView
  readonly onBack: () => void
  readonly csrfToken: string
  readonly onChanged: () => void
  readonly onDeleted: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const [confirmingPurge, setConfirmingPurge] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)

  const run = async (label: string, perform: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof ManagementError
          ? cause
          : new ManagementError('request_failed', 'That did not work.'),
      )
    } finally {
      setBusy(null)
      setConfirmingArchive(false)
      setConfirmingPurge(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="self-start"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Back to Providers
      </Button>

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold tracking-tight">{connection.displayName}</h2>
        <span className="text-muted-foreground font-mono text-xs">{connection.id}</span>
        {connection.archived && <StatusBadge tone="neutral" label="Archived" />}
        {!connection.archived && !connection.enabled && (
          <StatusBadge tone="neutral" label="Disabled" />
        )}
        {connection.allowInsecureHttp && <StatusBadge tone="danger" label="Insecure HTTP" />}
      </div>

      <p className="text-muted-foreground truncate font-mono text-xs">{connection.baseUrl}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void run('refresh', () => refreshCatalog(connection.id, csrfToken))}
          disabled={busy !== null || connection.archived}
        >
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh catalog'}
        </Button>
        {!connection.archived && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              void run('duplicate', () => duplicateConnection(connection.id, csrfToken))
            }
            disabled={busy !== null}
          >
            {busy === 'duplicate' ? 'Duplicating…' : 'Duplicate'}
          </Button>
        )}
        {!connection.archived && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirmingArchive) {
                void run('archive', () => archiveConnection(connection.id, csrfToken))
              } else {
                setConfirmingArchive(true)
              }
            }}
            onBlur={() => setConfirmingArchive(false)}
            disabled={busy !== null}
          >
            {busy === 'archive' ? 'Archiving…' : confirmingArchive ? 'Confirm archive' : 'Archive'}
          </Button>
        )}
        {connection.archived && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirmingPurge) {
                void run('purge', async () => {
                  await purgeConnection(connection.id, csrfToken)
                  onDeleted()
                })
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

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <Separator className="my-1" />
    </div>
  )
}

function ConnectionOverviewPane({
  connection,
  csrfToken,
  onChanged,
}: {
  readonly connection: ConnectionView
  readonly csrfToken: string
  readonly onChanged: () => void
}) {
  const counts = countByHealth(connection)
  const attention = connection.keys.filter(keyNeedsAttention)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ManagementError | null>(null)

  const run = async (label: string, perform: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof ManagementError
          ? cause
          : new ManagementError('request_failed', 'That did not work.'),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-base font-semibold tracking-tight">Attention required</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Keys that need a decision before traffic will recover.
        </p>
        <Separator className="my-4" />

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {attention.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing needs attention. All keys are Active or Disabled by Owner choice.
          </p>
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {attention.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <KeyHealthBadge health={key.health} />
                  <span className="text-muted-foreground font-mono text-xs">{key.id}</span>
                  <span className="text-muted-foreground text-xs">{key.healthReason ?? 'No reason recorded'}</span>
                  {key.retryAfterAt !== null && (
                    <span className="text-muted-foreground text-xs">
                      retry eligible {formatTime(key.retryAfterAt)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void run(`test-${key.id}`, () => testKey(connection.id, key.id, csrfToken))}
                    disabled={busy !== null}
                  >
                    {busy === `test-${key.id}` ? 'Testing…' : 'Test'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void run(`activate-${key.id}`, () => activateKey(connection.id, key.id, csrfToken))
                    }
                    disabled={busy !== null}
                  >
                    {busy === `activate-${key.id}` ? 'Activating…' : 'Activate'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void run(`disable-${key.id}`, () => disableKey(connection.id, key.id, csrfToken))
                    }
                    disabled={busy !== null}
                  >
                    {busy === `disable-${key.id}` ? 'Disabling…' : 'Disable'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-base font-semibold tracking-tight">Key Health</h3>
        <Separator className="my-4" />
        <div className="bg-card rounded-lg border p-4">
          <HealthDistribution
            counts={counts}
            order={HEALTH_ORDER}
            labels={HEALTH_LABELS}
            tones={{
              active: 'healthy',
              unverified: 'warning',
              cooling_down: 'warning',
              invalid_authentication: 'danger',
              exhausted: 'danger',
              disabled: 'neutral',
            }}
          />
        </div>
      </section>
    </div>
  )
}

function UpstreamKeysPane({
  connection,
  csrfToken,
  onChanged,
}: {
  readonly connection: ConnectionView
  readonly csrfToken: string
  readonly onChanged: () => void
}) {
  const [newKey, setNewKey] = useState('')
  const [accountName, setAccountName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ManagementError | null>(null)

  const run = async (label: string, perform: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof ManagementError
          ? cause
          : new ManagementError('request_failed', 'That did not work.'),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-base font-semibold tracking-tight">Upstream Keys</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          New keys start independent, allow all models, and remain Unverified until tested.
          Group keys that share Provider billing or capacity.
        </p>
        <Separator className="my-4" />

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>That did not work</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {connection.keys.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No Upstream Keys yet. Add one to give this connection inference capacity.
          </p>
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {connection.keys.map((key) => (
              <UpstreamKeyRow
                key={key.id}
                connectionId={connection.id}
                keyView={key}
                accounts={connection.accounts}
                csrfToken={csrfToken}
                busy={busy}
                run={run}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </section>

      {!connection.archived && (
        <section>
          <h3 className="text-base font-semibold tracking-tight">Capacity</h3>
          <Separator className="my-4" />
          <div className="bg-card grid gap-4 rounded-lg border p-3 md:grid-cols-2">
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (newKey === '') return
                void run('add-key', async () => {
                  await addKey(connection.id, newKey, csrfToken)
                  setNewKey('')
                })
              }}
            >
              <p className="text-xs font-medium">Add Upstream Key</p>
              <Input
                id="upstream-add-key"
                label="New upstream key"
                type="password"
                value={newKey}
                onChange={setNewKey}
                autoComplete="off"
              />
              <Button
                type="submit"
                size="sm"
                className="self-start"
                disabled={busy !== null || newKey === ''}
              >
                {busy === 'add-key' ? 'Adding…' : 'Add key'}
              </Button>
            </form>

            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium">Upstream Accounts</p>
              {connection.accounts.length === 0 ? (
                <p className="text-muted-foreground text-xs">No shared accounts yet.</p>
              ) : (
                connection.accounts.map((account) => (
                  <div key={account.id} className="flex items-center justify-between text-xs">
                    <span>{account.displayName}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        void run(`delete-account-${account.id}`, () =>
                          deleteUpstreamAccount(connection.id, account.id, csrfToken),
                        )
                      }
                      disabled={busy !== null}
                    >
                      {busy === `delete-account-${account.id}` ? 'Deleting…' : 'Delete'}
                    </Button>
                  </div>
                ))
              )}
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (accountName.trim() === '') return
                  void run('create-account', async () => {
                    await createUpstreamAccount(connection.id, accountName, csrfToken)
                    setAccountName('')
                  })
                }}
              >
                <div className="flex flex-1 flex-col gap-1.5">
                  <Input
                    id="account-name"
                    label="Account name"
                    value={accountName}
                    onChange={setAccountName}
                  />
                </div>
                <Button type="submit" size="sm" disabled={busy !== null}>
                  {busy === 'create-account' ? 'Creating…' : 'Create account'}
                </Button>
              </form>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

function UpstreamKeyRow({
  connectionId,
  keyView,
  accounts,
  csrfToken,
  busy,
  run,
  onChanged,
}: {
  readonly connectionId: string
  readonly keyView: ConnectionView['keys'][number]
  readonly accounts: ConnectionView['accounts']
  readonly csrfToken: string
  readonly busy: string | null
  readonly run: (label: string, perform: () => Promise<unknown>) => Promise<void>
  readonly onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [accountId, setAccountId] = useState(keyView.accountId ?? '')
  const [allowedModels, setAllowedModels] = useState(keyView.allowedModels?.join(', ') ?? '')
  const [deniedModels, setDeniedModels] = useState(keyView.deniedModels?.join(', ') ?? '')
  const account = accounts.find((candidate) => candidate.id === keyView.accountId)

  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <KeyHealthBadge health={keyView.health} />
        <span className="text-muted-foreground font-mono">{keyView.id}</span>
        <span className="text-muted-foreground">
          {account === undefined ? 'Independent capacity' : `Shared: ${account.displayName}`}
        </span>
        <span className="text-muted-foreground">
          {keyView.allowedModels !== null
            ? `Only ${keyView.allowedModels.join(', ')}`
            : keyView.deniedModels !== null
              ? `All except ${keyView.deniedModels.join(', ')}`
              : 'All models'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void run(`test-${keyView.id}`, () => testKey(connectionId, keyView.id, csrfToken))}
            disabled={busy !== null}
          >
            {busy === `test-${keyView.id}` ? 'Testing…' : 'Test'}
          </Button>
          {keyView.health !== 'active' && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void run(`activate-${keyView.id}`, () => activateKey(connectionId, keyView.id, csrfToken))}
              disabled={busy !== null}
            >
              {busy === `activate-${keyView.id}` ? 'Activating…' : 'Activate'}
            </Button>
          )}
          {keyView.health !== 'disabled' && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void run(`disable-${keyView.id}`, () => disableKey(connectionId, keyView.id, csrfToken))}
              disabled={busy !== null}
            >
              {busy === `disable-${keyView.id}` ? 'Disabling…' : 'Disable'}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setEditing((open) => !open)}
            disabled={busy !== null}
          >
            Configure
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              if (confirmingRemove) {
                void run(`remove-${keyView.id}`, () => removeKey(connectionId, keyView.id, csrfToken))
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
      </div>

      {keyView.healthReason !== null && (
        <p className="text-muted-foreground text-xs">
          {keyView.healthReason}
          {keyView.healthModel === null ? '' : ` · model ${keyView.healthModel}`}
          {keyView.retryAfterAt === null
            ? ''
            : ` · retry eligible ${formatTime(keyView.retryAfterAt)}`}
        </p>
      )}

      {editing && (
        <form
          className="grid gap-3 border-t pt-3 md:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault()
            void run(`configure-${keyView.id}`, async () => {
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
              setEditing(false)
              onChanged()
            })
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`key-${keyView.id}-account`}
              className="text-muted-foreground text-xs tracking-wide uppercase"
            >
              Shared account
            </label>
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
          <Input
            id={`key-${keyView.id}-allowed`}
            label="Only allow models"
            hint="Comma-separated exact model IDs. Blank allows all."
            value={allowedModels}
            onChange={setAllowedModels}
          />
          <Input
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
      )}
    </li>
  )
}

function ConnectionSettingsPane({
  connection,
  csrfToken,
  onChanged,
}: {
  readonly connection: ConnectionView
  readonly csrfToken: string
  readonly onChanged: () => void
}) {
  const [displayName, setDisplayName] = useState(connection.displayName)
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl)
  const [enabled, setEnabled] = useState(connection.enabled)
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(connection.allowInsecureHttp)
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(String(connection.retryMaxAttempts))
  const [retryAmbiguousNetwork, setRetryAmbiguousNetwork] = useState(
    connection.retryAmbiguousNetwork,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    updateConnection(
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
      .then(() => onChanged())
      .catch((cause: unknown) =>
        setError(
          cause instanceof ManagementError
            ? cause
            : new ManagementError('request_failed', 'Could not save.'),
        ),
      )
      .finally(() => setBusy(false))
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-base font-semibold tracking-tight">Connection settings</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Editing keeps the connection’s ID unchanged so client URLs stay valid.
        </p>
        <Separator className="my-4" />

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <Input
            id="settings-display-name"
            label="Display name"
            value={displayName}
            onChange={setDisplayName}
          />
          <Input
            id="settings-base-url"
            label="Base URL"
            value={baseUrl}
            onChange={setBaseUrl}
          />

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
            Retry ambiguous network failures. Off by default because a generation may have
            completed.
          </label>
          <Input
            id="settings-retry-attempts"
            label="Maximum attempts"
            type="number"
            hint="One to five attempts across retries and alternate credentials."
            value={retryMaxAttempts}
            onChange={setRetryMaxAttempts}
          />

          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
        </form>
      </section>
    </div>
  )
}

function countByHealth(connection: ConnectionView): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(HEALTH_ORDER.map((key) => [key, 0]))
  for (const key of connection.keys) {
    counts[key.health] = (counts[key.health] ?? 0) + 1
  }
  return counts
}

function Input({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  hint,
}: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly type?: string
  readonly autoComplete?: string
  readonly hint?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-muted-foreground text-xs tracking-wide uppercase">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        className="border-input bg-background h-9 rounded-md border px-2 text-sm"
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}

function parseModelList(value: string): readonly string[] | null {
  const models = value
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model !== '')
  return models.length === 0 ? null : models
}

/** Stored in UTC, shown in the reader's own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}