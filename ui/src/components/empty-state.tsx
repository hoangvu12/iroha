import { type LucideIcon, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface EmptyStateAction {
  readonly label: string
  readonly onClick?: () => void
  readonly icon?: LucideIcon
}

interface EmptyStateProps {
  readonly icon: LucideIcon
  readonly title: string
  readonly description?: string
  readonly action?: EmptyStateAction
  readonly children?: ReactNode
  readonly className?: string
  readonly compact?: boolean
}

/**
 * A quiet but legible "nothing here yet" surface. A muted icon disc, a short
 * title, an optional hint, and an optional primary action. Used for the empty
 * card body on Overview, Providers, Gateway Keys, Requests, and Audit.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  children,
  className,
  compact = false,
}: EmptyStateProps) {
  const ActionIcon = action?.icon ?? Plus

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'px-2 py-6' : 'px-4 py-10',
        className,
      )}
    >
      <div
        className={cn(
          'bg-muted text-muted-foreground flex items-center justify-center rounded-full',
          compact ? 'size-8' : 'size-10',
        )}
      >
        <Icon
          className={compact ? 'size-4' : 'size-5'}
          aria-hidden
          strokeWidth={1.5}
        />
      </div>
      <p className={cn('text-foreground', compact ? 'text-xs font-medium' : 'text-sm font-medium')}>
        {title}
      </p>
      {description && (
        <p
          className={cn(
            'text-muted-foreground max-w-xs',
            compact ? 'text-xs' : 'text-xs',
          )}
        >
          {description}
        </p>
      )}
      {action && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={action.onClick}
          className="mt-1"
        >
          <ActionIcon className="size-3.5" aria-hidden />
          {action.label}
        </Button>
      )}
      {children}
    </div>
  )
}