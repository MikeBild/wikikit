import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleCheck, FileUp, Inbox, Link2, NotebookPen, Upload } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { SectionHeading } from '@/components/context-help'
import { DataState, RowSkeleton } from '@/components/data-state'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { I18nText } from '@/components/i18n-text'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RelativeTime } from '@/components/ui/relative-time'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useTableView } from '@/hooks/use-table-view'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { firstPage, resetPage, type CursorPage } from '@/lib/cursor'
import { describeFailure } from '@/lib/failure'
import { fractionOf, liveReadOptions } from '@/lib/live'
import { useI18n } from '@/lib/i18n-context'
import { semanticLabel } from '@/lib/presentation'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { STATUS_STATE, type DomainState } from '@/lib/tokens'
import type { FilterSpec } from '@/lib/url-filters'
import { changeStanding } from '@/pages/home.logic'
import {
  DOCUMENT_ACCEPT,
  fileProblem,
  haltsRun,
  pendingSubmission,
  planUrls,
  tally,
  type Submission,
} from '@/pages/inbox.logic'
import { Confirm } from '@/components/confirm'
import { waitedDays } from '@/pages/care.logic'
import {
  captureBody,
  capturedDays,
  describeIngest,
  ingestBody,
  STALE_CAPTURE_DAYS,
  type IngestDraft,
} from '@/pages/sources.logic'

/**
 * Everything lands here.
 *
 * The Inbox is not a new object — `wk_ingest_jobs` and `wk_sources` have always
 * been the queue and the archive. What was missing was a PLACE: a wiki grew one
 * document at a time through a dialog on the archive page, and the two halves of
 * the same question lived on two screens. So this page answers both at once:
 * what arrived, and what of it still needs a human decision. Splitting those is
 * how a review queue becomes invisible.
 *
 * Three ways in, deliberately different shapes rather than one clever field:
 * files are dropped, addresses are pasted a column at a time, and typed text
 * gets the form that used to live on Sources. Each of them fans out into N
 * INDEPENDENT ingests — see `inbox.logic.ts` for why a batch would be worse.
 *
 * The ingest rules themselves stay in `sources.logic.ts`. That module is the
 * single owner of what a draft may contain and what a job's status means; the
 * form moved here, the rules did not move twice.
 */

/** `zIngestListQuery.limit` caps at 200; one screenful is what this page reads. */
const JOB_PAGE_SIZE = 25

/** How many pending changes the "still needs you" strip shows before pointing at the queue. */
const PENDING_SHOWN = 5

const PENDING_QUERY = { status: 'pending', limit: PENDING_SHOWN } as const

/** The server's own alphabet (`zIngestListQuery`), plus the neutral value. */
const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'quota_blocked', 'captured', 'discarded'] as const

const JOB_FILTERS: readonly FilterSpec[] = [{ key: 'status', values: JOB_STATUSES, fallback: 'all' }]

const JOB_STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'all', label: 'Everything that arrived' },
  { value: 'queued', label: 'Waiting for a worker' },
  { value: 'running', label: 'Being read' },
  { value: 'done', label: 'Finished' },
  { value: 'failed', label: 'Failed' },
  { value: 'quota_blocked', label: 'Paused on a quota' },
  { value: 'captured', label: 'Parked' },
  { value: 'discarded', label: 'Discarded' },
]

/** One screenful of parked notes; the strip caps rather than paginates — the fix for a full strip is deciding, not scrolling. */
const PARKED_QUERY = { status: 'captured', limit: 50 } as const

/**
 * The five domain states as badge tones. `satisfies` makes a state nobody
 * mapped a compile error rather than an undefined tone that renders neutral and
 * quietly loses a failure.
 */
const BADGE_TONE = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
} as const satisfies Record<DomainState, string>

/** Derived from the facade so a field the server stops sending stops compiling. */
type IngestJobRow = Awaited<ReturnType<typeof wk.ingest.list>>['items'][number]

/** One thing to send, with the call that sends it. Never held in state — see `Submission`. */
interface PlannedItem {
  key: string
  label: string
  send: () => Promise<{ ingest_id: string }>
}

export function InboxPage() {
  const space = useSpace()
  const can = useCan()
  const queryClient = useQueryClient()
  const mayAdd = can('knowledge:propose')

  const [run, setRun] = useState<readonly Submission[]>([])
  const [running, setRunning] = useState(false)

  const { filters, setFilters } = useUrlFilters('inbox', JOB_FILTERS)
  const status = filters.status ?? 'all'
  const [jobPage, setJobPage] = useState<CursorPage>(firstPage)

  const jobQuery = useMemo(
    () => ({
      limit: JOB_PAGE_SIZE,
      ...(status === 'all' ? {} : { status }),
      ...(jobPage.cursor ? { cursor: jobPage.cursor } : {}),
    }),
    [status, jobPage.cursor],
  )

  const jobs = useQuery({
    queryKey: keys.ingestJobs(space, jobQuery),
    queryFn: () => wk.ingest.list(space, jobQuery),
    // Poll while anything in the window is still moving, and stop when it is
    // not — the same rule the single-job panel uses, over a list.
    ...liveReadOptions<Awaited<ReturnType<typeof wk.ingest.list>>>((data) => data.items.map((item) => item.status)),
  })

  const pending = useQuery({
    queryKey: keys.changes(space, PENDING_QUERY),
    queryFn: () => wk.changes.list(space, PENDING_QUERY),
  })

  // No liveReadOptions here: `captured` only moves through this console's own
  // buttons, and those invalidate the whole space subtree themselves.
  const parked = useQuery({
    queryKey: keys.ingestJobs(space, PARKED_QUERY),
    queryFn: () => wk.ingest.list(space, PARKED_QUERY),
  })

  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: keys.space(space) }),
    [queryClient, space],
  )

  /**
   * The run, one item at a time and in order.
   *
   * Sequential rather than `Promise.all`, and that is the decision this
   * function exists for: thirty parallel uploads would race past the per-space
   * queue ceiling and collect thirty copies of one `429`, having already paid
   * for thirty extractions. One at a time means the ceiling stops the run at
   * the item that hit it, and everything after it stays visibly `pending`
   * rather than silently lost.
   */
  const start = useCallback(
    async (plan: readonly PlannedItem[]) => {
      if (plan.length === 0) return
      setRun(plan.map((item) => pendingSubmission(item.key, item.label)))
      setRunning(true)
      const patch = (key: string, next: Partial<Submission>) =>
        setRun((rows) => rows.map((row) => (row.key === key ? { ...row, ...next } : row)))
      for (const item of plan) {
        patch(item.key, { state: 'sending' })
        try {
          const result = await item.send()
          patch(item.key, { state: 'queued', ingestId: result.ingest_id })
        } catch (error) {
          const code = error instanceof ApiError ? error.code : null
          patch(item.key, {
            state: 'refused',
            code,
            // The server's own words, never rewritten (CUI-LOAD-2).
            refusal: error instanceof Error ? error.message : String(error),
          })
          if (haltsRun(code)) break
        }
      }
      setRunning(false)
      // The whole space subtree by prefix: the paged reads on this page register
      // under keys with a query slot, which `keys.ingestJobs(space)` alone is not
      // a prefix of. Only mounted queries refetch.
      void queryClient.invalidateQueries({ queryKey: keys.space(space) })
    },
    [queryClient, space],
  )

  const jobColumns = useMemo<readonly DataColumn<IngestJobRow>[]>(
    () => [
      {
        id: 'what',
        label: 'What arrived',
        required: true,
        className: 'max-w-72 whitespace-normal',
        cell: (row, index) => <JobCell row={row} index={index} />,
      },
      {
        id: 'status',
        label: 'Status',
        overflow: 'wrap',
        cell: (row, index) => (
          // The word as well as the colour: a status is never conveyed by tone
          // alone (CUI-A11Y-5).
          <Badge tone={BADGE_TONE[STATUS_STATE[row.status] ?? 'unknown']} data-testid={`inbox-job-${index + 1}-status`}>
            {row.status.replace('_', ' ')}
          </Badge>
        ),
      },
      {
        id: 'arrived',
        label: 'Arrived',
        priority: 'secondary',
        cell: (row, index) => <RelativeTime value={row.created_at} data-testid={`inbox-job-${index + 1}-arrived`} />,
      },
      {
        id: 'finished',
        label: 'Finished',
        priority: 'optional',
        // Never 0 and never blank: a job that has not finished has no finish
        // time, which is a different fact from one that finished instantly.
        cell: (row) =>
          row.finished_at ? <RelativeTime value={row.finished_at} /> : <span className="text-muted-foreground">—</span>,
      },
      {
        id: 'result',
        label: 'Result',
        required: true,
        className: 'text-right',
        cell: (row, index) => <JobResult row={row} index={index} />,
      },
    ],
    [],
  )

  const jobsView = useTableView('inbox-jobs', jobColumns, 'cursor')

  return (
    <Page
      title="Inbox"
      description="Everything lands here: drop documents, paste addresses, and watch what still needs a decision."
      actions={
        <Button asChild variant="outline">
          <Link to="/sources" search={(prev) => prev} data-testid="inbox-open-archive">
            The archive
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-4" aria-labelledby="inbox-capture-heading">
          <SectionHeading
            id="inbox-capture-heading"
            helpTitle="About holding thoughts"
            help={
              <p>
                A parked thought is held verbatim and costs nothing: no model reads it, no queue slot is taken, and
                nothing happens until it is processed — then it travels the ordinary path and comes back as a change to
                review — or discarded.
              </p>
            }
            testId="inbox-capture-help"
          >
            Hold a thought
          </SectionHeading>

          <CaptureCard space={space} allowed={mayAdd} onCaptured={refresh} />
          <ParkedStrip query={parked} allowed={mayAdd} onDecided={refresh} />
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="inbox-add-heading">
          <SectionHeading
            id="inbox-add-heading"
            helpTitle="About adding documents"
            help={
              <p>
                Every item becomes its own archived source and its own change, so one unreadable file never takes the
                rest of a drop with it. Nothing here is visible knowledge until somebody approves the change it raises.
              </p>
            }
            testId="inbox-add-help"
          >
            Throw something in
          </SectionHeading>

          <div className="grid gap-4 lg:grid-cols-3">
            <DropFiles space={space} allowed={mayAdd} busy={running} onStart={start} />
            <PasteLinks space={space} allowed={mayAdd} busy={running} onStart={start} />
            <PasteText space={space} allowed={mayAdd} busy={running} onStart={start} />
          </div>

          {run.length > 0 ? <RunReport items={run} running={running} onDismiss={() => setRun([])} /> : null}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="inbox-pending-heading">
          <h2 id="inbox-pending-heading" className="text-sm font-semibold">
            <I18nText>Still needs your decision</I18nText>
          </h2>
          <Card data-testid="inbox-pending-card">
            <CardHeader>
              <CardTitle>Waiting for review</CardTitle>
              <CardDescription>
                What arrived became pages. None of them is visible knowledge until a person approves it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataState
                testId="inbox-pending"
                query={pending}
                skeleton={<RowSkeleton rows={3} columns={2} />}
                isEmpty={(data) => data.items.length === 0}
                empty={
                  // An empty queue is GOOD NEWS and must not read like a failure
                  // (CUI-LOAD-4).
                  // No `data-testid` here: DataState already wraps whatever it
                  // is given in `${testId}-empty`, so naming this one the same
                  // puts two `inbox-pending-empty` nodes in the document and a
                  // selector stops addressing one thing.
                  <EmptyState
                    icon={CircleCheck}
                    framed={false}
                    title="Nothing is waiting"
                    description="Every change this wiki has raised has been decided."
                  />
                }
              >
                {(data) => (
                  <div className="flex flex-col gap-2">
                    <ul className="flex flex-col gap-0.5">
                      {data.items.map((item, index) => {
                        const standing = changeStanding(item.status, item.changes_requested)
                        return (
                          <li key={item.id}>
                            <Link
                              to="/changes/$id"
                              params={{ id: item.id }}
                              search={(prev) => prev}
                              data-testid={`inbox-pending-${index + 1}`}
                              className="hover:bg-muted focus-visible:ring-ring/50 flex flex-col gap-1 rounded-md px-2 py-1.5 transition-colors focus-visible:ring-3 focus-visible:outline-none sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                            >
                              <span className="min-w-0 truncate text-sm font-medium">
                                {semanticLabel([item.title], 'Knowledge change')}
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                <Badge tone={standing.tone}>{standing.label}</Badge>
                                <RelativeTime value={item.created_at} className="text-muted-foreground text-xs" />
                              </span>
                            </Link>
                          </li>
                        )
                      })}
                    </ul>
                    <Link
                      to="/changes"
                      search={(prev) => prev}
                      data-testid="inbox-pending-all"
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      The whole review queue
                    </Link>
                  </div>
                )}
              </DataState>
            </CardContent>
          </Card>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="inbox-jobs-heading">
          <h2 id="inbox-jobs-heading" className="text-sm font-semibold">
            <I18nText>What arrived</I18nText>
          </h2>
          <DataTable
            testId="inbox-jobs"
            columns={jobColumns}
            rows={jobs.data?.items ?? []}
            rowKey={(row) => row.ingest_id}
            rowTestId={(_row, index) => `inbox-job-${index + 1}`}
            rowAttributes={(row) => ({ 'data-status': row.status })}
            query={jobs}
            view={jobsView.view}
            onViewChange={jobsView.setView}
            page={jobPage}
            onPageChange={setJobPage}
            pageSize={JOB_PAGE_SIZE}
            // A real keyset page over a list that grows without bound, exactly
            // like the source archive: `'whole'` here would print "1–25 of 25"
            // over a wiki with four thousand jobs behind it.
            paging="cursor"
            nextCursor={jobs.data?.next_before ?? null}
            unit="items"
            tableClassName="w-full table-fixed"
            toolbar={
              <div className="flex min-w-0 items-center gap-2">
                <Label htmlFor="inbox-status" className="sr-only">
                  Filter by status
                </Label>
                <Select
                  value={status}
                  onValueChange={(value) => {
                    setFilters({ status: value })
                    // A cursor belongs to the result that produced it.
                    setJobPage(resetPage())
                  }}
                >
                  <SelectTrigger id="inbox-status" size="sm" className="w-52" data-testid="inbox-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {JOB_STATUS_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          data-testid={`inbox-status-${option.value}`}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            }
            empty={
              <EmptyState
                icon={Inbox}
                framed={false}
                title="Nothing has arrived yet"
                description="Drop a document, paste an address, or throw in a note — the pages come back as changes to review."
                data-testid="inbox-jobs-empty"
              />
            }
          />
        </section>
      </div>
    </Page>
  )
}

/**
 * One row's identity, which is a SENTENCE rather than a title.
 *
 * An ingest job carries no name of its own — the title belongs to the source it
 * archives, and until the archive step is done there is no source. So the row is
 * identified by what is happening to it, which is what `describeIngest` already
 * says on the single-job panel, and the two surfaces cannot drift because they
 * ask the same function.
 */
function JobCell({ row, index }: { row: IngestJobRow; index: number }) {
  const { text } = useI18n()
  const report = describeIngest(row)
  const fraction = fractionOf(report.progress?.done, report.progress?.total)
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={`inbox-job-${index + 1}-what`}>
      {/* A captured row is the one kind that carries its own name: the server
          sends title + excerpt because a parked note has no source to link to. */}
      <span className="text-sm font-medium">{row.title ?? text(report.headline)}</span>
      <span className="text-muted-foreground line-clamp-2 text-xs">{row.excerpt ?? text(report.detail)}</span>
      {report.progress ? (
        <span className="text-muted-foreground text-xs tabular-nums">
          {text('{done} of {total} pages written', { done: report.progress.done, total: report.progress.total })}
          {fraction === null ? null : ` · ${Math.round(fraction * 100)}%`}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Where a finished job LANDED — the whole reason this list is worth reading.
 *
 * A change beats a source: a job that produced a proposal is a job somebody has
 * to act on, and the archived bytes are one click further on from there. A job
 * that archived without proposing links to the source instead, because "nothing
 * to review" still has something to show.
 */
function JobResult({ row, index }: { row: IngestJobRow; index: number }) {
  if (row.proposal_id) {
    return (
      <Link
        to="/changes/$id"
        params={{ id: row.proposal_id }}
        search={(prev) => prev}
        data-testid={`inbox-job-${index + 1}-change`}
        className="text-sm underline-offset-4 hover:underline"
      >
        {/* The DataTable's cell wrapper cannot see through a component
            boundary, so the phrase is routed to the catalog here. */}
        <I18nText>Review the change</I18nText>
      </Link>
    )
  }
  if (row.source_id) {
    return (
      <Link
        to="/sources/$id"
        params={{ id: row.source_id }}
        search={(prev) => prev}
        data-testid={`inbox-job-${index + 1}-source`}
        className="text-sm underline-offset-4 hover:underline"
      >
        <I18nText>The archived document</I18nText>
      </Link>
    )
  }
  // Not a zero and not a blank cell: a job with neither yet has produced
  // nothing to open, which is a fact about the job and not a missing value.
  return <span className="text-muted-foreground">—</span>
}

/**
 * Files, dropped or chosen.
 *
 * A real `<input type="file">` behind a label rather than a div with a click
 * handler: the input is what a keyboard reaches and what a screen reader
 * announces, and the drop handlers are an addition to it rather than a
 * replacement for it (CUI-ACT-3).
 */
function DropFiles({
  space,
  allowed,
  busy,
  onStart,
}: {
  space: string
  allowed: boolean
  busy: boolean
  onStart: (plan: readonly PlannedItem[]) => Promise<void>
}) {
  const input = useRef<HTMLInputElement | null>(null)
  const [over, setOver] = useState(false)
  const [rejected, setRejected] = useState<readonly string[]>([])

  const accept = (list: FileList | null) => {
    const files = Array.from(list ?? [])
    const bad: string[] = []
    const plan: PlannedItem[] = []
    for (const [index, file] of files.entries()) {
      const problem = fileProblem(file)
      if (problem) {
        bad.push(`${file.name} — ${problem}`)
        continue
      }
      plan.push({
        key: `file-${index}-${file.name}`,
        label: file.name,
        send: () => wk.ingest.document(space, file.name, file),
      })
    }
    setRejected(bad)
    void onStart(plan)
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="inbox-dropzone"
        data-over={over ? 'true' : undefined}
        className={
          over
            ? 'border-accent bg-accent/5 flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center'
            : 'border-border flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center'
        }
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          if (allowed && !busy) accept(event.dataTransfer.files)
        }}
      >
        <FileUp className="text-muted-foreground size-6" aria-hidden="true" />
        <p className="text-sm font-medium">
          <I18nText>Drop documents here</I18nText>
        </p>
        <p className="text-muted-foreground text-xs">
          <I18nText>pdf, docx, xlsx, md, txt, csv — one job per file.</I18nText>
        </p>
        <Input
          ref={input}
          id="inbox-files"
          data-testid="inbox-files"
          type="file"
          multiple
          accept={DOCUMENT_ACCEPT}
          className="sr-only"
          disabled={!allowed || busy}
          onChange={(event) => {
            accept(event.target.files)
            // Cleared so dropping the same file twice still fires a change —
            // the second attempt is a legitimate retry after a failure.
            event.target.value = ''
          }}
        />
        <DisabledReason reason={allowed ? null : 'Needs knowledge:propose'} data-testid="inbox-choose-reason">
          <Button
            variant="outline"
            size="sm"
            data-testid="inbox-choose"
            disabled={!allowed || busy}
            onClick={() => input.current?.click()}
          >
            <Upload data-icon="inline-start" />
            Choose files
          </Button>
        </DisabledReason>
      </div>
      {rejected.length > 0 ? (
        <Alert tone="warning" title="Some files were not sent" data-testid="inbox-files-rejected">
          <ul className="flex flex-col gap-1">
            {rejected.map((line) => (
              <li key={line} className="text-xs">
                {line}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  )
}

/** Many addresses at once — one per line, one job each. */
function PasteLinks({
  space,
  allowed,
  busy,
  onStart,
}: {
  space: string
  allowed: boolean
  busy: boolean
  onStart: (plan: readonly PlannedItem[]) => Promise<void>
}) {
  const [text, setText] = useState('')
  const plan = planUrls(text)
  const reason = !allowed ? 'Needs knowledge:propose' : plan.urls.length === 0 ? 'Paste at least one address.' : null

  return (
    <div className="border-border flex flex-col gap-2 rounded-lg border p-4">
      <I18nText>
        <Label htmlFor="inbox-urls">Paste addresses, one per line</Label>
      </I18nText>
      <Textarea
        id="inbox-urls"
        data-testid="inbox-urls"
        rows={5}
        className="max-h-40 font-mono text-xs"
        placeholder="https://example.com/handbook"
        value={text}
        disabled={!allowed || busy}
        onChange={(event) => setText(event.target.value)}
      />
      {plan.rejected.length > 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="inbox-urls-rejected">
          <I18nText>Lines that are not http:// or https:// addresses are ignored:</I18nText>{' '}
          {plan.rejected.slice(0, 3).join(' · ')}
        </p>
      ) : null}
      <DisabledReason reason={reason} data-testid="inbox-urls-reason">
        <Button
          size="sm"
          className="w-fit"
          data-testid="inbox-urls-submit"
          disabled={reason !== null || busy}
          aria-busy={busy}
          onClick={() => {
            void onStart(
              plan.urls.map((url, index) => ({
                key: `url-${index}-${url}`,
                label: url,
                send: () =>
                  wk.ingest.submit(
                    space,
                    ingestBody({ transport: 'url', content: url, title: '', sourceKind: '', language: '' }),
                  ),
              })),
            )
            setText('')
          }}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <Link2 data-icon="inline-start" />}
          Fetch these pages
        </Button>
      </DisabledReason>
    </div>
  )
}

/**
 * The typed document — the form that used to open as a dialog on Sources.
 *
 * Not a dialog any more, and not a `Confirm` either. Adding a document lands
 * nowhere: it archives bytes and drafts a change proposal, and that proposal IS
 * the confirmation step. What a Confirm's `details` would have said is the
 * section help above, before the click rather than after it.
 */
function PasteText({
  space,
  allowed,
  busy,
  onStart,
}: {
  space: string
  allowed: boolean
  busy: boolean
  onStart: (plan: readonly PlannedItem[]) => Promise<void>
}) {
  const [draft, setDraft] = useState<IngestDraft>({
    transport: 'markdown',
    content: '',
    title: '',
    sourceKind: '',
    language: '',
  })
  const reason = !allowed ? 'Needs knowledge:propose' : draft.content.trim() ? null : 'Paste the document first.'

  return (
    <div className="border-border flex flex-col gap-2 rounded-lg border p-4">
      <I18nText>
        <Label htmlFor="inbox-text">Throw in a note or a document</Label>
      </I18nText>
      <Textarea
        id="inbox-text"
        data-testid="inbox-text"
        rows={5}
        className="max-h-40 font-mono text-xs"
        placeholder="A meeting note, an email, a transcript, a Markdown page."
        value={draft.content}
        disabled={!allowed || busy}
        onChange={(event) => setDraft({ ...draft, content: event.target.value })}
      />
      {/* One wrapper for the whole row: the title placeholder and the kind
          items are element-tree strings, which is exactly what I18nText can
          reach — `value` props stay data and stay untouched. */}
      <I18nText>
        <div className="flex flex-wrap gap-2">
          <Input
            id="inbox-text-title"
            data-testid="inbox-text-title"
            className="h-8 min-w-0 flex-1 text-xs"
            placeholder="Title (optional)"
            value={draft.title}
            disabled={!allowed || busy}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <Select
            value={draft.sourceKind || 'unstated'}
            onValueChange={(value) =>
              setDraft({ ...draft, sourceKind: value === 'unstated' ? '' : (value as IngestDraft['sourceKind']) })
            }
          >
            <SelectTrigger id="inbox-text-kind" size="sm" className="w-36" data-testid="inbox-text-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="unstated" data-testid="inbox-text-kind-unstated">
                  Not stated
                </SelectItem>
                <SelectItem value="meeting" data-testid="inbox-text-kind-meeting">
                  Meeting
                </SelectItem>
                <SelectItem value="article" data-testid="inbox-text-kind-article">
                  Article
                </SelectItem>
                <SelectItem value="note" data-testid="inbox-text-kind-note">
                  Note
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </I18nText>
      {/* Said out loud because it is the only field here that changes what
          synthesis DOES: a meeting is also read for the decisions it records. */}
      <p className="text-muted-foreground text-xs">
        <I18nText>A meeting is also read for the decisions it records.</I18nText>
      </p>
      <DisabledReason reason={reason} data-testid="inbox-text-reason">
        <Button
          size="sm"
          className="w-fit"
          data-testid="inbox-text-submit"
          disabled={reason !== null || busy}
          aria-busy={busy}
          onClick={() => {
            void onStart([
              {
                key: 'text-1',
                label: draft.title.trim() || 'Pasted document',
                send: () => wk.ingest.submit(space, ingestBody(draft)),
              },
            ])
            setDraft({ ...draft, content: '', title: '' })
          }}
        >
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Add this document
        </Button>
      </DisabledReason>
    </div>
  )
}

/**
 * What became of the last drop, item by item.
 *
 * Every outcome is kept, including `pending` — the items a full queue stopped
 * before they were sent. Collapsing those into "12 of 30 added" would hide
 * exactly the fact the operator needs, which is WHICH eighteen still have to go
 * somewhere.
 */
function RunReport({
  items,
  running,
  onDismiss,
}: {
  items: readonly Submission[]
  running: boolean
  onDismiss: () => void
}) {
  const { text } = useI18n()
  const counts = tally(items)
  const stopped = items.find((item) => item.state === 'refused' && haltsRun(item.code))
  const refusal = stopped ? describeFailure({ status: 429, message: stopped.refusal ?? '', actions: [] }) : null

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4" data-testid="inbox-run">
      <div className="flex flex-wrap items-center gap-2">
        {running ? <Spinner className="text-muted-foreground shrink-0" /> : null}
        <span className="text-sm font-medium">
          {text('{queued} added · {refused} refused · {pending} not sent', {
            queued: counts.queued,
            refused: counts.refused,
            pending: counts.pending,
          })}
        </span>
        <DisabledReason reason={null} label="Clear this report" data-testid="inbox-run-dismiss-tooltip">
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            data-testid="inbox-run-dismiss"
            disabled={running}
            onClick={onDismiss}
          >
            Clear
          </Button>
        </DisabledReason>
      </div>

      {refusal ? (
        <Alert tone={refusal.tone} title={refusal.title} actions={refusal.actions} data-testid="inbox-run-halted">
          <div className="flex flex-col gap-2">
            <span>{refusal.message}</span>
            <span>
              <I18nText>
                The rest of this drop was not sent. Deciding the changes already waiting is what makes room.
              </I18nText>
            </span>
          </div>
        </Alert>
      ) : null}

      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li key={item.key} className="flex flex-wrap items-baseline gap-2" data-testid={`inbox-run-${index + 1}`}>
            <span className="min-w-0 flex-1 truncate text-xs">{item.label}</span>
            <Badge tone={ITEM_TONE[item.state]}>{text(ITEM_WORD[item.state])}</Badge>
            {item.refusal ? <span className="text-muted-foreground w-full text-xs">{item.refusal}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One textarea, one button — deliberately nothing else.
 *
 * Capture is the place NOT to think: no title field, no kind, no language.
 * Every option this card could offer is a decision it would demand at exactly
 * the moment the whole point is to not make one; whatever the thought needs,
 * it gets when somebody processes it. The submit is not behind a `Confirm`
 * either — parking has no consequence to restate, and the two consequential
 * moves (process, discard) carry the dialogs instead.
 */
function CaptureCard({ space, allowed, onCaptured }: { space: string; allowed: boolean; onCaptured: () => void }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const reason = !allowed ? 'Needs knowledge:propose' : note.trim() ? null : 'Write the thought first.'

  const park = async () => {
    setSaving(true)
    setRefusal(null)
    try {
      await wk.ingest.submit(space, captureBody(note))
      setNote('')
      onCaptured()
    } catch (error) {
      // The server's own words, never rewritten (CUI-LOAD-2).
      setRefusal(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-border flex flex-col gap-2 rounded-lg border p-4">
      <I18nText>
        <Label htmlFor="inbox-capture">Park it verbatim — a title, a kind, a decision can all come later.</Label>
      </I18nText>
      <Textarea
        id="inbox-capture"
        data-testid="inbox-capture"
        rows={3}
        className="max-h-40"
        placeholder="Whatever is in your head right now."
        value={note}
        disabled={!allowed || saving}
        onChange={(event) => setNote(event.target.value)}
      />
      {refusal ? (
        <Alert tone="danger" title="Could not be parked" data-testid="inbox-capture-refused">
          {refusal}
        </Alert>
      ) : null}
      <DisabledReason reason={reason} data-testid="inbox-capture-reason">
        <Button
          size="sm"
          className="w-fit"
          data-testid="inbox-capture-submit"
          disabled={reason !== null || saving}
          aria-busy={saving}
          onClick={() => void park()}
        >
          {saving ? <Spinner data-icon="inline-start" /> : <NotebookPen data-icon="inline-start" />}
          Hold this thought
        </Button>
      </DisabledReason>
    </div>
  )
}

/**
 * The parked notes, oldest wait made visible, each with its two ways out.
 *
 * A capped whole read rather than a cursor: fifty undecided thoughts is not a
 * list to browse, it is a backlog to clear, and the cap note says so when it
 * fills. The warning badge starts at `STALE_CAPTURE_DAYS` — an old parked note
 * is a signal, not an error.
 */
function ParkedStrip({
  query,
  allowed,
  onDecided,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof wk.ingest.list>>>>
  allowed: boolean
  onDecided: () => void
}) {
  const { text } = useI18n()
  const [page, setPage] = useState<CursorPage>(firstPage)

  const columns = useMemo<readonly DataColumn<IngestJobRow>[]>(
    () => [
      {
        id: 'what',
        label: 'Thought',
        required: true,
        className: 'max-w-96 whitespace-normal',
        cell: (row, index) => (
          <div className="flex min-w-0 flex-col gap-0.5" data-testid={`inbox-parked-${index + 1}-what`}>
            <span className="text-sm font-medium">{semanticLabel([row.title], 'Parked thought')}</span>
            {row.excerpt ? <span className="text-muted-foreground line-clamp-2 text-xs">{row.excerpt}</span> : null}
          </div>
        ),
      },
      {
        id: 'parked',
        label: 'Parked',
        priority: 'secondary',
        cell: (row, index) => {
          const days = capturedDays(row.created_at, Date.now())
          const waited = waitedDays(days)
          return (
            <span className="flex items-center gap-2">
              <RelativeTime value={row.created_at} data-testid={`inbox-parked-${index + 1}-since`} />
              {days >= STALE_CAPTURE_DAYS && waited.phrase ? (
                <Badge tone="warning" data-testid={`inbox-parked-${index + 1}-stale`}>
                  {text(waited.phrase, waited.values)}
                </Badge>
              ) : null}
            </span>
          )
        },
      },
      {
        id: 'decision',
        label: 'Decision',
        required: true,
        className: 'text-right',
        cell: (row, index) => (
          <span className="flex items-center justify-end gap-2">
            <Confirm
              title="Process this thought?"
              description="It joins the ingest queue exactly like a submitted document."
              details="The model archives it verbatim, quotes it into pages, and the result waits in Changes — nothing becomes visible knowledge until a person approves it."
              confirmLabel="Process"
              onConfirm={async () => {
                await wk.ingest.process(row.ingest_id)
                onDecided()
              }}
            >
              {(open) => (
                <DisabledReason
                  reason={allowed ? null : 'Needs knowledge:propose'}
                  data-testid={`inbox-parked-${index + 1}-process-reason`}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`inbox-parked-${index + 1}-process`}
                    disabled={!allowed}
                    onClick={open}
                  >
                    Process
                  </Button>
                </DisabledReason>
              )}
            </Confirm>
            <Confirm
              title="Discard this thought?"
              description="It never becomes knowledge."
              details="The note is marked discarded and stays in the job list for the record. Nothing was archived, so there is nothing else to remove."
              confirmLabel="Discard"
              destructive
              onConfirm={async () => {
                await wk.ingest.discard(row.ingest_id)
                onDecided()
              }}
            >
              {(open) => (
                <DisabledReason
                  reason={allowed ? null : 'Needs knowledge:propose'}
                  data-testid={`inbox-parked-${index + 1}-discard-reason`}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`inbox-parked-${index + 1}-discard`}
                    disabled={!allowed}
                    onClick={open}
                  >
                    Discard
                  </Button>
                </DisabledReason>
              )}
            </Confirm>
          </span>
        ),
      },
    ],
    [allowed, onDecided, text],
  )

  const view = useTableView('inbox-parked', columns)

  return (
    <DataTable
      testId="inbox-parked"
      columns={columns}
      rows={query.data?.items ?? []}
      rowKey={(row) => row.ingest_id}
      rowTestId={(_row, index) => `inbox-parked-${index + 1}`}
      query={query}
      view={view.view}
      onViewChange={view.setView}
      page={page}
      onPageChange={setPage}
      unit="items"
      cap={PARKED_QUERY.limit}
      tableClassName="w-full table-fixed"
      empty={
        <EmptyState
          icon={NotebookPen}
          framed={false}
          title="Nothing is parked"
          description="A thought held here waits, verbatim and unread, until you process or discard it."
          data-testid="inbox-parked-none"
        />
      }
    />
  )
}

/**
 * The four submission states as words and tones. `pending` is `unknown` rather
 * than a failure: nothing went wrong with it, it simply never went.
 */
const ITEM_WORD: Record<Submission['state'], string> = {
  pending: 'Not sent',
  sending: 'Sending',
  queued: 'Added',
  refused: 'Refused',
}

const ITEM_TONE: Record<Submission['state'], 'unknown' | 'accent' | 'success' | 'danger'> = {
  pending: 'unknown',
  sending: 'accent',
  queued: 'success',
  refused: 'danger',
}
