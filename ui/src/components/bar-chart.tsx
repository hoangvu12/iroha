import { BarChart3 } from 'lucide-react'
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
 * and avoids adding a charting dependency. Bars fade vertically toward the
 * baseline; the most recent bar is saturated to draw the eye. The chart is
 * decorative — each bar also gets an `<title>` so screen readers can read the
 * raw value.
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
        role="img"
        aria-label="No data"
        className={cn(
          'border-border bg-muted/40 flex flex-col items-center justify-center gap-2 rounded-md border border-dashed text-center',
          className,
        )}
        style={{ height }}
      >
        <BarChart3
          className="text-muted-foreground size-5"
          aria-hidden
          strokeWidth={1.5}
        />
        <span className="text-muted-foreground text-xs">
          No data in the last 24 hours.
        </span>
      </div>
    )
  }

  const max = Math.max(1, ...values)
  const barWidth = 100 / values.length
  const gap = Math.min(barWidth * 0.4, 4)
  const gradientId = `bar-chart-fill-${Math.random().toString(36).slice(2, 8)}`

  return (
    <svg
      role="img"
      aria-label={ariaLabel ?? 'Bar chart'}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={cn('block w-full', className)}
      style={{ height }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0.4" />
        </linearGradient>
      </defs>

      <line
        x1="0"
        x2="100"
        y1={height - 0.5}
        y2={height - 0.5}
        stroke="var(--chart-grid)"
        strokeWidth="0.5"
        vectorEffect="non-scaling-stroke"
      />

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
            fill={highlight ? 'var(--chart-1)' : `url(#${gradientId})`}
            opacity={highlight ? 1 : 0.85}
          >
            <title>{value}</title>
          </rect>
        )
      })}
    </svg>
  )
}