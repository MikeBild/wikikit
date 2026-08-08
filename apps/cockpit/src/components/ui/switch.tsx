import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * A checkbox styled as a track, not a `div` with a click handler: `role="switch"`
 * on a real button keeps it operable by keyboard and announced correctly, which
 * a styled div never is. `...props` passes `data-testid` through.
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...props
}: Omit<ComponentProps<'button'>, 'onChange' | 'type'> & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-muted border-border',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-surface shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
