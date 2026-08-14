import { Server } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { ProviderTemplateBrand } from '@/lib/providers'

/**
 * A Provider's brand tile.
 *
 * Renders a circular `<img>` sourced from the cached logo.dev bytes (or the
 * Google favicon fallback when no logo.dev token is configured) at
 * `/api/v1/brand-logos/:templateId`. Falls back to a generic server icon when
 * the template has no brand, the template id is missing, or the upstream
 * refuses to answer. The `<img onerror>` handler swaps to the icon sibling so
 * every consumer renders the component branchlessly.
 */

const HIDDEN_STYLE: CSSProperties = { display: 'none' }

function hideElement(target: HTMLElement | SVGElement): void {
  ;(target as HTMLElement).style.display = 'none'
}

function showElement(target: HTMLElement | SVGElement): void {
  ;(target as HTMLElement).style.display = ''
}

export function ProviderIcon({
  brand,
  templateId,
  size = 'md',
}: {
  readonly brand: ProviderTemplateBrand | null
  readonly templateId?: string | undefined
  readonly size?: 'sm' | 'md'
}) {
  const tileSize = size === 'sm' ? 'size-6' : 'size-8'

  if (brand === null || templateId === undefined || templateId === '') {
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
        src={`/api/v1/brand-logos/${encodeURIComponent(templateId)}`}
        alt=""
        className={cn('size-full object-cover')}
        loading="lazy"
        decoding="async"
        onError={(event) => {
          hideElement(event.currentTarget)
          const fallback = event.currentTarget.nextElementSibling
          if (fallback !== null) showElement(fallback as HTMLElement)
        }}
        onLoad={(event) => {
          // A cached 404 with the wrong content-type would load with zero
          // intrinsic size; treat that the same as a fetch error.
          const img = event.currentTarget
          if (img.naturalWidth === 0) {
            hideElement(img)
            const fallback = img.nextElementSibling
            if (fallback !== null) showElement(fallback as HTMLElement)
          }
        }}
      />
      <Server
        className={cn(
          size === 'sm' ? 'size-4' : 'size-5',
          'text-muted-foreground',
        )}
        strokeWidth={1.5}
        aria-hidden
        style={HIDDEN_STYLE}
      />
    </span>
  )
}
