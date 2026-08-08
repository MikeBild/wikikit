import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { SegmentedControl } from '@/components/controls'
import { EmptyState } from '@/components/empty-state'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import { RelativeTime } from '@/components/ui/relative-time'
import { useTableView } from '@/hooks/use-table-view'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { firstPage, resetPage, type CursorPage } from '@/lib/cursor'
import { useSpace } from '@/lib/space'
import { compareText, compareTime } from '@/lib/table-view'
import { STATUS_STATE, type DomainState } from '@/lib/tokens'
import type { FilterSpec } from '@/lib/url-filters'

/**
 * The decision log — what this wiki decided, and what it turned down.
 *
 * The row shape is derived from the facade rather than declared here, so a field
 * the server stops sending stops compiling instead of rendering `undefined`.
 */
type DecisionRow = Awaited<ReturnType<typeof wk.decisions.list>>['items'][number]

/**
 * `GET /v1/spaces/{space}/decisions` clamps `limit` to 200 and defaults to 50,
 * and it takes no status parameter — so the console asks for the ceiling once,
 * holds the whole answer, and does its own narrowing. Asking for 200 rather than
 * accepting 50 is the difference between a log and a sample; the table says so
 * out loud through `cap` when the response comes back full.
 */
const LIST_LIMIT = 200
const LIST_QUERY = { limit: LIST_LIMIT } as const

/**
 * A superseded decision is HISTORY, not a failure.
 *
 * This is the one colour choice on this page that matters. `rejected` and
 * `disputed` are judgements that went the wrong way and wear `destructive`;
 * `superseded` means the wiki later decided something else, which is exactly
 * what a decision log is for. `STATUS_STATE` already maps it to `unknown` — the
 * dashed, muted, deliberately-not-a-verdict tone — and this table is the reason
 * that entry exists. Painting it red would tell a reader that every decision
 * this wiki ever revisited was a mistake.
 */
const BADGE_TONE: Record<DomainState, NonNullable<BadgeProps['tone']>> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
}

/** The word beside the colour — a status is never conveyed by tone alone. */
const STATUS_WORD: Record<string, string> = {
  active: 'In force',
  superseded: 'Superseded',
}

function StatusBadge({ status }: { status: string }) {
  const state = STATUS_STATE[status] ?? 'unknown'
  return <Badge tone={BADGE_TONE[state]}>{STATUS_WORD[status] ?? status}</Badge>
}

/**
 * Declared at module scope because `useTableView` re-derives the view — and the
 * table re-sorts the rows — whenever this array's identity changes. No cell
 * closes over anything the page holds, so there is nothing to capture.
 */
const COLUMNS: readonly DataColumn<DecisionRow>[] = [
  {
    id: 'title',
    label: 'Decision',
    required: true,
    compare: (left, right) => compareText(left.title, right.title),
    cell: (row) => (
      <Link
        to="/decisions/$slug"
        params={{ slug: row.slug }}
        data-testid={`decision-${row.slug}`}
        className="font-medium underline-offset-2 hover:underline"
      >
        {row.title}
      </Link>
    ),
  },
  {
    id: 'slug',
    label: 'Slug',
    hiddenByDefault: true,
    compare: (left, right) => compareText(left.slug, right.slug),
    cell: (row) => <span className="font-mono text-xs text-muted-foreground">{row.slug}</span>,
  },
  {
    id: 'status',
    label: 'Status',
    compare: (left, right) => compareText(left.status, right.status),
    cell: (row) => <StatusBadge status={row.status} />,
  },
  {
    id: 'recorded',
    label: 'Recorded',
    descFirst: true,
    compare: (left, right) => compareTime(left.created_at, right.created_at),
    cell: (row) => <RelativeTime value={row.created_at} data-testid={`decision-${row.slug}-recorded`} />,
  },
]

type StatusChoice = 'all' | 'active' | 'superseded'

const STATUS_OPTIONS: readonly { id: StatusChoice; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'In force' },
  { id: 'superseded', label: 'Superseded' },
]

/**
 * The filter is the console's, not the endpoint's — the decision log answers
 * every visible decision and takes no status parameter — but it still belongs in
 * the URL. "The decisions still in force in this wiki" is a view one person
 * narrows and another has to look at, and a filter in `useState` cannot be sent.
 */
const FILTERS: readonly FilterSpec[] = [{ key: 'status', values: ['active', 'superseded'], fallback: 'all' }]

export function DecisionsPage() {
  const space = useSpace()
  const { view, setView } = useTableView('decisions', COLUMNS)
  const { filters, setFilters, filtered, clear } = useUrlFilters('decisions', FILTERS)
  const [page, setPage] = useState<CursorPage>(firstPage)

  const status = (filters.status ?? 'all') as StatusChoice

  const query = useQuery({
    queryKey: keys.decisions(space, LIST_QUERY),
    queryFn: () => wk.decisions.list(space, LIST_QUERY),
  })

  const items = query.data?.items ?? []
  const rows = status === 'all' ? items : items.filter((item) => item.status === status)

  // `cap` answers "did this READ hit its ceiling", which is a fact about the
  // response and not about what survived the console's own filter — so the
  // ceiling is measured on the response and reported against the rows on screen.
  const atCeiling = items.length >= LIST_LIMIT

  return (
    <Page title="Decisions" description="What this wiki decided and why, including the alternatives it turned down.">
      <DataTable
        testId="decisions"
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.slug}
        rowTestId={(row) => `decision-row-${row.slug}`}
        rowAttributes={(row) => ({ 'data-status': row.status })}
        query={query}
        view={view}
        onViewChange={setView}
        page={page}
        onPageChange={setPage}
        unit="decisions"
        cap={atCeiling ? rows.length : null}
        capNote={`only the newest ${LIST_LIMIT} decisions are loaded — this wiki may have recorded more`}
        toolbar={
          <SegmentedControl
            value={status}
            options={STATUS_OPTIONS}
            label="Filter decisions by status"
            data-testid="decisions-status"
            onChange={(next) => {
              setFilters({ status: next })
              // A cursor belongs to the result that produced it: keeping one
              // across a filter change lands the reader in the middle of a list
              // whose start they have not seen.
              setPage(resetPage())
            }}
          />
        }
        empty={
          // Unframed: the table body already draws the container, and two dashed
          // rectangles around one sentence is the nesting defect (CUI-LADDER-2).
          //
          // The filter only gets to explain the emptiness when it is actually
          // what caused it: a wiki with no decisions at all, read under a status
          // filter, must not be told that everything it recorded was superseded.
          filtered && items.length > 0 ? (
            <EmptyState
              framed={false}
              data-testid="decisions-empty-filtered"
              title={status === 'active' ? 'No decision is currently in force' : 'Nothing has been superseded'}
              description={
                status === 'active'
                  ? 'Every decision this wiki recorded has since been superseded by a later one.'
                  : 'Every decision this wiki recorded still stands.'
              }
              action={
                // A button, not a link: it changes what the list shows and
                // navigates nowhere (CUI-ACT-1).
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="decisions-clear-filter"
                  onClick={() => {
                    clear()
                    setPage(resetPage())
                  }}
                >
                  Show all decisions
                </Button>
              }
            />
          ) : (
            <EmptyState
              framed={false}
              data-testid="decisions-empty"
              title="No decisions yet"
              description="A decision is recorded by the change that proposes it. Approve a change carrying one and it appears here, with its context, its rationale and the alternatives that were discarded."
            />
          )
        }
      />
    </Page>
  )
}
