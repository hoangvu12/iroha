import { Server } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useIsDarkMode } from '@/hooks/use-dark-mode'
import { cn } from '@/lib/utils'
import type { ProviderTemplateBrand } from '@/lib/providers'

/**
 * A Provider's brand tile.
 *
 * Loads logo.dev directly from the browser when a public build-time token is
 * configured, then falls back directly to Google's favicon service. No logo
 * bytes pass through Iroha or touch its filesystem. If both upstreams fail,
 * the generic server icon remains available without shifting the tile.
 */

const HIDDEN_STYLE: CSSProperties = { display: 'none' }
const LOGO_DEV_TOKEN = import.meta.env.VITE_LOGO_DEV_TOKEN?.trim() ?? ''
const GOOGLE_FAVICON_UPSTREAM = 'https://www.google.com/s2/favicons'

function googleFaviconUrl(domain: string): string {
  const url = new URL(GOOGLE_FAVICON_UPSTREAM)
  url.searchParams.set('domain', domain)
  url.searchParams.set('sz', '64')
  return url.toString()
}

function directLogoUrl(domain: string, theme: 'light' | 'dark'): string {
  if (LOGO_DEV_TOKEN === '') return googleFaviconUrl(domain)
  const url = new URL(`https://img.logo.dev/${domain}`)
  url.searchParams.set('token', LOGO_DEV_TOKEN)
  url.searchParams.set('size', '64')
  url.searchParams.set('retina', 'true')
  url.searchParams.set('format', 'webp')
  url.searchParams.set('theme', theme)
  return url.toString()
}

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
  const isDark = useIsDarkMode()
  const theme = isDark ? 'dark' : 'light'
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
        src={directLogoUrl(brand.domain, theme)}
        alt=""
        className={cn('size-full object-cover')}
        loading="lazy"
        decoding="async"
        onError={(event) => {
          const googleUrl = googleFaviconUrl(brand.domain)
          if (event.currentTarget.src !== googleUrl) {
            event.currentTarget.src = googleUrl
            return
          }
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
