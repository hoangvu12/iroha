import type { Readiness } from '@/lib/health'
import { Dot } from '@/components/dot'

const UNREADY_LABEL: Record<string, string> = {
  migrations_pending: 'Migrating',
  shutting_down: 'Shutting down',
  database_unavailable: 'Database unreachable',
}

/**
 * Gateway state in the header. Colour is paired with a word, never used alone,
 * so the meaning survives a monochrome or colour-blind reading.
 */
export function ReadinessPill({ readiness }: { readiness: Readiness | null }) {
  if (readiness === null) {
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
        <Dot tone="neutral" className="animate-pulse" />
        Checking
      </span>
    )
  }

  const { label, tone, detail } = describe(readiness)

  return (
    <span className="flex items-center gap-1.5 text-xs" role="status">
      <Dot tone={tone} />
      <span className="text-foreground font-medium">{label}</span>
      {detail && <span className="text-muted-foreground hidden sm:inline">{detail}</span>}
    </span>
  )
}

function describe(readiness: Readiness): {
  label: string
  tone: 'healthy' | 'warning' | 'danger'
  detail?: string
} {
  switch (readiness.state) {
    case 'ready':
      return { label: 'Ready', tone: 'healthy', detail: readiness.dialect }
    case 'not_ready':
      return {
        label: UNREADY_LABEL[readiness.reason] ?? 'Not ready',
        tone: 'warning',
      }
    case 'unreachable':
      return { label: 'Unreachable', tone: 'danger' }
  }
}
