import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import { RelativeTime } from '@/components/ui/relative-time'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTableView } from '@/hooks/use-table-view'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { firstPage, resetPage, type CursorPage } from '@/lib/cursor'
import { useSpace } from '@/lib/space'
import { compareText, compareTime } from '@/lib/table-view'
import type { FilterSpec } from '@/lib/url-filters'
import { badgeTone, changeState } from '@/pages/change.logic'

/**
 * The review queue — everything waiting for a human, and everything a human
 * already decided.
 *
 * This list exists to answer one question: what needs me. So the status filter
 * is in the URL rather than in component state, because "the changes still
 * awaiting review in this wiki" is a view one operator narrows and another has
 * to look at, and a filter living in `useState` is a view nobody can hand on.
 */

/** The server's own alphabet (`zProposalListQuery`), plus the neutral value. */
const STATUSES = ['pending', 'approved', 'rejected', 'failed', 'split'] as const

const FILTERS: readonly FilterSpec[] = [{ key: 'status', values: STATUSES, fallback: 'all' }]

const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'all', label: 'Every change' },
  { value: 'pending', label: 'Awaiting review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'failed', label: 'Failed' },
  { value: 'split', label: 'Split' },
]

type ChangeRow = {
  id: string
  status: string
  title: string
  summary: string
  created_at: string
  reviewer: string | null
  review_channel: string | null
  reviewed_at: string | null
  changes_requested: boolean
  parent_proposal_id: string | null
}

/**
 * The server's own ceiling (`clampLimit(limit, 50, 200)`), asked for
 * explicitly.
 *
 * Sending no limit takes the DEFAULT of 50, and this read has no cursor — so
 * the queue quietly held the 50 newest changes while the footer, which grades
 * a whole-list read, announced "across all 50 changes, not just this page".
 * The 51st-oldest pending change was unreachable from the surface the product
 * exists for, and the page said the opposite. `cap` below is what makes the
 * remaining ceiling visible instead of silent.
 */
const LIST_LIMIT = 200

export function ChangesPage() {
  const space = useSpace()
  const { filters, setFilters, clear, filtered } = useUrlFilters('changes', FILTERS)
  const status = filters.status ?? 'all'
  const [page, setPage] = useState<CursorPage>(firstPage)

  const query = useQuery({
    queryKey: keys.changes(space, { status, limit: LIST_LIMIT }),
    queryFn: () => wk.changes.list(space, status === 'all' ? { limit: LIST_LIMIT } : { status, limit: LIST_LIMIT }),
  })

  // The cells close over `space` (every row link carries the wiki it belongs
  // to), so the array cannot live at module scope — and `useTableView` re-derives
  // the whole view from it, which is why it is memoised rather than rebuilt.
  const columns = useMemo<DataColumn<ChangeRow>[]>(
    () => [
      {
        id: 'title',
        label: 'Change',
        required: true,
        compare: (left, right) => compareText(left.title, right.title),
        cell: (row) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            {/* A link navigates and does nothing else (CUI-ACT-1). The whole row
                is not the target: a row-wide click handler steals the text
                selection a reviewer uses to read a summary. */}
            <Link
              to="/changes/$id"
              params={{ id: row.id }}
              search={{ space }}
              data-testid={`change-link-${row.id}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              {row.title}
            </Link>
            {row.summary ? <span className="line-clamp-2 text-xs text-muted-foreground">{row.summary}</span> : null}
          </div>
        ),
      },
      {
        id: 'status',
        label: 'Status',
        compare: (left, right) => compareText(statusOrder(left), statusOrder(right)),
        cell: (row) => <StatusCell row={row} />,
      },
      {
        id: 'raised',
        label: 'Raised',
        descFirst: true,
        compare: (left, right) => compareTime(left.created_at, right.created_at),
        cell: (row) => <RelativeTime value={row.created_at} data-testid={`change-raised-${row.id}`} />,
      },
      {
        id: 'reviewer',
        label: 'Reviewer',
        compare: (left, right) => compareText(left.reviewer, right.reviewer),
        // A change nobody has decided has no reviewer, and that is an absent
        // value, not an empty one (CUI-SEV-2).
        cell: (row) => (row.reviewer ? <span className="truncate">{row.reviewer}</span> : <Dash />),
      },
      {
        id: 'decided',
        label: 'Decided',
        hiddenByDefault: true,
        descFirst: true,
        compare: (left, right) => compareTime(left.reviewed_at, right.reviewed_at),
        cell: (row) =>
          row.reviewed_at ? (
            <RelativeTime value={row.reviewed_at} data-testid={`change-decided-${row.id}`} />
          ) : (
            <Dash />
          ),
      },
      {
        id: 'channel',
        label: 'Decided through',
        hiddenByDefault: true,
        compare: (left, right) => compareText(left.review_channel, right.review_channel),
        cell: (row) =>
          row.review_channel ? <span className="font-mono text-xs">{row.review_channel}</span> : <Dash />,
      },
      {
        id: 'parent',
        label: 'Split from',
        hiddenByDefault: true,
        compare: (left, right) => compareText(left.parent_proposal_id, right.parent_proposal_id),
        cell: (row) =>
          row.parent_proposal_id ? (
            <Link
              to="/changes/$id"
              params={{ id: row.parent_proposal_id }}
              search={{ space }}
              data-testid={`change-parent-${row.id}`}
              className="font-mono text-xs underline-offset-4 hover:underline"
            >
              {row.parent_proposal_id.slice(0, 8)}
            </Link>
          ) : (
            <Dash />
          ),
      },
    ],
    [space],
  )

  const { view, setView } = useTableView('changes', columns)
  const rows = (query.data as { items?: ChangeRow[] } | undefined)?.items ?? []
  // At the ceiling the wiki may hold more, and the footer must say so rather
  // than grading the sort "across all N changes" when N is a truncation.
  const atCeiling = rows.length >= LIST_LIMIT

  return (
    <Page
      title="Changes"
      description="Every edit waiting for a decision, and every decision already made. Nothing becomes knowledge in this wiki until somebody here says yes."
    >
      <DataTable
        testId="changes"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        rowTestId={(row) => `change-row-${row.id}`}
        // The status is on the row as data, not only as a colour, so a
        // verification checklist can assert on it without reading pixels.
        rowAttributes={(row) => ({
          'data-status': row.status,
          'data-changes-requested': String(row.changes_requested),
        })}
        query={query}
        view={view}
        onViewChange={setView}
        page={page}
        onPageChange={setPage}
        unit="changes"
        cap={atCeiling ? rows.length : null}
        capNote={`only the newest ${LIST_LIMIT} changes are loaded — this wiki has raised more`}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={status}
              onValueChange={(next) => {
                setFilters({ status: next })
                // A cursor belongs to the result that produced it; keeping one
                // across a filter change lands the reviewer in the middle of a
                // list they have not seen the start of.
                setPage(resetPage())
              }}
            >
              <SelectTrigger size="sm" data-testid="changes-status" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} data-testid={`changes-status-${option.value}`}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {filtered ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="changes-clear-filter"
                onClick={() => {
                  clear()
                  setPage(resetPage())
                }}
              >
                Show every change
              </Button>
            ) : null}
          </div>
        }
        empty={
          filtered ? (
            <EmptyState
              framed={false}
              data-testid="changes-empty-filtered"
              title="No changes with that status"
              description={`Nothing in this wiki is ${labelFor(status).toLowerCase()}. The filter is in the address bar, so this view can be sent to somebody — or cleared.`}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="changes-empty-clear"
                  onClick={() => {
                    clear()
                    setPage(resetPage())
                  }}
                >
                  Show every change
                </Button>
              }
            />
          ) : (
            <EmptyState
              framed={false}
              data-testid="changes-empty"
              title="Nothing is waiting"
              description="No change has ever been raised in this wiki. Adding a document under Sources, or editing a page, is what puts one here."
            />
          )
        }
      />
    </Page>
  )
}

/**
 * The status, and — where it applies — the flag beside it.
 *
 * Two badges rather than one recoloured badge, because `changes_requested` and
 * `pending` are both `blocked`: they share a colour by design, so the only thing
 * that can tell them apart is a word (CUI-A11Y-5). A change somebody read and
 * sent back must not look like one nobody has opened.
 */
function StatusCell({ row }: { row: ChangeRow }) {
  const reading = changeState(row.status, row.changes_requested)
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge tone={badgeTone(reading.state)} data-testid={`change-status-${row.id}`}>
        {reading.label}
      </Badge>
      {reading.flag ? (
        <Badge tone={badgeTone(reading.flag.state)} data-testid={`change-flag-${row.id}`}>
          {reading.flag.label}
        </Badge>
      ) : null}
    </div>
  )
}

/** A value nobody sent, drawn as absence rather than as zero (CUI-SEV-2). */
function Dash() {
  return <span className="text-muted-foreground">—</span>
}

/**
 * The queue's own order for the status column.
 *
 * Alphabetical on the raw status would sort `approved` above `pending`, which
 * puts everything already decided at the top of a list whose whole purpose is
 * what still needs a human. The prefix is a sort key and never rendered.
 */
function statusOrder(row: ChangeRow): string {
  if (row.status === 'pending' && !row.changes_requested) return '0-awaiting'
  if (row.changes_requested) return '1-changes-requested'
  if (row.status === 'failed') return '2-failed'
  return `3-${row.status}`
}

function labelFor(status: string): string {
  return STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status
}
