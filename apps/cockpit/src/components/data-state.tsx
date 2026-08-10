import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError } from '@/api/client'
import { EmptyState } from '@/components/empty-state'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { describeFailure } from '@/lib/failure'
import { isRetrying, readFailure, readPhase } from '@/lib/read-state'
import { useI18n } from '@/lib/i18n-context'
import { I18nText } from '@/components/i18n-text'

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ FOUR STATES, ALWAYS DISTINGUISHED, THROUGH THIS ONE COMPONENT.           │
 * │                                                                          │
 * │   loading — we have not asked yet, or the answer has not arrived         │
 * │   error   — we asked and were refused, or could not ask                  │
 * │   empty   — we asked, we were answered, and the answer is "none"         │
 * │   rows    — we asked and there is something to show                      │
 * │                                                                          │
 * │ Three of those routinely collapse into one blank rectangle, and a blank  │
 * │ rectangle is the worst thing a knowledge console can draw: "no pending   │
 * │ proposals", "the proposals endpoint is refusing you" and "the proposals  │
 * │ request is still in flight" are three different worlds, and a reviewer   │
 * │ who cannot tell them apart will act on the wrong one. Empty is           │
 * │ especially dangerous — an empty review queue is GOOD NEWS, and it        │
 * │ has to look like good news rather than like a page that failed to load. │
 * │                                                                          │
 * │ One component so the four cannot drift apart across the pages.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export interface DataStateProps<T> {
  query: UseQueryResult<T>
  /**
   * A skeleton in the SHAPE of what is coming. Required, not optional: making
   * it optional is how every caller ends up with the default spinner, and a
   * spinner tells an operator nothing except "wait".
   */
  skeleton: ReactNode
  /** True when the answer arrived and contains nothing. */
  isEmpty?: (data: T) => boolean
  empty?: ReactNode
  children: (data: T) => ReactNode
}

export function DataState<T>({ query, skeleton, isEmpty, empty, children }: DataStateProps<T>) {
  const { t } = useI18n()
  // The phase, not `isPending`. A query that TanStack is still retrying stays
  // 'pending' with the server's refusal already sitting in `failureReason`, so
  // branching on `isPending` first drew a skeleton over an answer that had
  // arrived — for the whole retry budget. See lib/read-state.ts.
  const phase = readPhase(query)

  if (phase === 'error') {
    const error = readFailure(query)
    const api = error instanceof ApiError ? error : null
    // One decision, shared with the tables — an <Alert> is no legal child of a
    // <tbody>, so the rule had to live outside the JSX or be written twice.
    const notice = describeFailure({
      status: api?.status ?? null,
      message: error instanceof Error ? error.message : String(error),
      actions: api?.nextBestActions ?? [],
      retrying: isRetrying(query),
    })
    return (
      <Alert tone={notice.tone} title={notice.title} actions={notice.actions} data-testid="data-state-error">
        <div className="flex flex-col gap-2">
          <span>{notice.message}</span>
          {/* A refusal is terminal: WikiKit understood the request and
              answered it — the scope is missing (`knowledge:review` on a queue
              this session may only read), or the thing is. Offering
              "retry" there teaches the operator to click a button that cannot
              ever work — and so does offering it while an automatic attempt is
              already in the air. lib/failure.ts owns which is which. */}
          {notice.retryable ? (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              data-testid="data-state-retry"
              onClick={() => void query.refetch()}
            >
              {t('common.tryAgain')}
            </Button>
          ) : null}
        </div>
      </Alert>
    )
  }

  if (phase === 'loading')
    return (
      <div data-testid="data-state-loading">
        <I18nText>{skeleton}</I18nText>
      </div>
    )

  const data = query.data as T
  // The node the page passed, rendered as it is. This used to wrap whatever it
  // was given in its own dashed box with its own icon, which put one dashed
  // rectangle inside another the moment a page passed an <EmptyState> —
  // "cards do not nest" (CUI-LADDER-2). The default keeps a title and a
  // description for the branches nobody has written words for yet (CUI-LOAD-3).
  if (isEmpty?.(data))
    return (
      <div data-testid="data-state-empty">
        <I18nText>{empty ?? <EmptyState title={t('table.empty')} description={t('table.empty')} />}</I18nText>
      </div>
    )

  return (
    <div data-testid="data-state-ready">
      <I18nText>{children(data)}</I18nText>
    </div>
  )
}

/** Rows of a table, shaped like the table. */
export function RowSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading" data-testid="row-skeleton">
      {Array.from({ length: rows }, (_unused, row) => (
        <div key={row} className="flex gap-3">
          {Array.from({ length: columns }, (_ignored, column) => (
            <Skeleton key={column} className={column === 0 ? 'h-6 w-40' : 'h-6 flex-1'} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Cards of a grid, shaped like the grid. */
export function CardSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      aria-busy="true"
      aria-label="Loading"
      data-testid="card-skeleton"
    >
      {Array.from({ length: cards }, (_unused, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  )
}
