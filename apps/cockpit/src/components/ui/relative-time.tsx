import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  formatExact,
  formatRelative,
  isoInstant,
  refreshAfter,
  relativeParts,
  type TimeInput,
} from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n-context'
import { LOCALE_TAGS } from '@/lib/i18n'

/**
 * "2 hours ago", with the exact instant still in reach.
 *
 * Both halves are the requirement. The sentence is what the operator reads at a
 * glance — every timestamp in this console is `date.toLocaleString()` today,
 * which makes the reader do the arithmetic on every row of every audit table.
 * The instant is what they need the moment two rows have to be put in order, and
 * an audit trail whose timestamps have been rounded into prose is not a trail.
 * So the precision is kept in two places: `datetime` on a real `<time>`, for
 * everything that reads this page as a machine, and a Tooltip for everything
 * that reads it as a person.
 *
 * A Tooltip and not a native `title=`. CUI-WORDS-2 says it plainly: a native
 * title is not a tooltip — it is the same sentence offered to a pointer and to
 * nobody else, invisible on touch and unreachable by keyboard. The `<time>` is
 * therefore a tab stop, because a timestamp rounded to "3 days ago" is exactly
 * the kind of fact an operator has to be able to open, and an affordance only a
 * mouse can open is one most of the people who need it cannot.
 *
 * The label re-renders on its own — a row that says "3 seconds ago" for the next
 * ten minutes is worse than one that never claimed to be live — and the interval
 * follows the unit. That is also why this does NOT read the shared `useNow`
 * clock: that store ticks once a second for everything subscribed to it, and a
 * table of two hundred year-old rows would re-render two hundred times a second
 * to change nothing. `useNow` is for countdowns, where every second is a
 * different number.
 *
 * The locale is the console's own (`CONSOLE_LOCALE`), not the browser's. A
 * German laptop rendered "vor 2 Stunden" in an interface that is English
 * everywhere a formatter cannot reach, which leaves the reader guessing which
 * half of the row was written for them.
 */
export function RelativeTime({
  value,
  label: given,
  className,
  'data-testid': testId = 'relative-time',
}: {
  value: TimeInput
  /**
   * A sentence the caller already computed, printed instead of the derived one
   * — for the surfaces that need more precision than the coarsest unit gives.
   * A deadline reads "in 2h 5m", not "in 2 hours": the minutes are the whole
   * question when something is due. The instant, the `<time>` and the tooltip
   * are still this component's, which is what keeps every timestamp in the
   * console openable by one rule instead of four.
   */
  label?: string
  className?: string
  'data-testid'?: string
}) {
  const { locale } = useI18n()
  const localeTag = LOCALE_TAGS[locale]
  const iso = isoInstant(value)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!iso) return
    // Re-read the clock rather than adding the interval to it: a laptop that was
    // asleep for an hour would otherwise show a label an hour behind.
    const unit = relativeParts(new Date(iso).valueOf(), Date.now()).unit
    const timer = window.setInterval(() => setNow(Date.now()), refreshAfter(unit))
    return () => window.clearInterval(timer)
    // `now` is a dependency on purpose: crossing a unit boundary re-arms the
    // timer at the coarser interval instead of ticking every second for a year.
  }, [iso, now])

  // A value nobody sent is an em dash, never a zero and never the epoch
  // (CUI-SEV-2). `formatInstant` in lib/utils.ts makes the same call.
  if (!iso)
    return (
      <span data-testid={testId} className={cn('text-muted-foreground', className)}>
        —
      </span>
    )

  const exact = formatExact(value, localeTag)
  const label = (
    <time dateTime={iso} data-testid={testId} className={cn('whitespace-nowrap', className)}>
      {given ?? formatRelative(value, now, localeTag)}
    </time>
  )

  // No instant to show is no disclosure to open: a trigger that opens an empty
  // bubble is a tab stop that costs a keyboard user a keystroke and tells them
  // nothing.
  if (!exact) return label

  // The provider is opened locally as well as in the shell, because timestamps
  // are rendered inside dialogs and sheets that mount their own trees, and Radix
  // throws rather than degrades when a Tooltip cannot find one.
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent data-testid={`${testId}-exact`}>{exact}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
