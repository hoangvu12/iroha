import type { ConnectionSection } from '@/components/navigation'
import { CONNECTION_SECTIONS } from '@/components/navigation'
import { cn } from '@/lib/utils'

interface SectionTabsProps {
  readonly active: ConnectionSection
  readonly onChange: (next: ConnectionSection) => void
  readonly label?: string
}

/**
 * The connection-detail segmented control. Lives under the page title, does not
 * duplicate the global navigation, and is keyboard-traversable with the
 * standard left/right arrow conventions of a tab list.
 */
export function SectionTabs({ active, onChange, label = 'Connection sections' }: SectionTabsProps) {
  const order = CONNECTION_SECTIONS.map((section) => section.id)
  const activeIndex = order.indexOf(active)

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const next = (index + direction + order.length) % order.length
    const target = order[next]
    if (target !== undefined) onChange(target)
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className="border-border bg-background inline-flex items-center rounded-md border p-0.5"
    >
      {CONNECTION_SECTIONS.map((section, index) => {
        const selected = section.id === active
        return (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-current={selected ? 'true' : undefined}
            tabIndex={selected || (activeIndex === -1 && index === 0) ? 0 : -1}
            onClick={() => onChange(section.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'text-muted-foreground rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
              'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              selected && 'bg-secondary text-foreground',
            )}
          >
            {section.label}
          </button>
        )
      })}
    </div>
  )
}