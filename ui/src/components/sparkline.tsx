import { useMemo } from 'react'
import { cn } from '@/lib/utils'

type SparklineTone = 'primary' | 'healthy' | 'warning' | 'danger' | 'muted'

interface SparklineProps {
  readonly data: readonly number[]
  readonly tone?: SparklineTone
  readonly fill?: boolean
  readonly height?: number
  readonly className?: string
}

const TONE_VAR: Record<SparklineTone, string> = {
  primary: 'var(--primary)',
  healthy: 'var(--status-healthy)',
  warning: 'var(--status-warning)',
  danger: 'var(--status-danger)',
  muted: 'var(--muted-foreground)',
}

const WIDTH = 100

function buildPath(values: readonly number[]): { line: string; area: string } | null {
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const stepX = WIDTH / (values.length - 1)

  let line = ''
  for (let i = 0; i < values.length; i++) {
    const x = i * stepX
    const value = values[i] ?? 0
    const y = 24 - ((value - min) / range) * 22 - 1
    line += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `
  }
  const area = `${line.trimEnd()} L${WIDTH} 24 L0 24 Z`
  return { line: line.trimEnd(), area }
}

/**
 * A tiny inline trend line meant to live at the bottom of a KPI card. It has
 * no axes, no tooltip, no chrome — just a smooth curve and a soft fill.
 */
export function Sparkline({
  data,
  tone = 'primary',
  fill = true,
  height = 28,
  className,
}: SparklineProps) {
  const paths = useMemo(() => buildPath(data), [data])
  const stroke = TONE_VAR[tone]

  if (paths === null) {
    return (
      <svg
        viewBox={`0 0 ${WIDTH} 24`}
        preserveAspectRatio="none"
        height={height}
        className={cn('w-full', className)}
        aria-hidden
      >
        <line x1="0" y1="23" x2={WIDTH} y2="23" stroke={stroke} strokeOpacity={0.25} strokeWidth={1} />
      </svg>
    )
  }

  const gradientId = `spark-${tone}-${data.length}-${(data[data.length - 1] ?? 0).toFixed(0)}`

  return (
    <svg
      viewBox={`0 0 ${WIDTH} 24`}
      preserveAspectRatio="none"
      height={height}
      className={cn('w-full overflow-visible', className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <path d={paths.area} fill={`url(#${gradientId})`} />}
      <path
        d={paths.line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}