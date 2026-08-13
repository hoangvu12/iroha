import { KeyRound } from 'lucide-react'
import { cn } from '@/lib/utils'

interface HealthDistributionProps {
  /** Counts per health label. */
  readonly counts: Readonly<Record<string, number>>
  readonly order: readonly string[]
  readonly labels: Readonly<Record<string, string>>
  readonly tones: Readonly<Record<string, 'healthy' | 'warning' | 'danger' | 'neutral'>>
  readonly className?: string
}

/**
 * A compact stacked bar that shows the proportion of keys in each Key Health
 * state. Replaces a card of mini-statistics with one quiet glance.
 */
export function HealthDistribution({
  counts,
  order,
  labels,
  tones,
  className,
}: HealthDistributionProps) {
  const total = order.reduce((sum, key) => sum + (counts[key] ?? 0), 0)

  if (total === 0) {
    return (
      <div
        role="img"
        aria-label="No keys configured"
        className={cn(
          'border-border bg-muted/40 flex h-12 items-center justify-center gap-2 rounded-md border border-dashed',
          className,
        )}
      >
        <KeyRound
          className="text-muted-foreground size-4"
          aria-hidden
          strokeWidth={1.5}
        />
        <span className="text-muted-foreground text-xs">No upstream keys configured.</span>
      </div>
    )
  }

  const colourFor = (tone: 'healthy' | 'warning' | 'danger' | 'neutral'): string => {
    switch (tone) {
      case 'healthy':
        return 'bg-status-healthy'
      case 'warning':
        return 'bg-status-warning'
      case 'danger':
        return 'bg-status-danger'
      case 'neutral':
        return 'bg-status-neutral'
    }
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        role="img"
        aria-label="Key Health distribution"
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        {order.map((key) => {
          const value = counts[key] ?? 0
          if (value === 0) return null
          return (
            <span
              key={key}
              className={colourFor(tones[key] ?? 'neutral')}
              style={{ width: `${(value / total) * 100}%` }}
              aria-hidden
            />
          )
        })}
      </div>
      <ul className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {order.map((key) => {
          const value = counts[key] ?? 0
          if (value === 0) return null
          return (
            <li key={key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn('size-1.5 rounded-full', colourFor(tones[key] ?? 'neutral'))}
              />
              <span className="text-foreground font-medium">{value}</span>
              <span>{labels[key] ?? key}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}