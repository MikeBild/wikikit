import { ChevronLeft, ChevronRight } from 'lucide-react'
import { hasNext, hasPrevious, nextPage, pageNumber, previousPage, type CursorPage } from '@/lib/cursor'
import { cn } from '@/lib/utils'
import { Button } from './button'

/**
 * Forward and back through a list, and an honest sentence about where the
 * operator is.
 *
 * Two moves, never numbered links. A window into a whole array could address
 * "page 7", but the same control has to work the day a read starts paging with an
 * opaque cursor, where page 7 is unaddressable — so the position is reported as a
 * fact the operator walked to, and the only moves offered are the two that always
 * exist.
 *
 * `total` is the honesty valve. A count of rows the console holds is a total only
 * when the response held every row; when it did not, `null` is passed and this
 * prints a position instead of inventing "1–50 of 4 312" out of a number nobody
 * sent. `note` carries the one remaining caveat — a read that was capped by a
 * `limit` has a count, not a total, and says so in the caller's words.
 *
 * It renders nothing on a list that fits in one window. A pager under six rows is
 * decoration, and this console's pixels go to exceptions.
 */
export function Pagination({
  page,
  nextCursor,
  onChange,
  isLoading,
  shown,
  start = 0,
  total = null,
  note,
  unit = 'rows',
  className,
  'data-testid': testId = 'pagination',
}: {
  page: CursorPage
  /** The cursor for the window after this one — from the response, or minted over a whole array. */
  nextCursor: string | null | undefined
  onChange: (page: CursorPage) => void
  isLoading?: boolean
  /** How many rows this window actually holds. A count, never a total. */
  shown: number
  /** Index of the first row on screen. Only meaningful alongside `total`. */
  start?: number
  /** Every row there is, when the response held every row. `null` when nobody can say. */
  total?: number | null
  /** An extra fact about the count — e.g. that the read was capped by a `limit`. */
  note?: string
  unit?: string
  className?: string
  'data-testid'?: string
}) {
  const back = hasPrevious(page)
  const forward = hasNext(nextCursor)
  if (!back && !forward) return null

  const position =
    total === null
      ? // No total exists, so the page number is the only place-marker there is.
        `Page ${pageNumber(page)} · ${shown} ${unit}`
      : `Showing ${start + 1}–${start + shown} of ${total} ${unit}`

  return (
    <nav
      aria-label="Pagination"
      data-testid={testId}
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs',
        className,
      )}
    >
      <span data-testid={`${testId}-position`} className="text-muted-foreground">
        {position}
        {note ? ` · ${note}` : null}
        {/* Worth saying only when no total is on screen: without one, a disabled
            Next is otherwise indistinguishable from a slow one. */}
        {total === null && !forward ? ' · end of the list' : null}
        {isLoading ? ' · loading…' : null}
      </span>
      <span className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid={`${testId}-previous`}
          disabled={!back || isLoading}
          onClick={() => onChange(previousPage(page))}
        >
          <ChevronLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid={`${testId}-next`}
          // Disabled while a page is in flight as well as at the end: the rows on
          // screen carry the only cursor forward, so a second click before the new
          // ones land would advance twice through one of them.
          disabled={!forward || isLoading}
          onClick={() => onChange(nextPage(page, nextCursor))}
        >
          Next
          <ChevronRight data-icon="inline-end" />
        </Button>
      </span>
    </nav>
  )
}
