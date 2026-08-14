import { Server } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { ProviderTemplateBrand } from '@/lib/providers'

/**
 * A Provider's brand tile.
 *
 * Renders one of three shapes:
 *   1. Brand + template id → tinted tile with the cached logo.dev image.
 *   2. Brand + template id, image failed → tinted tile with a brand-coloured
 *      Server icon, so the Owner can still tell which Provider the row is.
 *   3. No brand (generic default, hand-configured Provider) → neutral tile
 *      with a muted Server icon.
 *
 * The 404 path is hit when LOGO_DEV_TOKEN is unset or logo.dev refuses; the
 * brand-coloured fallback makes that case distinguishable from "no brand" so
 * the Owner can tell at a glance whether their deployment just needs the
 * vendor token.
 */

const HIDDEN_STYLE: CSSProperties = { display: 'none' }

function accentBackground(hex: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  if (match === null) return 'transparent'
  const r = parseInt(match[1] as string, 16)
  const g = parseInt(match[2] as string, 16)
  const b = parseInt(match[3] as string, 16)
  // 22% brand over the surface reads as a clear brand wash in both light and
  // dark modes. Lower alpha disappears on a white card; higher overwhelms the
  // logo. The fallback Server icon is tinted the same colour so the row
  // still reads as "this Provider" without the logo.
  return `rgba(${r}, ${g}, ${b}, 0.22)`
}

function accentColor(hex: string): string {
  // A solid brand colour for the fallback icon when the image did not load.
  // CSS `color-mix` keeps the icon legible on the tinted tile in either
  // theme: a slight darken in light mode, a slight lighten in dark.
  return `color-mix(in oklab, ${hex} 92%, var(--foreground))`
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
  const tileSize = size === 'sm' ? 'size-6' : 'size-8'
  const imgSize = size === 'sm' ? 'size-4' : 'size-5'

  if (brand === null || templateId === undefined || templateId === '') {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground',
          tileSize,
        )}
        aria-hidden
      >
        <Server className={imgSize} strokeWidth={1.5} aria-hidden />
      </span>
    )
  }

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-foreground/10',
        tileSize,
      )}
      style={{
        backgroundColor: accentBackground(brand.accentColor),
        color: accentColor(brand.accentColor),
      }}
      aria-hidden
    >
      <img
        src={`/api/v1/brand-logos/${encodeURIComponent(templateId)}`}
        alt=""
        className={cn('object-contain', imgSize)}
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
      <Server className={imgSize} strokeWidth={1.5} aria-hidden style={HIDDEN_STYLE} />
    </span>
  )
}
