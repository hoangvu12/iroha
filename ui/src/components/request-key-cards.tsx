import type { ReactNode, SyntheticEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { KeyHealthBadge } from '@/components/key-health'
import { StatusBadge } from '@/components/status-badge'
import type { GatewayKeyView } from '@/lib/gateway-keys'
import type { KeyView, ProviderView } from '@/lib/providers'
import { formatTime } from '@/lib/time'
import { cn } from '@/lib/utils'

/**
 * The two keys a Request names — the Gateway Key that made it and the Upstream
 * Key that served it — as references the Owner can hover for the key's current
 * state, click to open where the key is managed, or narrow the list to.
 *
 * Both are read from lists the Requests route already holds. A key that has
 * since been deleted still shows what the Request recorded about it.
 */

const TRIGGER_CLASS =
  'hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2'

export function GatewayKeyRef({
  gatewayKeyId,
  recordedName,
  gatewayKeys,
  providers,
  onFilter,
  className,
}: {
  readonly gatewayKeyId: string | null
  /** The name snapshotted onto the Request when it was made. */
  readonly recordedName: string | null
  readonly gatewayKeys: readonly GatewayKeyView[] | null
  readonly providers: readonly ProviderView[] | null
  readonly onFilter?: (gatewayKeyId: string) => void
  readonly className?: string
}) {
  // A Request made from the Owner's own playground carries a name but no key.
  if (gatewayKeyId === null) {
    return <span className={className}>{recordedName ?? '—'}</span>
  }

  const key = gatewayKeys?.find((candidate) => candidate.id === gatewayKeyId) ?? null
  const name = key?.name ?? recordedName ?? gatewayKeyId

  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link
          to="/gateway-keys"
          onClick={stop}
          onKeyDown={stop}
          className={cn(TRIGGER_CLASS, 'truncate', className)}
          aria-label={`Gateway Key ${name}`}
        >
          {name}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72" onClick={stop} onKeyDown={stop}>
        <CardHeader
          title={name}
          kind="Gateway Key"
          badge={
            key === null ? (
              gatewayKeys === null ? null : <StatusBadge tone="neutral" label="Deleted" />
            ) : (
              <StatusBadge tone={key.revoked ? 'neutral' : 'healthy'} label={key.revoked ? 'Revoked' : 'Active'} />
            )
          }
        />
        <Facts>
          <Fact label="ID" mono>{gatewayKeyId}</Fact>
          {key !== null && recordedName !== null && recordedName !== key.name && (
            <Fact label="Recorded as">{recordedName}</Fact>
          )}
          {key !== null && (
            <>
              <Fact label="Access">{describeAccess(key, providers)}</Fact>
              {key.corsOrigins.length > 0 && (
                <Fact label="CORS">{key.corsOrigins.length} origin{key.corsOrigins.length === 1 ? '' : 's'}</Fact>
              )}
              <Fact label="Created">{formatTime(key.createdAt)}</Fact>
              <Fact label="Last used">{key.lastUsedAt === null ? 'Never' : formatTime(key.lastUsedAt)}</Fact>
            </>
          )}
        </Facts>
        {key === null && gatewayKeys !== null && (
          <p className="text-muted-foreground mt-3 text-xs">This key has been deleted; the Request kept its name.</p>
        )}
        {onFilter && (
          <FilterButton label="Requests by this key" onClick={() => onFilter(gatewayKeyId)} />
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

export function UpstreamKeyRef({
  keyId,
  providerId,
  providers,
  onFilter,
  className,
}: {
  readonly keyId: string | null
  readonly providerId: string
  readonly providers: readonly ProviderView[] | null
  readonly onFilter?: (keyId: string) => void
  readonly className?: string
}) {
  if (keyId === null) return <span className={className}>—</span>

  const provider = providers?.find((candidate) => candidate.id === providerId) ?? null
  const key = provider?.keys.find((candidate) => candidate.id === keyId) ?? null

  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link
          to="/providers/$providerId"
          params={{ providerId }}
          onClick={stop}
          onKeyDown={stop}
          className={cn(TRIGGER_CLASS, 'font-mono', className)}
          aria-label={`Upstream Key ${keyId}`}
        >
          {keyId}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80" onClick={stop} onKeyDown={stop}>
        <CardHeader
          title={keyId}
          mono
          kind={provider === null ? 'Upstream Key' : `Upstream Key · ${provider.displayName}`}
          badge={
            key !== null ? <KeyHealthBadge health={key.health} /> : providers === null ? null : <StatusBadge tone="neutral" label="Removed" />
          }
        />
        {key !== null ? <UpstreamKeyFacts upstreamKey={key} /> : providers !== null && (
          <p className="text-muted-foreground mt-3 text-xs">This key is no longer attached to the Provider.</p>
        )}
        {onFilter && <FilterButton label="Requests through this key" onClick={() => onFilter(keyId)} />}
      </HoverCardContent>
    </HoverCard>
  )
}

function UpstreamKeyFacts({ upstreamKey: key }: { readonly upstreamKey: KeyView }) {
  return (
    <Facts>
      <Fact label="Endpoint" mono>{key.effectiveBaseUrl}</Fact>
      {key.healthReason !== null && <Fact label="Reason">{key.healthReason}</Fact>}
      {key.healthModel !== null && <Fact label="Model" mono>{key.healthModel}</Fact>}
      {key.retryAfterAt !== null && <Fact label="Until">{formatTime(key.retryAfterAt)}</Fact>}
      <Fact label="Last probe">
        {key.lastProbe === null ? 'Never' : `${key.lastProbe.verdict} · ${formatTime(key.lastProbe.at)}`}
      </Fact>
      {key.allowedModels !== null && <Fact label="Allows">{countModels(key.allowedModels)}</Fact>}
      {key.deniedModels !== null && <Fact label="Denies">{countModels(key.deniedModels)}</Fact>}
      <Fact label="Added">{formatTime(key.createdAt)}</Fact>
    </Facts>
  )
}

function CardHeader({ title, kind, badge, mono = false }: {
  readonly title: string
  readonly kind: string
  readonly badge: ReactNode
  readonly mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={cn('truncate text-sm font-medium', mono && 'font-mono text-xs')}>{title}</span>
        <span className="text-muted-foreground truncate text-[11px]">{kind}</span>
      </div>
      {badge}
    </div>
  )
}

function Facts({ children }: { readonly children: ReactNode }) {
  return <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">{children}</dl>
}

function Fact({ label, mono = false, children }: {
  readonly label: string
  readonly mono?: boolean
  readonly children: ReactNode
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-all', mono && 'font-mono text-[11px]')}>{children}</dd>
    </>
  )
}

function FilterButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="xs" className="mt-3 w-full" onClick={onClick}>
      <ListFilter className="size-3.5" aria-hidden />
      {label}
    </Button>
  )
}

function describeAccess(key: GatewayKeyView, providers: readonly ProviderView[] | null): string {
  if (key.access.mode === 'all') return 'Every Provider'
  if (key.access.providers.length === 0) return 'No Providers'
  return key.access.providers
    .map((entry) => {
      const name = providers?.find((provider) => provider.id === entry.providerId)?.handle ?? entry.providerId
      return entry.models === null ? name : `${name} (${countModels(entry.models)})`
    })
    .join(', ')
}

function countModels(models: readonly string[]): string {
  return `${models.length} model${models.length === 1 ? '' : 's'}`
}

/**
 * A reference sits inside a clickable Request row, and the card portals out of
 * it but still bubbles React events back through it: without this, following
 * a key or pressing the card's button would also open the Request.
 */
function stop(event: SyntheticEvent) {
  event.stopPropagation()
}
