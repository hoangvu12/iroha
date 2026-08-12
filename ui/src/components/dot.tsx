import { cn } from '@/lib/utils'

type Tone = 'danger' | 'warning' | 'healthy' | 'neutral'

interface DotProps {
  readonly tone: Tone
  readonly className?: string
}

/** A small filled circle used to denote status. Always paired with a label. */
export function Dot({ tone, className }: DotProps) {
  const colour: Record<Tone, string> = {
    danger: 'bg-status-danger',
    warning: 'bg-status-warning',
    healthy: 'bg-status-healthy',
    neutral: 'bg-status-neutral',
  }
  return <span aria-hidden className={cn('size-1.5 rounded-full', colour[tone], className)} />
}