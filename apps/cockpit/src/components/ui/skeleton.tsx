import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * A placeholder shaped like the thing that is coming.
 *
 * The console never shows a centred spinner. A spinner tells an operator "wait"
 * and nothing else; a placeholder the size of the missing content tells them
 * where to look when it arrives, and holds the layout still so the row they were
 * already reaching for does not move out from under the pointer.
 *
 * `aria-hidden` because the geometry is not the fact. The announcement belongs
 * once, on the surface that owns the load — `components/data-state.tsx` is where
 * that happens in this console. Fourteen grey rectangles announced one by one is
 * worse than silence.
 *
 * `motion-reduce:animate-none` is not decoration: a pulsing rectangle is exactly
 * the kind of repetitive motion `prefers-reduced-motion` exists to stop, and a
 * review console — where somebody sits reading proposal diffs and their
 * citations one after another — is a thing people leave open for hours.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  )
}
