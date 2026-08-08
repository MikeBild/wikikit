import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FilePlus2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import { RelativeTime } from '@/components/ui/relative-time'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { useTableView } from '@/hooks/use-table-view'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { firstPage, resetPage, type CursorPage } from '@/lib/cursor'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { compareNumber, compareText, compareTime } from '@/lib/table-view'
import {
  CHANGE_WINDOW_LABEL,
  changedWithin,
  evidenceRank,
  listMeasuresEvidence,
  pageEvidence,
  rendersAsDash,
  type EvidenceCounts,
} from '@/pages/page.logic'

/**
 * Every page in this wiki.
 *
 * The index of a wiki is a place to FIND something, so the row is the page's
 * name and its own words — title, slug, summary. Beside them now sits the
 * question a reader of THIS product asks before any other, because every claim
 * here is supposed to carry a verbatim quote from an archived source: **how does
 * the wiki know this?**
 *
 *  - **Evidence is a column.** It was not one for a long time, and the reason
 *    was arithmetic rather than taste: `/v1/spaces/{space}/concepts` answered
 *    slug, title, summary, rev and updated_at, so putting "12 claims, 2 uncited"
 *    in a row would have meant one concept read per row — two hundred requests
 *    to draw a list. The list read now answers an `evidence` object per row —
 *    `claims`, `uncited_claims`, `sources` — in the same statement that answers
 *    the rest, so the fact costs nothing extra to show and there is no longer
 *    any excuse for a list that cannot say which pages nothing backs.
 *    `pageEvidence` in `page.logic` owns what those three numbers mean; this
 *    file only draws them.
 *  - **No pending-change marker.** The proposals list carries a change's title
 *    and status but not which concepts it touches, so a "has a change waiting"
 *    column could only be guessed at from a title string. A guess about whether
 *    knowledge is contested is worse than no column at all.
 *
 * The read asks for the server's maximum in one request rather than walking its
 * keyset cursor, because that is what makes the sort and the filter honest: both
 * are done here, over rows the console fully holds, and `cap` prints the ceiling
 * beside the count so "203 pages" can never read as "all of them". The evidence
 * sort inherits that honesty for free — "show me the pages nothing backs" is one
 * click on the header, over every row the console holds.
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
  /**
   * Optional, and optional on the wire too — for two unrelated reasons that
   * happen to want the same handling.
   *
   * The server omits it for a REFERENCE TARGET: a page an import created so
   * that reviewed relations had somewhere to land, which holds no knowledge to
   * be evidenced. Three zeros there would be the same row a page that genuinely
   * rests on nothing gets, and half an index carrying a meaningless zero
   * teaches a reader to ignore the ones that mean something. Where the object
   * IS served it is three measured integers: `claims: 0` is a fact about a
   * hand-written page, not missing data.
   *
   * And a ROLLING UPGRADE omits it for every row — a tab loaded from the
   * replaced instance, its next request landing on the one still running a
   * build that predates the field. Typing it required would be a lie the
   * compiler agreed to, and the column would print "No claims" for every page
   * in the wiki, which is the single most alarming thing this list can say.
   *
   * Both render as an em dash, with a sort that refuses to rank a blank as
   * though it were zero — but they are told apart and they say different
   * sentences, which is what `measured` on `IndexRow` is for.
   */
  evidence?: EvidenceCounts | null
}

/**
 * A row, plus the one fact about the RESPONSE that no row can carry on its own.
 *
 * `measured` says whether the list this row arrived in reported evidence for
 * ANY page (`listMeasuresEvidence`), which is what separates the two reasons a
 * row can be missing its counts — see `PageRow.evidence`. It has to sit on the
 * row rather than be closed over by the cell, because `COLUMNS` is module scope
 * and a cell built per render would re-sort the whole list on every keystroke
 * elsewhere on the page. Derived once per response beside the filter, so the
 * two hundred rows carry a boolean rather than each asking the question again.
 */
interface IndexRow extends PageRow {
  measured: boolean
}

/**
 * Module scope, because `useTableView` re-derives the view from this array: one
 * rebuilt per render re-sorts the whole list on every keystroke elsewhere on the
 * page.
 */
const COLUMNS: readonly DataColumn<IndexRow>[] = [
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
    id: 'evidence',
    label: 'Evidence',
    // Second, ahead of the page's own summary, and that ordering is the only
    // thing here that costs anything. Below `md` a row's last cell is pinned and
    // everything between the first column and it is reached by scrolling the
    // table sideways (components/ui/table.tsx) — so at 390px a column placed
    // after `summary` is a column an operator on a phone never sees. Evidence is
    // asked before the summary is read, not after: the summary says what the
    // page claims, this says whether anything backs the claim.
    compare: (left, right) => compareNumber(evidenceRank(left.evidence), evidenceRank(right.evidence)),
    cell: (row) => <EvidenceCell row={row} />,
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
  const rows = useMemo<readonly IndexRow[]>(() => {
    // Asked of the WHOLE response, not of the rows that survive the filter: a
    // window that happened to keep only reference targets would otherwise leave
    // the list with nothing measured in it and flip every one of those rows to
    // the vaguer sentence. A filter narrows what is shown; it does not change
    // what a page is.
    const measured = listMeasuresEvidence(items)
    return items.filter((row) => changedWithin(row.updated_at, changed, now)).map((row) => ({ ...row, measured }))
  }, [items, changed, now])

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
 * What backs this page, in one cell.
 *
 * Three shapes for the measured states, because two of them share the amber tone
 * and a colour is never allowed to be the whole difference (CUI-A11Y-5):
 *
 *   12 claims  [2 uncited]     a page whose evidence has holes — the common case
 *   4 sources
 *
 *   [No claims]                a page written by hand: nothing backs a word of it
 *
 *   12 claims                  every claim quoting a source — the promise kept,
 *   4 sources                  stated in plain text and wearing no pill at all
 *
 *   —                          nothing was measured, which is not a zero
 *
 * The em dash is the one that has to be gettable by a reader who cannot see it,
 * so the visible glyph is hidden from the accessibility tree and the sentence
 * behind it is not: a screen reader that announced "dash" would learn exactly as
 * much as a reader who saw `0`.
 *
 * And it has to be gettable by a reader who CAN see it, which is the change
 * here. A bare dash is barely better than a wrong zero — the operator who wants
 * to know why half this wiki's rows are blank has nowhere to ask but the linter,
 * which correctly reports nothing wrong, and that round trip is the whole defect
 * this column had. So the dash is a Tooltip trigger carrying the sentence
 * `pageEvidence` decided on: a reference target says it holds relations rather
 * than knowledge, an unanswered list says the counts never arrived.
 *
 * A Tooltip and not a `title=`, on the same rule `RelativeTime` and
 * `DisabledReason` already follow (CUI-WORDS-2): a native title is one sentence
 * offered to a pointer and to nobody else — invisible on touch, unreachable by
 * keyboard — and here it would be CARRYING the explanation rather than adding
 * to one already on screen. That is why the measured branch below may keep its
 * `title`: every word of that reading is rendered beside it. The tab stop is the
 * price, and it is the same price the "Last change" cell in this row already
 * pays for the exact instant behind "3 days ago".
 *
 * The `sr-only` sentence stays as well as the tooltip, and the redundancy is
 * deliberate: a tooltip that is never opened says nothing, so a screen reader
 * reading this table row by row would otherwise reach an `aria-hidden` glyph and
 * hear an empty cell.
 */
function EvidenceCell({ row }: { row: IndexRow }) {
  const evidence = pageEvidence(row.evidence, row.measured)
  const testId = `pages-row-${row.slug}-evidence`

  if (rendersAsDash(evidence.level))
    return (
      // Its own provider, like every other Tooltip in this console: rows are
      // rendered inside dialogs and sheets that mount their own trees, and Radix
      // throws rather than degrades when a Tooltip cannot find one.
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              data-testid={testId}
              data-evidence={evidence.level}
            >
              <span aria-hidden="true">—</span>
              <span className="sr-only">{evidence.reading}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent data-testid={`${testId}-reason`}>{evidence.reading}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )

  return (
    <div
      className="flex flex-col items-start gap-0.5"
      data-testid={testId}
      data-evidence={evidence.level}
      title={evidence.reading}
    >
      <div className="flex items-center gap-1.5">
        {evidence.count ? <span className="tabular-nums">{evidence.count}</span> : null}
        {evidence.flag ? <Badge tone={evidence.tone}>{evidence.flag}</Badge> : null}
      </div>
      {evidence.detail ? <span className="text-xs text-muted-foreground">{evidence.detail}</span> : null}
    </div>
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
