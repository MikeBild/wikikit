import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FilePlus2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import { RelativeTime } from '@/components/ui/relative-time'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useNow } from '@/hooks/use-now'
import { useTableView } from '@/hooks/use-table-view'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { firstPage, resetPage, type CursorPage } from '@/lib/cursor'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { compareNumber, compareText, compareTime } from '@/lib/table-view'
import { CHANGE_WINDOW_LABEL, changedWithin } from '@/pages/page.logic'

/**
 * Every page in this wiki.
 *
 * The index of a wiki is a place to FIND something, so the row is the page's
 * name and its own words — title, slug, summary — and everything else is
 * secondary. Two things the reader might expect are deliberately not here, and
 * both are the read's doing rather than a choice:
 *
 *  - **No claim counts.** `/v1/spaces/{space}/concepts` answers slug, title,
 *    summary, rev and updated_at, and nothing about claims or citations. The
 *    only way to put "12 claims, 2 uncited" in a row would be one concept read
 *    per row — two hundred requests to draw a list — so the evidence lives on
 *    the page itself, where it is read one page at a time and is complete.
 *  - **No pending-change marker.** The proposals list carries a change's title
 *    and status but not which concepts it touches, so a "has a change waiting"
 *    column could only be guessed at from a title string. A guess about whether
 *    knowledge is contested is worse than no column at all.
 *
 * The read asks for the server's maximum in one request rather than walking its
 * keyset cursor, because that is what makes the sort and the filter honest: both
 * are done here, over rows the console fully holds, and `cap` prints the ceiling
 * beside the count so "203 pages" can never read as "all of them".
 */

const LIST_ID = 'pages'

/**
 * 200 is the server's own ceiling (`clampLimit(limit, 50, 200)`), so this is one
 * request asking for as much as one request can have.
 */
const LIST_LIMIT = 200

const LIST_QUERY = { limit: LIST_LIMIT } as const

const FILTERS = [{ key: 'changed', values: ['7d', '30d', '90d'], fallback: 'any' }] as const

const WINDOWS = ['any', '7d', '30d', '90d'] as const

/**
 * Search parameters survive a click.
 *
 * `?space=` is the address of the wiki being read, and a link that dropped it
 * would land the reader in whichever wiki their browser last remembered — a
 * different page under the same URL, which is the one thing a link must not do.
 */
const KEEP_SEARCH = (previous: { space?: string }) => previous

interface PageRow {
  slug: string
  title: string
  summary: string
  rev: number
  updated_at: string
}

/**
 * Module scope, because `useTableView` re-derives the view from this array: one
 * rebuilt per render re-sorts the whole list on every keystroke elsewhere on the
 * page.
 */
const COLUMNS: readonly DataColumn<PageRow>[] = [
  {
    id: 'page',
    label: 'Page',
    required: true,
    compare: (left, right) => compareText(left.title, right.title),
    cell: (row) => (
      <div className="flex min-w-0 flex-col">
        <Link
          to="/pages/$slug"
          params={{ slug: row.slug }}
          search={KEEP_SEARCH}
          data-testid={`pages-row-${row.slug}-link`}
          className="truncate font-medium text-foreground underline-offset-2 hover:underline"
        >
          {row.title}
        </Link>
        <span className="truncate font-mono text-xs text-muted-foreground">{row.slug}</span>
      </div>
    ),
  },
  {
    id: 'summary',
    label: 'Summary',
    className: 'max-w-md',
    compare: (left, right) => compareText(left.summary, right.summary),
    // A summary is prose, so it wraps rather than scrolling the table sideways
    // — the row is allowed to be two lines tall, and `line-clamp` keeps a page
    // whose summary is a paragraph from being four.
    cell: (row) =>
      row.summary ? (
        <span className="line-clamp-2 text-muted-foreground">{row.summary}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'rev',
    label: 'Revision',
    className: 'tabular-nums',
    compare: (left, right) => compareNumber(left.rev, right.rev),
    // The revision number is the count of approved changes this page has
    // survived, so it is a fact worth having and not a fact worth a column by
    // default on a phone.
    hiddenByDefault: true,
    cell: (row) => (Number.isFinite(row.rev) ? row.rev : '—'),
  },
  {
    id: 'updated',
    label: 'Last change',
    descFirst: true,
    compare: (left, right) => compareTime(left.updated_at, right.updated_at),
    cell: (row) => <RelativeTime value={row.updated_at} data-testid={`pages-row-${row.slug}-updated`} />,
  },
]

export function PagesPage() {
  const space = useSpace()
  const can = useCan()
  const canPropose = can('knowledge:propose')

  const { view, setView } = useTableView(LIST_ID, COLUMNS)
  const { filters, setFilters, clear, filtered } = useUrlFilters(LIST_ID, FILTERS)
  const [page, setPage] = useState<CursorPage>(firstPage)

  const query = useQuery({
    queryKey: keys.concepts(space, LIST_QUERY),
    queryFn: () => wk.concepts.list(space, LIST_QUERY),
  })

  // `?? []` builds a fresh array on every render, which would make the memo
  // below re-filter the whole list each time and defeat the point of having one.
  const items = useMemo<readonly PageRow[]>(() => query.data?.items ?? [], [query.data])
  const changed = filters.changed ?? 'any'
  // The shared clock rather than `Date.now()` in the memo. Reading the wall
  // clock during render is impure — React may re-render at any moment, and the
  // "changed in the last 7 days" cut-off would silently move each time,
  // dropping a row out of a filtered list with nothing having happened. The
  // store ticks once a second for the whole console, so every surface agrees on
  // what "now" is.
  const now = useNow()
  const rows = useMemo(() => items.filter((row) => changedWithin(row.updated_at, changed, now)), [items, changed, now])

  return (
    <Page
      title="Pages"
      description="Every page this wiki holds. A page states what is known; editing one submits a change for review."
      actions={<NewPage testId="pages-new" canPropose={canPropose} />}
    >
      <DataTable
        testId={LIST_ID}
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.slug}
        rowTestId={(row) => `pages-row-${row.slug}`}
        query={query}
        view={view}
        onViewChange={setView}
        page={page}
        onPageChange={setPage}
        unit="pages"
        cap={LIST_LIMIT}
        capNote={`only the first ${LIST_LIMIT} pages are loaded, in slug order — Search reaches the rest`}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={changed}
              onValueChange={(next) => {
                setFilters({ changed: next })
                // A cursor belongs to the result that produced it: keeping one
                // across a filter change lands the reader in the middle of a
                // list they have not seen the start of.
                setPage(resetPage())
              }}
            >
              <SelectTrigger size="sm" aria-label="Changed within" data-testid="pages-filter-changed">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((window) => (
                  <SelectItem key={window} value={window} data-testid={`pages-filter-changed-${window}`}>
                    {CHANGE_WINDOW_LABEL[window] ?? window}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {filtered ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="pages-filter-clear"
                onClick={() => {
                  clear()
                  setPage(resetPage())
                }}
              >
                Clear filter
              </Button>
            ) : null}
          </div>
        }
        empty={
          // Two different worlds, and they must not share a sentence: a wiki
          // with no pages needs the action that fills it, a filter that
          // excluded them all needs the way back out.
          filtered ? (
            <EmptyState
              framed={false}
              title="No pages changed in that window"
              description={`This wiki has ${items.length} ${items.length === 1 ? 'page' : 'pages'} loaded, none of them changed ${(CHANGE_WINDOW_LABEL[changed] ?? changed).toLowerCase()}.`}
              action={
                <Button variant="outline" size="sm" data-testid="pages-empty-clear" onClick={() => clear()}>
                  Show every page
                </Button>
              }
              data-testid="pages-empty-filtered"
            />
          ) : (
            <EmptyState
              framed={false}
              title="No pages yet"
              description="A page states what this wiki knows, and every claim on it carries a verbatim quote from a source. Write one by hand, or add a document under Sources and review the pages it produces."
              action={<NewPage testId="pages-empty-new" canPropose={canPropose} />}
              data-testid="pages-empty"
            />
          )
        }
      />
    </Page>
  )
}

/**
 * The one way into the editor, in both the places that offer it.
 *
 * Disabled rather than hidden when the session cannot propose, with the reason
 * attached: a reader who cannot write should still learn that writing is what
 * this button does and which scope would let them.
 */
function NewPage({ testId, canPropose }: { testId: string; canPropose: boolean }) {
  if (!canPropose)
    return (
      <DisabledReason reason="Needs knowledge:propose — writing a page means submitting a change for review.">
        <Button variant="accent" disabled data-testid={testId}>
          <FilePlus2 data-icon="inline-start" />
          New page
        </Button>
      </DisabledReason>
    )
  return (
    <Button asChild variant="accent">
      <Link to="/pages/new" search={KEEP_SEARCH} data-testid={testId}>
        <FilePlus2 data-icon="inline-start" />
        New page
      </Link>
    </Button>
  )
}
