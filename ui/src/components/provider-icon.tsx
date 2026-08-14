import { Server, Wind } from 'lucide-react'
import { cn } from '@/lib/utils'

type ProviderBrand = 'openai' | 'openrouter' | 'MiniMax' | 'anthropic' | 'mistral' | 'unknown'

const TEMPLATE_BRAND: Record<string, ProviderBrand> = {
  openai: 'openai',
  openrouter: 'openrouter',
  MiniMax: 'MiniMax',
}

const BRAND_FILL: Record<Exclude<ProviderBrand, 'unknown'>, string> = {
  openai: '#10A37F',
  openrouter: '#3D55E6',
  MiniMax: '#F43F5E',
  anthropic: '#3F3F3F',
  mistral: '#EA580C',
}

/**
 * Brand-tinted tile backgrounds. Light mode tints white; dark mode mixes the
 * brand into the slightly-lifted popover surface so the tile stands off the
 * canvas. Pinned via Tailwind's `dark:` variant because an inline `var()` swap
 * can't reach a per-element custom property from `:root` (the inner lookup
 * happens at the rule's definition point, not the element).
 */
const TILE_BG: Record<Exclude<ProviderBrand, 'unknown'>, string> = {
  openai:
    'bg-[color-mix(in_oklab,#10A37F_14%,white)] dark:bg-[color-mix(in_oklab,#10A37F_32%,var(--popover))]',
  openrouter:
    'bg-[color-mix(in_oklab,#3D55E6_14%,white)] dark:bg-[color-mix(in_oklab,#3D55E6_32%,var(--popover))]',
  MiniMax:
    'bg-[color-mix(in_oklab,#F43F5E_14%,white)] dark:bg-[color-mix(in_oklab,#F43F5E_32%,var(--popover))]',
  anthropic:
    'bg-[color-mix(in_oklab,#3F3F3F_14%,white)] dark:bg-[color-mix(in_oklab,#3F3F3F_32%,var(--popover))]',
  mistral:
    'bg-[color-mix(in_oklab,#EA580C_14%,white)] dark:bg-[color-mix(in_oklab,#EA580C_32%,var(--popover))]',
}

export function ProviderIcon({
  displayName,
  baseUrl,
  templateId,
  size = 'md',
}: {
  readonly displayName: string
  readonly baseUrl: string
  readonly templateId?: string
  readonly size?: 'sm' | 'md'
}) {
  const brand = resolveBrand(templateId, displayName, baseUrl)
  const tileSize = size === 'sm' ? 'size-6' : 'size-8'
  const svgSize = size === 'sm' ? 'size-3.5' : 'size-5'

  if (brand === 'unknown') {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground',
          tileSize,
        )}
        aria-hidden
      >
        <Server className={svgSize} strokeWidth={1.5} />
      </span>
    )
  }

  if (brand === 'anthropic') {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full border border-foreground/10',
          tileSize,
          TILE_BG.anthropic,
        )}
        style={{ color: BRAND_FILL.anthropic }}
        aria-hidden
      >
        <span
          className={cn(
            'font-serif font-bold leading-none',
            size === 'sm' ? 'text-[10px]' : 'text-sm',
          )}
        >
          A
        </span>
      </span>
    )
  }

  if (brand === 'mistral') {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full border border-foreground/10',
          tileSize,
          TILE_BG.mistral,
        )}
        style={{ color: BRAND_FILL.mistral }}
        aria-hidden
      >
        <Wind className={svgSize} strokeWidth={1.75} />
      </span>
    )
  }

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border border-foreground/10',
        tileSize,
        TILE_BG[brand],
      )}
      style={{ color: BRAND_FILL[brand] }}
      aria-hidden
    >
      {brand === 'openai' && <OpenAIMark svgSize={svgSize} />}
      {brand === 'openrouter' && <OpenRouterMark svgSize={svgSize} />}
      {brand === 'MiniMax' && <MiniMaxMark svgSize={svgSize} />}
    </span>
  )
}

function resolveBrand(
  templateId: string | undefined,
  displayName: string,
  baseUrl: string,
): ProviderBrand {
  if (templateId !== undefined && templateId !== '') {
    const direct = TEMPLATE_BRAND[templateId]
    if (direct !== undefined) return direct
  }
  return detectProviderKind(displayName, baseUrl)
}

export function OpenAIMark({
  svgSize = 'size-5',
}: {
  readonly svgSize?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn(svgSize)}
      fill="currentColor"
      aria-hidden
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4704 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

function OpenRouterMark({ svgSize }: { readonly svgSize: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn(svgSize)}
      fill="currentColor"
      aria-hidden
    >
      <path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" />
    </svg>
  )
}

function MiniMaxMark({ svgSize }: { readonly svgSize: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn(svgSize)}
      fill="currentColor"
      aria-hidden
    >
      <path d="M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997" />
    </svg>
  )
}

export function detectProviderKind(
  displayName: string,
  baseUrl: string,
): ProviderBrand {
  const haystack = `${displayName} ${baseUrl}`.toLowerCase()
  if (haystack.includes('openai')) return 'openai'
  if (haystack.includes('anthropic') || haystack.includes('claude')) return 'anthropic'
  if (haystack.includes('mistral')) return 'mistral'
  return 'unknown'
}