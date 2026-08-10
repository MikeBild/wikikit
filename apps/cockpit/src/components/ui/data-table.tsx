import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3, Inbox } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { ApiError } from '@/api/client'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { CursorPage } from '@/lib/cursor'
import { describeFailure, type Failure } from '@/lib/failure'
import { isRetrying, readFailure, readPhase, type ReadSnapshot } from '@/lib/read-state'
import {
  capabilitiesOf,
  clampPage,
  defaultVisible,
  isCapped,
  isOfferable,
  nextSort,
  reconcileSort,
  sortReach,
  toggleVisible,
  windowOf,
  type ColumnCapability,
  type Paging,
  type SortReach,
  type TableView,
} from '@/lib/table-view'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n-context'
import { I18nText } from '@/components/i18n-text'

/**
 * The console's lists, on the shared `Table` rather than instead of it.
 *
 * `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` stay the
 * markup — including the pinned last column below `md` that makes a row's actions
 * reachable on a phone — and `DataState`'s four states stay the discipline. What
 * this adds is the three things every list in this console was missing: a window
 * over the rows, a header that can reorder them, and a way to put a column away.
 *
 * All three are capability-driven, from `@/lib/table-view`. A sort control is
 * rendered only where a sort would actually cover the whole result — see
 * `sortReach` — because a header arrow that quietly reorders one page of forty is
 * indistinguishable from a sorted list and is not one. Every list read in this
 * console answers a whole array, so every column with a comparator grades
 * `'complete'` and is honestly offerable; the guard is here for the read that
 * starts paging later, so the control disappears on that day instead of lying.
 *
 * The four states are still four, and they are `DataState`'s, restated for a
 * `<tbody>` because an `<Alert>` is not a legal child of one. Loading is skeleton
 * ROWS — the header is already on screen, and a single centred "Loading…" cell
 * collapses the table to one row and then expands it under a pointer already
 * aimed at a row action. Error keeps the server's own words and its
 * `next_best_actions`, and **a 403 renders no retry** (`@/lib/failure` owns that
 * rule, and a unit test holds it). Empty is its own state, distinguishable from
 * both, because an empty queue is often the good news.
 */

/** A column: the capability flags, the label, and how to draw the cell. */
export interface DataColumn<Row> {
  id: string
  label: string
  cell: (row: Row) => ReactNode
  /**
   * Presence is the capability: a column with a comparator can be ordered by the
   * console, one without it cannot be ordered at all. `compareText`, `compareTime`
   * and `compareNumber` in `@/lib/table-view` are the console's shared answers for
   * what a missing value sorts as.
   */
  compare?: (left: Row, right: Row) => number
  /** The endpoint itself accepts an order for this column. */
  server?: boolean
  /** Identifies the row or carries its actions. Hiding it breaks the list. */
  required?: boolean
  hiddenByDefault?: boolean
  /** A date column's first click should be newest-first, not oldest-first. */
  descFirst?: boolean
  className?: string
  /** For a column whose header is deliberately blank, such as row actions. */
  headerHidden?: boolean
}

/**
 * The read's state, as `DataState` reads it. `UseQueryResult` satisfies this
 * structurally, so a page passes the query it already has.
 */
export interface TableQuery extends ReadSnapshot {
  refetch?: () => unknown
}

export function DataTable<Row>({
  testId,
  columns,
  rows,
  rowKey,
  rowTestId,
  rowAttributes,
  query,
  empty,
  view,
  onViewChange,
  page,
  onPageChange,
  pageSize = 25,
  paging = 'whole',
  nextCursor,
  unit = 'rows',
  cap,
  capNote,
  toolbar,
  tableClassName,
}: {
  testId: string
  columns: readonly DataColumn<Row>[]
  /** Every row for `'whole'`, this page's rows for `'cursor'`. */
  rows: readonly Row[]
  rowKey: (row: Row) => string
  rowTestId?: (row: Row) => string
  rowAttributes?: (row: Row) => Record<string, string>
  query: TableQuery
  /** What to say when the answer arrived and there is nothing in it. */
  empty?: ReactNode
  view: TableView
  onViewChange: (view: TableView) => void
  page: CursorPage
  onPageChange: (page: CursorPage) => void
  pageSize?: number
  paging?: Paging
  /** The cursor the response offered. Ignored — and not needed — when `'whole'`. */
  nextCursor?: string | null
  unit?: string
  /** The `limit` this read was given, if any. A limit is a ceiling, not a page. */
  cap?: number | null
  capNote?: string
  /** Filters and other controls that belong beside the column menu. */
  toolbar?: ReactNode
  /** Optional layout contract for a table whose columns must fit without horizontal scrolling. */
  tableClassName?: string
}) {
  const { t, text } = useI18n()
  const specs = useMemo(() => capabilitiesOf(columns), [columns])
  const shown = useMemo(() => columns.filter((column) => view.visible.includes(column.id)), [columns, view.visible])
  const sort = reconcileSort(specs, paging, view.visible, view.sort)

  const ordered = useMemo(() => {
    if (paging !== 'whole' || !sort) return rows
    const compare = columns.find((entry) => entry.id === sort.column)?.compare
    if (!compare) return rows
    // Sort a copy: the array belongs to the query cache. `Array.sort` is stable,
    // so ties keep the order the endpoint sent them in.
    const sorted = [...rows]
    sorted.sort(sort.direction === 'asc' ? compare : (left, right) => compare(right, left))
    return sorted
  }, [paging, sort, rows, columns])

  const position = paging === 'whole' ? clampPage(page, ordered.length, pageSize) : page
  const slice = windowOf(ordered.length, position.cursor, pageSize)
  const visibleRows = paging === 'whole' ? ordered.slice(slice.start, slice.end) : ordered
  const forward = paging === 'whole' ? slice.nextCursor : (nextCursor ?? null)
  const capped = isCapped(rows.length, cap)
  // The count beside a capped read is a count, not a total, and the caveat is the
  // only thing that keeps "of 200" from reading as "there are 200".
  const ceiling = capped ? text(capNote ?? t('table.capped', { count: cap ?? 0, unit: text(unit) })) : undefined

  /**
   * Whether there are rows on screen for a note to describe.
   *
   * `sort` comes from the URL and from localStorage, so it is set before the first
   * response arrives and it survives a failed one, while `ordered.length` is 0 for
   * both. Opening a sorted link cold would otherwise print "across all 0 proposals"
   * beside the skeleton, and a refused request would print it beside the refusal.
   * Neither is a count of anything.
   */
  // One reading of the phase for the whole render — two calls could disagree
  // if the query settled between them.
  const phase = readPhase(query)
  const describable = phase === 'ready' && visibleRows.length > 0
  // One page of rows needs no explanation: the arrow in the header is already the
  // whole story, and this console spends pixels on exceptions.
  const reaches = describable && sort !== null && ordered.length > visibleRows.length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <I18nText>{toolbar}</I18nText>
        <div className="ml-auto flex items-center gap-2">
          {reaches ? (
            <span data-testid={`${testId}-order-note`} className="text-xs text-muted-foreground">
              <OrderNote
                label={text(shown.find((column) => column.id === sort?.column)?.label ?? sort?.column ?? '')}
                reach={sortReach(
                  specs.find((spec) => spec.id === sort?.column),
                  paging,
                )}
                count={ordered.length}
                unit={unit}
                capped={capped}
              />
            </span>
          ) : null}
          <ColumnMenu testId={testId} columns={columns} specs={specs} view={view} onViewChange={onViewChange} />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card" data-testid={`${testId}-${phase}`}>
        <Table data-testid={`${testId}-table`} aria-busy={phase === 'loading' || undefined} className={tableClassName}>
          <TableHeader>
            <TableRow>
              {shown.map((column) => {
                const reach = sortReach(
                  specs.find((spec) => spec.id === column.id),
                  paging,
                )
                const active = sort?.column === column.id ? sort.direction : null
                return (
                  <TableHead
                    key={column.id}
                    data-testid={`${testId}-header-${column.id}`}
                    scope="col"
                    className={column.className}
                    // Announced only where a control exists. `aria-sort="none"` on
                    // a column nobody can sort tells a screen reader there is a
                    // move to make, and there is not.
                    aria-sort={
                      !isOfferable(reach)
                        ? undefined
                        : active === 'asc'
                          ? 'ascending'
                          : active === 'desc'
                            ? 'descending'
                            : 'none'
                    }
                  >
                    {column.headerHidden ? (
                      <span className="sr-only">{text(column.label)}</span>
                    ) : isOfferable(reach) ? (
                      <button
                        type="button"
                        data-testid={`${testId}-sort-${column.id}`}
                        onClick={() => onViewChange({ ...view, sort: nextSort(specs, paging, sort, column.id) })}
                        className="inline-flex items-center gap-1 rounded font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {text(column.label)}
                        {active === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : active === 'desc' ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      text(column.label)
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Phase, not isPending: a query TanStack is still retrying holds
                the server's refusal in failureReason while its status is
                pending, and a skeleton drawn over it hides the answer for the
                whole retry budget (lib/read-state.ts). */}
            {phase === 'error' ? (
              <FailureRow
                testId={testId}
                columns={shown.length}
                error={readFailure(query)}
                retrying={isRetrying(query)}
                onRetry={query.refetch}
              />
            ) : phase === 'loading' ? (
              <SkeletonRows testId={testId} rows={Math.min(pageSize, 6)} columns={shown.length} />
            ) : visibleRows.length === 0 ? (
              <EmptyRow testId={testId} columns={shown.length} message={empty} />
            ) : (
              visibleRows.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  {...(rowAttributes?.(row) ?? {})}
                  data-testid={rowTestId?.(row) ?? `${testId}-row-${rowKey(row)}`}
                >
                  {shown.map((column) => (
                    <TableCell
                      key={column.id}
                      className={column.className}
                      data-testid={`${testId}-cell-${rowKey(row)}-${column.id}`}
                    >
                      <I18nText>{column.cell(row)}</I18nText>
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <Pagination
          data-testid={`${testId}-pagination`}
          page={position}
          nextCursor={forward}
          onChange={onPageChange}
          isLoading={phase === 'loading'}
          shown={visibleRows.length}
          start={paging === 'whole' ? slice.start : 0}
          // A total is printed only where the server supplied one by answering
          // every row. A cursor-paged list has no total and does not get one.
          total={paging === 'whole' ? ordered.length : null}
          note={ceiling}
          unit={text(unit)}
        />
      </div>
    </div>
  )
}

/**
 * Where the order came from, in the operator's terms.
 *
 * Worth saying only once the order is not the one the endpoint sent, and only
 * while there are rows it is true of. `'complete'` is the claim that needs
 * backing: the console did the ordering, and it covered every row because the
 * response held every row — which is what makes "across all" the right words, and
 * what makes them wrong the moment a `limit` capped the read.
 */
function OrderNote({
  label,
  reach,
  count,
  unit,
  capped,
}: {
  label: string
  reach: SortReach
  count: number
  unit: string
  capped: boolean
}) {
  const { t } = useI18n()
  if (reach === 'server') return <>{t('table.sorted.server', { label })}</>
  if (capped) return <>{t('table.sorted.capped', { label, count, unit })}</>
  return <>{t('table.sorted.all', { label, count, unit })}</>
}

/** Loading: rows in the shape of the rows that are coming, never a spinner. */
function SkeletonRows({ testId, rows, columns }: { testId: string; rows: number; columns: number }) {
  return (
    <>
      {Array.from({ length: Math.max(1, rows) }, (_unused, row) => (
        <TableRow key={row} data-testid={row === 0 ? `${testId}-skeleton` : undefined}>
          {Array.from({ length: Math.max(1, columns) }, (_ignored, column) => (
            <TableCell key={column}>
              <Skeleton className={column === 0 ? 'h-4 w-40' : 'h-4 w-24'} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

/**
 * The refusal, in the server's words, with the retry only where retrying could
 * work. `describeFailure` decides that; this only draws it.
 */
function FailureRow({
  testId,
  columns,
  error,
  retrying,
  onRetry,
}: {
  testId: string
  columns: number
  error: unknown
  retrying: boolean
  onRetry?: () => unknown
}) {
  const { t } = useI18n()
  const notice = describeFailure({ ...failureOf(error), retrying })
  return (
    <TableRow>
      <TableCell colSpan={Math.max(1, columns)} className="p-3 whitespace-normal">
        <Alert tone={notice.tone} title={notice.title} actions={notice.actions} data-testid={`${testId}-error`}>
          <div className="flex flex-col gap-2">
            <span>{notice.message}</span>
            {notice.retryable && onRetry ? (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                data-testid={`${testId}-retry`}
                onClick={() => void onRetry()}
              >
                {t('common.tryAgain')}
              </Button>
            ) : null}
          </div>
        </Alert>
      </TableCell>
    </TableRow>
  )
}

/** The answer arrived and there is nothing in it — which is often the good news. */
function EmptyRow({ testId, columns, message }: { testId: string; columns: number; message?: ReactNode }) {
  const { t } = useI18n()
  return (
    <TableRow>
      <TableCell colSpan={Math.max(1, columns)} className="p-8 whitespace-normal">
        <div
          data-testid={`${testId}-empty`}
          className="flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground"
        >
          <Inbox className="size-5" />
          <span>
            <I18nText>{message ?? t('table.empty')}</I18nText>
          </span>
        </div>
      </TableCell>
    </TableRow>
  )
}

/**
 * Which columns are on screen.
 *
 * A menu rather than a dialog: choosing columns is a view change, it is reversible
 * in one click, and it records no decision. `onSelect` is prevented on every item
 * so the menu survives the toggle — hiding three columns should cost three
 * clicks, not three round trips through the trigger.
 */
function ColumnMenu<Row>({
  testId,
  columns,
  specs,
  view,
  onViewChange,
}: {
  testId: string
  columns: readonly DataColumn<Row>[]
  specs: readonly ColumnCapability[]
  view: TableView
  onViewChange: (view: TableView) => void
}) {
  const { t, text } = useI18n()
  const hidden = columns.filter((column) => !view.visible.includes(column.id)).length
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid={`${testId}-columns`}>
          <Columns3 data-icon="inline-start" />
          {t('table.columns')}
          {/* The count is the exception, so it is the only thing printed: a menu
              with nothing hidden has nothing to report. */}
          {hidden ? <span className="text-muted-foreground">{t('table.hidden', { count: hidden })}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          {columns.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              data-testid={`${testId}-columns-${column.id}`}
              checked={view.visible.includes(column.id)}
              disabled={column.required}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => onViewChange({ ...view, visible: toggleVisible(specs, view.visible, column.id) })}
            >
              <span className={cn(column.required && 'text-muted-foreground')}>{text(column.label || column.id)}</span>
              {column.required ? (
                <span className="ml-auto text-xs text-muted-foreground">{t('table.always')}</span>
              ) : null}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            data-testid={`${testId}-columns-reset`}
            onSelect={() => onViewChange({ ...view, visible: defaultVisible(specs) })}
          >
            {t('table.reset')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The transport's error object, reduced to the three facts `describeFailure` decides on. */
function failureOf(error: unknown): Failure {
  const api = error instanceof ApiError ? error : null
  return {
    status: api?.status ?? null,
    message: error instanceof Error ? error.message : String(error),
    actions: api?.nextBestActions ?? [],
  }
}
