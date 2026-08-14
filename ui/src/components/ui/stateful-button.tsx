import * as React from 'react'
import type { VariantProps } from 'class-variance-authority'
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { Button, type buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>

type ButtonState = 'idle' | 'loading' | 'success' | 'error'

interface StatefulButtonProps
  extends Omit<React.ComponentProps<'button'>, 'children' | 'onClick'> {
  /**
   * Click handler. May return a Promise: while it settles the button shows a
   * spinner, then flips to success or error. Throw / reject to land in error.
   */
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => unknown | Promise<unknown>
  /** Label shown in idle state. Becomes the button's accessible name. */
  readonly children: React.ReactNode
  /** Label shown briefly after a successful action. Defaults to "Done". */
  readonly successLabel?: React.ReactNode
  /** Label shown after a failed action. Defaults to "Failed". */
  readonly errorLabel?: React.ReactNode
  /** How long the success state stays visible before snapping back. */
  readonly successDurationMs?: number
  /** How long the error state stays visible before snapping back. */
  readonly errorDurationMs?: number
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
}

/**
 * A button that owns the lifecycle of a single action: idle → loading →
 * success/error → idle. Replaces the busy-only pattern (button text changes
 * to "Saving…", then nothing happens) with feedback the Owner can see.
 */
function StatefulButton({
  onClick,
  children,
  successLabel = 'Done',
  errorLabel = 'Failed',
  successDurationMs = 1400,
  errorDurationMs = 2400,
  variant,
  size,
  disabled,
  className,
  type = 'button',
  ...buttonProps
}: StatefulButtonProps) {
  const [state, setState] = React.useState<ButtonState>('idle')
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const resetTimer = React.useRef<number | null>(null)

  const clearTimer = React.useCallback(() => {
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
  }, [])

  React.useEffect(() => clearTimer, [clearTimer])

  const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (state === 'loading') return
    clearTimer()
    setState('loading')
    setErrorMessage(null)

    const settle = (next: 'success' | 'error', message: string | null, duration: number) => {
      setErrorMessage(message)
      setState(next)
      resetTimer.current = window.setTimeout(() => {
        setState('idle')
        setErrorMessage(null)
        resetTimer.current = null
      }, duration)
    }

    try {
      await onClick(event)
      settle('success', null, successDurationMs)
    } catch (cause: unknown) {
      const message =
        cause instanceof Error && cause.message !== '' ? cause.message : 'That did not work.'
      settle('error', message, errorDurationMs)
    }
  }

  const isDisabled = disabled === true || state === 'loading'

  const content =
    state === 'loading' ? (
      <>
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span>{children}</span>
      </>
    ) : state === 'success' ? (
      <>
        <Check className="size-3.5" aria-hidden />
        <span>{successLabel}</span>
      </>
    ) : state === 'error' ? (
      <>
        <CircleAlert className="size-3.5" aria-hidden />
        <span>{errorLabel}</span>
      </>
    ) : (
      children
    )

  const stateClass =
    state === 'success'
      ? 'border-status-healthy/30 bg-status-healthy/10 text-status-healthy hover:bg-status-healthy/10 dark:bg-status-healthy/15 dark:hover:bg-status-healthy/15'
      : state === 'error'
        ? 'border-status-danger/30 bg-status-danger/10 text-status-danger hover:bg-status-danger/10 dark:bg-status-danger/15 dark:hover:bg-status-danger/15'
        : null

  return (
    <Button
      {...buttonProps}
      type={type}
      variant={variant}
      size={size}
      disabled={isDisabled}
      aria-busy={state === 'loading' ? true : undefined}
      aria-live={state === 'error' ? 'polite' : undefined}
      onClick={(event) => void handleClick(event)}
      className={cn(stateClass, className)}
      title={state === 'error' && errorMessage !== null ? errorMessage : buttonProps.title}
    >
      {content}
    </Button>
  )
}

export { StatefulButton }
export type { StatefulButtonProps }