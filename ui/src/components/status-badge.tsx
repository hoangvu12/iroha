import { cn } from '@/lib/utils'

export type StatusTone = 'danger' | 'warning' | 'healthy' | 'neutral'

interface StatusBadgeProps {
  readonly label: string
  readonly tone: StatusTone
  readonly className?: string
}

/**
 * A status pill that pairs a colour with a word. Colour alone is not the signal,
 * because the meaning must survive a monochrome or colour-blind reading.
 */
export function StatusBadge({ label, tone, className }: StatusBadgeProps) {
  const palette: Record<StatusTone, string> = {
    danger: 'bg-status-danger/10 text-status-danger border-status-danger/30',
    warning: 'bg-status-warning/10 text-status-warning border-status-warning/30',
    healthy: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30',
    neutral: 'bg-muted text-muted-foreground border-border',
  }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        palette[tone],
        className,
      )}
      data-status={tone}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          tone === 'danger' && 'bg-status-danger',
          tone === 'warning' && 'bg-status-warning',
          tone === 'healthy' && 'bg-status-healthy',
          tone === 'neutral' && 'bg-status-neutral',
        )}
      />
      <span>{label}</span>
    </span>
  )
}