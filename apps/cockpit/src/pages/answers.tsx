import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { MessageSquareQuote, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import { Label } from '@/components/ui/label'
import { RelativeTime } from '@/components/ui/relative-time'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTableView } from '@/hooks/use-table-view'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { firstPage, resetPage, type CursorPage } from '@/lib/cursor'
import { useSpace } from '@/lib/space'
import { useI18n } from '@/lib/i18n-context'
import type { FilterSpec } from '@/lib/url-filters'
import { count } from '@/pages/home.logic'
import { coverageOf, filingStanding, kindWord, outputLabel, OUTPUT_KINDS } from '@/pages/answers.logic'

/**
 * What this wiki has told somebody — the fourth place.
 *
 * Until this page existed the loop ended in a chat window: `/query` synthesized
 * an answer over approved knowledge, cited the pages it leaned on, and handed
 * the whole thing back to whoever asked. Nothing kept it. The next person asked
 * the same question and paid for the same answer, and the good ones — the ones
 * worth being knowledge — had nowhere to go.
 *
 * So one list holds all three kinds of thing this system produces: answers
 * somebody asked for, the briefings the scheduler writes, and the check reports
 * it writes beside them. They are one object with a different `kind`, and they
 * are one list because "what did the system tell me" is one question. The kind
 * filter is there for the reader who came for one of them; the default is
 * everything, because a briefing nobody asked for is exactly the thing a
 * filtered-by-default list would hide.
 *
 * The detail route (`answer.tsx`) owns promotion. This page deliberately does
 * not: filing an answer back into the wiki creates review work, and an action
 * with a consequence belongs where the document it acts on can be read first.
 */

/** `zOutputListQuery.limit` caps at 100. Rows carry their whole markdown, so one screenful is plenty. */
const PAGE_SIZE = 20

const KIND_FILTERS: readonly FilterSpec[] = [{ key: 'kind', values: OUTPUT_KINDS, fallback: 'all' }]

const KIND_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'all', label: 'Everything produced' },
  { value: 'answer', label: 'Answers' },
  { value: 'briefing', label: 'Briefings' },
  { value: 'health', label: 'Check reports' },
]

/** Derived from the facade so a field the server stops sending stops compiling. */
type OutputListRow = Awaited<ReturnType<typeof wk.outputs.list>>['items'][number]

export function AnswersPage() {
  const space = useSpace()
  const { t } = useI18n()
  const { filters, setFilters } = useUrlFilters('answers', KIND_FILTERS)
  const kind = filters.kind ?? 'all'
  const [page, setPage] = useState<CursorPage>(firstPage)

  const query = useMemo(
    () => ({
      limit: PAGE_SIZE,
      ...(kind === 'all' ? {} : { kind }),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    }),
    [kind, page.cursor],
  )

  const outputs = useQuery({
    queryKey: keys.outputs(space, query),
    queryFn: () => wk.outputs.list(space, query),
  })

  const columns = useMemo<readonly DataColumn<OutputListRow>[]>(
    () => [
      {
        id: 'what',
        label: 'What was produced',
        required: true,
        className: 'max-w-96 whitespace-normal',
        cell: (row, index) => <OutputCell row={row} index={index} />,
      },
      {
        id: 'cited',
        label: 'Cited pages',
        priority: 'optional',
        className: 'text-right tabular-nums',
        // A measured zero, not a dash: an answer that quoted nothing is a fact
        // about the answer, and `citations` is always sent (CUI-SEV-2).
        // No testid of its own: the TableCell already carries
        // `answers-row-N-cited`, and a second element with the same id turns
        // every selector into a coin toss.
        cell: (row) => <span>{count(row.citations.length)}</span>,
      },
      {
        id: 'state',
        label: 'Status',
        required: true,
        cell: (row) => {
          const standing = filingStanding(row)
          // The word as well as the tone: a state is never carried by colour
          // alone (CUI-A11Y-5). The TableCell owns `answers-row-N-state`.
          return <Badge tone={standing.tone}>{t(standing.label)}</Badge>
        },
      },
      {
        id: 'made',
        label: 'Produced',
        priority: 'secondary',
        cell: (row) => <RelativeTime value={row.created_at} />,
      },
    ],
    [t],
  )

  const view = useTableView('answers', columns, 'cursor')

  return (
    <Page
      title="Answers"
      description="Answers and operational reports this wiki has produced. Only answers can become a reviewed knowledge proposal."
      actions={
        <Button asChild variant="outline">
          <Link to="/search" search={(prev) => prev} data-testid="answers-ask">
            Ask a question
          </Link>
        </Button>
      }
    >
      <DataTable
        testId="answers"
        columns={columns}
        rows={outputs.data?.items ?? []}
        rowKey={(row) => row.id}
        rowTestId={(_row, index) => `answers-row-${index + 1}`}
        rowAttributes={(row) => ({ 'data-kind': row.kind })}
        query={outputs}
        view={view.view}
        onViewChange={view.setView}
        page={page}
        onPageChange={setPage}
        pageSize={PAGE_SIZE}
        // A real keyset page: this list grows for as long as anybody asks
        // anything, and "1–20 of 20" over four thousand answers is a lie.
        paging="cursor"
        nextCursor={outputs.data?.next_before ?? null}
        unit="items"
        tableClassName="w-full table-fixed"
        toolbar={
          <div className="flex min-w-0 items-center gap-2">
            <Label htmlFor="answers-kind" className="sr-only">
              Kind
            </Label>
            <Select
              value={kind}
              onValueChange={(value) => {
                setFilters({ kind: value })
                // A cursor belongs to the result that produced it.
                setPage(resetPage())
              }}
            >
              <SelectTrigger id="answers-kind" size="sm" className="w-52" data-testid="answers-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value} data-testid={`answers-kind-${option.value}`}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        }
        empty={
          kind === 'all' ? (
            <EmptyState
              icon={MessageSquareQuote}
              framed={false}
              title="Nothing produced yet"
              description="Ask this wiki a question and the answer is kept here, with the pages it quoted."
              action={
                <Button asChild variant="outline">
                  <Link to="/search" search={(prev) => prev} data-testid="answers-empty-ask">
                    <Sparkles data-icon="inline-start" />
                    Ask a question
                  </Link>
                </Button>
              }
              data-testid="answers-empty"
            />
          ) : (
            // Filtered emptiness is a statement about the FILTER, never about
            // the wiki, and the two must not read alike (CUI-LOAD-4).
            <EmptyState
              icon={MessageSquareQuote}
              framed={false}
              title="Nothing of that kind"
              description="This is what the filter is showing, not what the wiki holds."
              data-testid="answers-empty-filtered"
            />
          )
        }
      />
    </Page>
  )
}

/**
 * One row's identity, which is a QUESTION where there was one.
 *
 * The kind badge sits beside it rather than in a column of its own: three kinds
 * over four columns would spend a whole column on a word that is only ever one
 * of three, and on a phone that column is the first thing to go.
 */
function OutputCell({ row, index }: { row: OutputListRow; index: number }) {
  const coverage = coverageOf(row)
  return (
    // The enclosing TableCell already carries `answers-row-N-what`; only the
    // ids that name something INSIDE the cell (-open, -uncovered) live here.
    <div className="flex min-w-0 flex-col gap-1">
      <Link
        to="/answers/$id"
        params={{ id: row.id }}
        search={(prev) => prev}
        data-testid={`answers-row-${index + 1}-open`}
        className="text-sm font-medium underline-offset-4 hover:underline"
      >
        {outputLabel(row, 'Untitled output')}
      </Link>
      <span className="line-clamp-2 text-xs text-muted-foreground">{row.summary}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{kindWord(row.kind)}</Badge>
        {coverage === 'not-covered' ? (
          // The most valuable thing an answer can say, kept in the list rather
          // than only in the document: this wiki did not know.
          <Badge tone="unknown" data-testid={`answers-row-${index + 1}-uncovered`}>
            Not covered
          </Badge>
        ) : null}
      </span>
    </div>
  )
}
