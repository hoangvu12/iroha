import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface CardProps {
  readonly title?: string
  readonly loading?: boolean
  readonly rightSlot?: ReactNode
  readonly children: ReactNode
  readonly className?: string
  /** Larger / more spacious shell (matches the recreation's provider cards). */
  readonly spacious?: boolean
}

/**
 * Standard surface used by Overview and every area page. A soft bordered card
 * with an optional title row and right slot, plus a shadow tuned to feel like
 * paper on a desktop background.
 */
export function Card({ title, rightSlot, children, className, spacious = false }: CardProps) {
  return (
    <div
      className={cn(
        'bg-card flex flex-col rounded-lg border shadow-card',
        spacious ? 'gap-0 p-0' : 'gap-3 p-4',
        className,
      )}
    >
      {title !== undefined && (
        <div
          className={cn(
            'flex items-center justify-between gap-2',
            spacious ? 'border-border border-b px-5 py-4 sm:px-6' : '',
          )}
        >
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {rightSlot}
        </div>
      )}
      {spacious ? (
        <div className={cn(title !== undefined ? 'px-5 py-3 sm:px-6' : 'p-5 sm:p-6')}>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}