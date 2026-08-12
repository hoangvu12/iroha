import { cn } from '@/lib/utils'

interface BarChartProps {
  /** Values, each rendered as one bar. */
  readonly values: readonly number[]
  /** Height in pixels. Bars scale to fit. */
  readonly height?: number
  /** Tone for the active bar (the last value is highlighted). */
  readonly highlightLast?: boolean
  readonly className?: string
  readonly ariaLabel?: string
}

/**
 * A minimal, accessible bar chart for request volume.
 *
 * Drawn directly as SVG so it stays consistent with the Geist/OKLCH language
 * and avoids adding a charting dependency. The chart is decorative — each bar
 * also gets an `<title>` so screen readers can read the raw value.
 */
export function BarChart({
  values,
  height = 64,
  highlightLast = true,
  className,
  ariaLabel,
}: BarChartProps) {
  if (values.length === 0) {
    return (
      <div
        className={cn('text-muted-foreground flex items-center text-xs', className)}
        style={{ height }}
      >
        No data yet.
      </div>
    )
  }

  const max = Math.max(1, ...values)
  const barWidth = 100 / values.length
  const gap = Math.min(barWidth * 0.4, 4)

  return (
    <svg
      role="img"
      aria-label={ariaLabel ?? 'Bar chart'}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={cn('block w-full', className)}
      style={{ height }}
    >
      {values.map((value, index) => {
        const barHeight = (value / max) * (height - 4)
        const x = index * barWidth + gap / 2
        const width = barWidth - gap
        const y = height - barHeight
        const highlight = highlightLast && index === values.length - 1
        return (
          <rect
            key={index}
            x={x}
            y={y}
            width={Math.max(0.5, width)}
            height={Math.max(0, barHeight)}
            rx={1}
            fill={highlight ? 'var(--chart-1)' : 'var(--chart-2)'}
            opacity={highlight ? 1 : 0.6}
          >
            <title>{value}</title>
          </rect>
        )
      })}
    </svg>
  )
}