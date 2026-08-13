import { Server, Wind } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ProviderIcon({
  displayName,
  baseUrl,
  size = 'md',
}: {
  readonly displayName: string
  readonly baseUrl: string
  readonly size?: 'sm' | 'md'
}) {
  const kind = detectProviderKind(displayName, baseUrl)
  const baseClasses = cn(
    'flex shrink-0 items-center justify-center rounded-lg border',
    size === 'sm' ? 'size-6' : 'size-8',
  )
  const iconClass = cn(size === 'sm' ? 'size-3.5' : 'size-4')

  if (kind === 'openai') {
    return (
      <span className={`${baseClasses} border-black/10 bg-white`}>
        <OpenAIMark size={size} />
      </span>
    )
  }
  if (kind === 'anthropic') {
    return (
      <span className={`${baseClasses} border-[#E5E1D8] bg-[#F0EBE1]`}>
        <span
          className={cn(
            'font-serif font-bold leading-none text-stone-800',
            size === 'sm' ? 'text-[10px]' : 'text-sm',
          )}
        >
          A
        </span>
      </span>
    )
  }
  if (kind === 'mistral') {
    return (
      <span className={`${baseClasses} border-orange-100 bg-orange-50 text-orange-500`}>
        <Wind className={iconClass} aria-hidden strokeWidth={1.75} />
      </span>
    )
  }
  return (
    <span className={`${baseClasses} border-border bg-muted text-muted-foreground`}>
      <Server className={iconClass} aria-hidden strokeWidth={1.5} />
    </span>
  )
}

export function OpenAIMark({ size = 'md' }: { readonly size?: 'sm' | 'md' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={size === 'sm' ? 'size-3.5' : 'size-5'}
      fill="currentColor"
      aria-hidden
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A6.0651 6.0651 0 0 0 19.0192 19.82a5.9847 5.9847 0 0 0 3.9977-2.9 6.0462 6.0462 0 0 0-.735-7.0988zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.0993 3.8558L12.5973 8.3829a.0804.0804 0 0 1 .0332-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.1408 1.6464 4.4708 4.4708 0 0 1 .5346 3.0137l-.1416-.0852-4.783-2.7582a.7712.7712 0 0 0-.7806 0l-5.8428 3.3685v-2.3324l.0006 2.3324zm-1.12-3.8558a4.485 4.485 0 0 1-2.3655 1.9728V4.1818a.7664.7664 0 0 0-.3879-.6765L8.7523.151a.0757.0757 0 0 1 .071 0l4.8303 2.7865a4.504 4.504 0 0 1 3.6666 4.9123zm-3.218 2.0526l-2.102-1.2132-2.102 1.2132V8.6722l2.102-1.2133 2.102 1.2133v2.4276z" />
    </svg>
  )
}

export function detectProviderKind(
  displayName: string,
  baseUrl: string,
): 'openai' | 'anthropic' | 'mistral' | 'unknown' {
  const haystack = `${displayName} ${baseUrl}`.toLowerCase()
  if (haystack.includes('openai')) return 'openai'
  if (haystack.includes('anthropic') || haystack.includes('claude')) return 'anthropic'
  if (haystack.includes('mistral')) return 'mistral'
  return 'unknown'
}