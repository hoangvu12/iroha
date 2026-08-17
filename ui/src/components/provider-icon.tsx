import { Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useIsDarkMode } from '@/hooks/use-dark-mode'
import { cn } from '@/lib/utils'

/**
 * A Provider's brand tile.
 *
 * Loads the saved Logo Domain through Iroha's authenticated backend resolver.
 * A missing or unresolved image quietly keeps the generic Server icon in the
 * same fixed tile, without exposing vendor tokens or external browser calls.
 */

function resolverUrl(domain: string, theme: 'light' | 'dark'): string {
  const query = new URLSearchParams({ domain, theme })
  return `/api/v1/admin/brand-logos/resolve?${query.toString()}`
}

export function ProviderIcon({
  logoDomain,
  size = 'md',
}: {
  readonly logoDomain: string | null
  readonly size?: 'sm' | 'md'
}) {
  const isDark = useIsDarkMode()
  const theme = isDark ? 'dark' : 'light'
  const tileSize = size === 'sm' ? 'size-6' : 'size-8'
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [logoDomain, theme])

  if (logoDomain === null || failed) {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full text-muted-foreground',
          tileSize,
        )}
        aria-hidden
      >
        <Server
          className={size === 'sm' ? 'size-4' : 'size-5'}
          strokeWidth={1.5}
          aria-hidden
        />
      </span>
    )
  }

  return (
    <span
      className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-full', tileSize)}
      aria-hidden
    >
      <img
        src={resolverUrl(logoDomain, theme)}
        alt=""
        className={cn('size-full object-cover')}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        onLoad={(event) => {
          // A cached 404 with the wrong content-type would load with zero
          // intrinsic size; treat that the same as a fetch error.
          if (event.currentTarget.naturalWidth === 0) setFailed(true)
        }}
      />
    </span>
  )
}
