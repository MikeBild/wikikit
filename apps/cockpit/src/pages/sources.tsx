import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Archive, Plus, Radio, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ApiError } from '@/api/client'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RelativeTime } from '@/components/ui/relative-time'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { useTableView } from '@/hooks/use-table-view'
import { firstPage, type CursorPage } from '@/lib/cursor'
import { describeFailure } from '@/lib/failure'
import { isTerminalStatus, liveReadOptions } from '@/lib/live'
import { isRetrying, readFailure, readPhase } from '@/lib/read-state'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { STATUS_STATE, type DomainState } from '@/lib/tokens'
import { semanticLabel } from '@/lib/presentation'
import {
  EMPTY_INGEST_DRAFT,
  STREAM_CAP_NOTE,
  STREAM_CEILING,
  describeIngest,
  ingestBody,
  ingestProblem,
  sourceLabel,
  type IngestDraft,
  type IngestTransport,
} from '@/pages/sources.logic'

/**
 * The evidence, and the way more of it gets in.
 *
 * Sources are the floor the whole product stands on: a concept page may not
 * assert anything that is not quoted verbatim from one of these rows. So this
 * page is deliberately two lists and one action — what is archived, which
 * connectors are feeding it, and "add documents", which is where a wiki grows
 * from.
 */

/** Derived from the facade so a field the server stops sending stops compiling. */
type SourceSummary = Awaited<ReturnType<typeof wk.sources.list>>['items'][number]
type SourceStream = Awaited<ReturnType<typeof wk.sources.streams>>['items'][number]

/**
 * How many sources one page asks for.
 *
 * This is a real keyset page, not a ceiling — see the paging note on the table
 * below — so the number is a window size and nothing here has to caveat it.
 */
const PAGE_SIZE = 25

/**
 * The stream read, spelled once.
 *
 * A module constant rather than an object literal at the call site because it
 * is BOTH the request and half of the query key: two literals would be deep
 * equal today and one edit away from a mutation that invalidates a key nothing
 * is registered under, which is a list that keeps showing a stream somebody
 * just forgot.
 */
const STREAM_QUERY = { limit: STREAM_CEILING } as const

const KIND_WORDS: Record<string, string> = {
  markdown: 'Markdown',
  text: 'Text',
  url: 'Web page',
  import: 'Imported',
}

/**
 * The five domain states as badge tones.
 *
 * `STATE_TOKEN` in `@/lib/tokens` answers the same question for an SVG stroke,
 * where a Tailwind class cannot reach; this is the `Badge` half of it. Total by
 * construction — `satisfies` makes a state nobody mapped a compile error rather
 * than an `undefined` tone that renders as neutral and quietly loses a failure.
 */
const BADGE_TONE = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
} as const satisfies Record<DomainState, string>

/**
 * The columns, at module scope because not one cell closes over page state.
 *
 * NO comparators, and that is the whole reason this list is different from
 * every other list in the console. `/v1/spaces/{space}/sources` is the one read
 * here that genuinely pages — it answers a `next_before` keyset cursor over an
 * archive that grows without bound — so the console holds one window of 25 rows
 * out of however many thousand exist. A comparator on `archived` would reorder
 * those 25 and produce a table that looks sorted by date and is sorted by
 * nothing: `sortReach` grades exactly that case `'page'`, and `'page'` is the
 * lie the header control must not render. The endpoint's own order — newest
 * archived first — is the order, and the pagination walk is what reaches the
 * rest.
 */
const SOURCE_COLUMNS: readonly DataColumn<SourceSummary>[] = [
  {
    id: 'title',
    label: 'Source',
    required: true,
    cell: (row) => (
      <Link
        to="/sources/$id"
        params={{ id: row.id }}
        data-testid={`source-link-${row.id}`}
        className="font-medium underline-offset-4 hover:underline"
      >
        {sourceLabel(row)}
      </Link>
    ),
  },
  {
    id: 'kind',
    label: 'Kind',
    // A kind is not a status — it is what the bytes are, and nothing about it
    // is good or bad news. `neutral` is the only honest tone; a `url` source
    // wearing `accent` would read as though the console had an opinion about
    // where evidence should come from.
    cell: (row) => <Badge tone="neutral">{KIND_WORDS[row.kind] ?? row.kind}</Badge>,
  },
  {
    id: 'archived',
    label: 'Archived',
    cell: (row) => <RelativeTime value={row.created_at} data-testid={`source-archived-${row.id}`} />,
  },
  {
    id: 'url',
    label: 'Address',
    hiddenByDefault: true,
    // Text, not a link. This column is off by default and exists so an operator
    // can see WHERE a batch of sources came from; making 25 of them
    // externally-navigating anchors in a table whose every row already has one
    // link is how somebody leaves the console by accident. The source page
    // carries the real link.
    cell: (row) => <span className="text-muted-foreground block max-w-[28ch] truncate text-xs">{row.url ?? '—'}</span>,
  },
  {
    id: 'hash',
    label: 'Content hash',
    // The first twelve characters of a sha256, which is what the eye compares.
    // The whole 64 and a copy control live on the source page: a copy button in
    // every row of every page is 25 tab stops for a value nobody copies 25 of.
    cell: (row) => (
      <code className="text-muted-foreground font-mono text-xs" data-testid={`source-hash-${row.id}`}>
        {row.content_hash.slice(0, 12)}
      </code>
    ),
  },
]

export function SourcesPage() {
  const space = useSpace()
  const can = useCan()
  const queryClient = useQueryClient()

  const [page, setPage] = useState<CursorPage>(firstPage)
  const [streamPage, setStreamPage] = useState<CursorPage>(firstPage)
  const [adding, setAdding] = useState(false)
  /**
   * The ingest jobs this visit started, newest first.
   *
   * In component state and not in the URL, which is the exception to "a view is
   * an address" rather than a lapse: an ingest id addresses a job that is over
   * in a minute, and a link to a finished one opens a panel saying a thing the
   * Changes queue says better. A reload loses the panel and loses nothing else
   * — the work continues on the server and the pages still arrive in Changes,
   * which is where the operator is being sent anyway.
   */
  const [jobs, setJobs] = useState<readonly string[]>([])

  const sourcesQuery = useQuery({
    queryKey: keys.sources(space, { before: page.cursor, limit: PAGE_SIZE }),
    queryFn: () => wk.sources.list(space, { limit: PAGE_SIZE, ...(page.cursor ? { before: page.cursor } : {}) }),
  })

  const streamsQuery = useQuery({
    queryKey: keys.streams(space, STREAM_QUERY),
    queryFn: () => wk.sources.streams(space, STREAM_QUERY),
  })

  const sourcesView = useTableView('sources', SOURCE_COLUMNS, 'cursor')

  const mayAdd = can('knowledge:propose')

  const forget = useMutation({
    mutationFn: (externalSourceId: string) => wk.sources.forgetStream(space, externalSourceId),
    // The SAME key the read registered under, query slot included. A key of
    // `keys.streams(space)` spells that slot `null`, which is not a prefix of
    // `[..., { limit }]` and would invalidate nothing at all — the forgotten
    // stream would sit in the table until a reload.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.streams(space, STREAM_QUERY) }),
    // Deliberately no `onError` toast. `Confirm` awaits `mutateAsync`, catches
    // the rejection and prints the server's own words inside the dialog the
    // operator is still standing in — a toast in the corner as well would
    // report one refusal twice, in two places, one of which auto-dismisses.
  })

  const streamColumns = useMemo<readonly DataColumn<SourceStream>[]>(
    () => [
      {
        id: 'external',
        label: 'Document',
        required: true,
        cell: (row) => (
          <span className="font-mono text-xs break-all" data-testid={`stream-id-${row.id}`}>
            {semanticLabel([row.external_source_id], 'Connector document')}
          </span>
        ),
      },
      {
        id: 'version',
        label: 'Version',
        cell: (row) => <span className="text-muted-foreground text-xs">{row.latest_version ?? '—'}</span>,
      },
      {
        id: 'seen',
        label: 'Last seen',
        cell: (row) => <RelativeTime value={row.latest_observed_at} data-testid={`stream-seen-${row.id}`} />,
      },
      {
        id: 'head',
        label: 'Current version',
        cell: (row) =>
          row.latest_source_id ? (
            <Link
              to="/sources/$id"
              params={{ id: row.latest_source_id }}
              data-testid={`stream-head-${row.id}`}
              className="underline-offset-4 hover:underline"
            >
              Open
            </Link>
          ) : (
            // Never 0 and never a blank cell: a stream with no head is a
            // connector that registered a document and has not pushed one yet.
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        label: 'Actions',
        headerHidden: true,
        required: true,
        className: 'text-right',
        cell: (row) => <ForgetStream stream={row} allowed={mayAdd} onForget={forget.mutateAsync} />,
      },
    ],
    // `mayAdd`, not `can`: `useCan` hands back a fresh closure on every render,
    // so depending on it would rebuild the columns on every keystroke anywhere
    // on this page and re-derive the table view behind them.
    [mayAdd, forget.mutateAsync],
  )

  const streamsView = useTableView('streams', streamColumns)

  return (
    <Page
      title="Sources"
      description="The documents this wiki has archived verbatim. Every claim on every page quotes one of them."
      actions={
        <DisabledReason reason={mayAdd ? null : 'Needs knowledge:propose'} data-testid="add-documents-reason">
          <Button data-testid="add-documents" disabled={!mayAdd} onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" />
            Add documents
          </Button>
        </DisabledReason>
      }
    >
      <div className="flex flex-col gap-8">
        {jobs.length > 0 ? (
          <section className="flex flex-col gap-3" aria-labelledby="ingest-heading">
            <h2 id="ingest-heading" className="text-sm font-semibold">
              Being added
            </h2>
            <div className="flex flex-col gap-3">
              {jobs.map((id) => (
                <IngestJob key={id} id={id} onDismiss={() => setJobs((open) => open.filter((job) => job !== id))} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-3" aria-labelledby="sources-heading">
          <h2 id="sources-heading" className="text-sm font-semibold">
            Archive
          </h2>
          <DataTable
            testId="sources"
            columns={SOURCE_COLUMNS}
            rows={sourcesQuery.data?.items ?? []}
            rowKey={(row) => row.id}
            rowTestId={(row) => `source-row-${row.id}`}
            query={sourcesQuery}
            view={sourcesView.view}
            onViewChange={sourcesView.setView}
            page={page}
            onPageChange={setPage}
            pageSize={PAGE_SIZE}
            // The one genuinely cursor-paged read in this console. `'whole'`
            // here would let the table print "1–25 of 25" over an archive of
            // four thousand and offer sort controls that reorder the window.
            paging="cursor"
            nextCursor={sourcesQuery.data?.next_before ?? null}
            unit="sources"
            empty={
              <EmptyState
                icon={Archive}
                framed={false}
                title="No sources yet"
                description="A wiki with no evidence can hold no knowledge. Add a document and WikiKit archives it verbatim, then drafts pages that quote it."
                data-testid="sources-empty-state"
                action={
                  <DisabledReason reason={mayAdd ? null : 'Needs knowledge:propose'}>
                    <Button data-testid="add-documents-empty" disabled={!mayAdd} onClick={() => setAdding(true)}>
                      <Plus data-icon="inline-start" />
                      Add documents
                    </Button>
                  </DisabledReason>
                }
              />
            }
          />
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="streams-heading">
          <div className="flex flex-col gap-1">
            <h2 id="streams-heading" className="text-sm font-semibold">
              Connector streams
            </h2>
            <p className="text-muted-foreground text-sm">
              One stream is one upstream document that a connector keeps in step — each push archives a new version and
              moves the stream's head.
            </p>
          </div>
          <DataTable
            testId="streams"
            columns={streamColumns}
            rows={streamsQuery.data?.items ?? []}
            rowKey={(row) => row.id}
            rowTestId={(row) => `stream-row-${row.id}`}
            query={streamsQuery}
            view={streamsView.view}
            onViewChange={streamsView.setView}
            // A whole-list read with a CEILING, which is not the same thing as
            // an answer that holds everything: the endpoint offers no cursor,
            // so the window below is minted here over the rows that arrived,
            // and `cap` is what stops a full response from reading as a
            // complete one. Most wikis have one screen of streams; the ones
            // that do not are exactly the ones an operator needs told.
            page={streamPage}
            onPageChange={setStreamPage}
            unit="streams"
            cap={STREAM_CEILING}
            capNote={STREAM_CAP_NOTE}
            empty={
              <EmptyState
                icon={Radio}
                framed={false}
                title="No connector streams"
                description="Every source in this wiki was added by hand. A stream appears when a connector pushes a document with a stable id, so later versions of it replace this one instead of forking the archive."
                data-testid="streams-empty-state"
              />
            }
          />
        </section>
      </div>

      <AddDocuments
        space={space}
        open={adding}
        onOpenChange={setAdding}
        onQueued={(ingestId) => {
          setJobs((open) => [ingestId, ...open])
          // Back to the newest window: the source being archived lands at the
          // top of the list, and leaving the operator three pages deep would
          // hide the thing they just added behind two clicks of Previous.
          setPage(firstPage)
          setAdding(false)
        }}
      />
    </Page>
  )
}

/**
 * Forgetting a stream, behind the exact effect.
 *
 * The word on the button is "Forget" rather than "Delete" because deletion is
 * not what happens and the operator must not think it is. Tombstoning never
 * touches `wk_sources`: the archived bytes stay, every claim quoting them stays
 * visible and stays citable, and the only change is that this console stops
 * listing the stream and the `tombstoned-sources` lint rule starts naming the
 * claims whose upstream document is gone. That is the sentence in `details`,
 * and it is the sentence somebody needs before they press this at 03:00.
 */
function ForgetStream({
  stream,
  allowed,
  onForget,
}: {
  stream: SourceStream
  allowed: boolean
  onForget: (externalSourceId: string) => Promise<unknown>
}) {
  return (
    <Confirm
      title="Forget this stream?"
      description={`WikiKit will stop tracking ${stream.external_source_id} as a live document.`}
      destructive
      confirmLabel="Forget stream"
      details={
        <div className="flex flex-col gap-2">
          <p>
            Nothing is deleted. The versions already archived stay exactly as they are, and every page that quotes them
            keeps its evidence — a claim never loses its citation.
          </p>
          <p>
            What changes: this stream leaves the list below, and the wiki's lint report starts naming the visible claims
            whose upstream document no longer exists, so a human can decide what to do about them. A later push from the
            connector brings the stream back.
          </p>
        </div>
      }
      onConfirm={() => onForget(stream.external_source_id)}
    >
      {(open) => (
        <DisabledReason reason={allowed ? null : 'Needs knowledge:propose'}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Forget ${stream.external_source_id}`}
            data-testid={`stream-forget-${stream.id}`}
            disabled={!allowed}
            onClick={open}
          >
            <Trash2 />
          </Button>
        </DisabledReason>
      )}
    </Confirm>
  )
}

/**
 * One ingest job, watched until it stops moving.
 *
 * The polling is `liveReadOptions`, not a local `setInterval`: its terminal set
 * is `done | failed` and pointedly NOT `quota_blocked`, which reads settled and
 * resumes by itself. A panel that stopped asking there would leave an operator
 * staring at "paused" on a job that finished overnight.
 */
function IngestJob({ id, onDismiss }: { id: string; onDismiss: () => void }) {
  const job = useQuery({
    queryKey: keys.ingestJob(id),
    queryFn: () => wk.ingest.job(id),
    ...liveReadOptions<Awaited<ReturnType<typeof wk.ingest.job>>>((data) => [data.status]),
  })

  // `readPhase`, not `isError`: a query TanStack is still retrying holds the
  // server's refusal in `failureReason` while its status is still pending, and
  // branching on `isError` would keep saying "queued" over an answer that has
  // already arrived — for the whole retry budget.
  if (readPhase(job) === 'error') {
    const error = readFailure(job)
    const failure = describeFailure({
      status: error instanceof ApiError ? error.status : null,
      message: error instanceof Error ? error.message : String(error),
      actions: error instanceof ApiError ? error.nextBestActions : [],
      retrying: isRetrying(job),
    })
    return (
      <Alert tone={failure.tone} title={failure.title} actions={failure.actions} data-testid={`ingest-error-${id}`}>
        {failure.message}
      </Alert>
    )
  }

  // No skeleton for a panel that was created by a click: the operator pressed
  // Add one moment ago, so "queued" is the truth until the first answer lands
  // and a shimmering box in its place would be the console pretending it does
  // not know what it just did.
  const report = describeIngest(job.data ?? { status: 'queued', proposal_id: null, error: null })
  const status = job.data?.status ?? 'queued'
  const settled = isTerminalStatus(status)
  const state = STATUS_STATE[status] ?? 'unknown'

  return (
    <div
      className="border-border bg-card flex flex-col gap-2 rounded-lg border p-3"
      data-testid={`ingest-job-${id}`}
      data-status={status}
    >
      <div className="flex flex-wrap items-center gap-2">
        {settled ? null : <Spinner className="text-muted-foreground shrink-0" />}
        <span className="text-sm font-medium">{report.headline}</span>
        {/* The word as well as the colour: a status is never conveyed by tone
            alone (CUI-A11Y-5). */}
        <Badge tone={BADGE_TONE[state]} data-testid={`ingest-status-${id}`}>
          {status.replace('_', ' ')}
        </Badge>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Dismiss this job"
          data-testid={`ingest-dismiss-${id}`}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">{report.detail}</p>
      {report.reviewable ? (
        <Link
          to="/changes"
          data-testid={`ingest-review-${id}`}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          Review the change →
        </Link>
      ) : null}
    </div>
  )
}

const TRANSPORTS: readonly { id: IngestTransport; label: string; hint: string }[] = [
  { id: 'markdown', label: 'Markdown', hint: 'Paste a Markdown document — headings, lists and tables are kept.' },
  { id: 'text', label: 'Plain text', hint: 'Paste anything: a meeting note, an email, a transcript.' },
  { id: 'url', label: 'Link', hint: 'Give a public https:// address and WikiKit fetches and archives the page.' },
]

/**
 * Adding documents.
 *
 * A form dialog and NOT a `Confirm`, which is a deliberate reading of "every
 * consequential mutation goes through Confirm" rather than an omission of it.
 * Confirm exists for a decision that lands somewhere it cannot be taken back
 * from — approving a change publishes knowledge, forgetting a stream changes
 * what the lint report says about live claims. Adding a document lands nowhere:
 * it archives bytes and drafts a change proposal, and that proposal is itself
 * the confirmation step, reviewed by a human before one word of it is visible.
 * Stacking an "are you sure" on top of a dialog the operator opened, filled in
 * and pressed Add on would teach them to click through the dialogs that do
 * matter. What Confirm's `details` would have said is on screen here instead,
 * above the button, before the mutation rather than after it.
 */
function AddDocuments({
  space,
  open,
  onOpenChange,
  onQueued,
}: {
  space: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onQueued: (ingestId: string) => void
}) {
  const [draft, setDraft] = useState<IngestDraft>(EMPTY_INGEST_DRAFT)
  const queryClient = useQueryClient()

  const submit = useMutation({
    mutationFn: () => wk.ingest.submit(space, ingestBody(draft)),
    onSuccess: (result) => {
      // The whole space subtree, by prefix, and that is not laziness. A paged
      // read registers under `keys.sources(space, {before, limit})`, so
      // `keys.sources(space)` — which spells the query slot `null` — is not a
      // prefix of it and would invalidate nothing at all. `keys.space(space)`
      // is the prefix every key in this wiki starts with, which is exactly what
      // the key table was built for; only the queries actually mounted refetch.
      void queryClient.invalidateQueries({ queryKey: keys.space(space) })
      setDraft(EMPTY_INGEST_DRAFT)
      onQueued(result.ingest_id)
    },
  })

  const problem = ingestProblem(draft)
  const transport = TRANSPORTS.find((option) => option.id === draft.transport) ?? TRANSPORTS[0]
  const refusal = submit.error
    ? describeFailure({
        status: submit.error instanceof ApiError ? submit.error.status : null,
        message: submit.error instanceof Error ? submit.error.message : String(submit.error),
        actions: submit.error instanceof ApiError ? submit.error.nextBestActions : [],
      })
    : null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A request in the air is never dismissed: the answer is what closes
        // this, or the operator would be told nothing about an ingest that is
        // already running.
        if (submit.isPending) return
        submit.reset()
        onOpenChange(next)
      }}
    >
      <DialogContent data-testid="add-documents-dialog" closeDisabled={submit.isPending} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add documents</DialogTitle>
          <DialogDescription>
            WikiKit archives what you give it verbatim, quotes it claim by claim into pages, and puts those pages in
            Changes for a human to approve. Nothing becomes visible knowledge here without that approval.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ingest-transport">What are you adding?</Label>
            <Select
              value={draft.transport}
              onValueChange={(value) => setDraft({ ...draft, transport: value as IngestTransport, content: '' })}
            >
              <SelectTrigger id="ingest-transport" className="w-full" data-testid="ingest-transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {TRANSPORTS.map((option) => (
                    <SelectItem key={option.id} value={option.id} data-testid={`ingest-transport-${option.id}`}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{transport?.hint}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="ingest-content">{draft.transport === 'url' ? 'Address' : 'Document'}</Label>
            {draft.transport === 'url' ? (
              <Input
                id="ingest-content"
                data-testid="ingest-content"
                type="url"
                inputMode="url"
                placeholder="https://example.com/handbook"
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
            ) : (
              <Textarea
                id="ingest-content"
                data-testid="ingest-content"
                rows={8}
                className="max-h-64 font-mono text-xs"
                placeholder="Paste the document here."
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="ingest-title">Title (optional)</Label>
            <Input
              id="ingest-title"
              data-testid="ingest-title"
              value={draft.title}
              placeholder={draft.transport === 'url' ? "The page's own title, if you leave this empty" : 'Untitled'}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </div>

          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="ingest-kind">What is it? (optional)</Label>
              <Select
                value={draft.sourceKind || 'unstated'}
                onValueChange={(value) =>
                  setDraft({ ...draft, sourceKind: value === 'unstated' ? '' : (value as IngestDraft['sourceKind']) })
                }
              >
                <SelectTrigger id="ingest-kind" className="w-full" data-testid="ingest-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="unstated" data-testid="ingest-kind-unstated">
                      Not stated
                    </SelectItem>
                    <SelectItem value="meeting" data-testid="ingest-kind-meeting">
                      Meeting
                    </SelectItem>
                    <SelectItem value="article" data-testid="ingest-kind-article">
                      Article
                    </SelectItem>
                    <SelectItem value="note" data-testid="ingest-kind-note">
                      Note
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              {/* Said out loud because it is the only field here that changes
                  what synthesis DOES: a meeting is read for explicit decision
                  statements, and the decision log is fed from them. */}
              <p className="text-muted-foreground text-xs">A meeting is also read for the decisions it records.</p>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="ingest-language">Language (optional)</Label>
              <Select
                value={draft.language || 'space'}
                onValueChange={(value) =>
                  setDraft({ ...draft, language: value === 'space' ? '' : (value as IngestDraft['language']) })
                }
              >
                <SelectTrigger id="ingest-language" className="w-full" data-testid="ingest-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="space" data-testid="ingest-language-space">
                      This wiki's language
                    </SelectItem>
                    <SelectItem value="en" data-testid="ingest-language-en">
                      English
                    </SelectItem>
                    <SelectItem value="de" data-testid="ingest-language-de">
                      German
                    </SelectItem>
                    <SelectItem value="simple" data-testid="ingest-language-simple">
                      Unstemmed
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">Only for a document that is not in the wiki's language.</p>
            </div>
          </div>

          {refusal ? (
            <Alert tone={refusal.tone} title={refusal.title} actions={refusal.actions} data-testid="ingest-refusal">
              {refusal.message}
            </Alert>
          ) : null}
        </div>

        <DialogFooter data-testid="add-documents-footer">
          <Button
            variant="outline"
            data-testid="ingest-cancel"
            disabled={submit.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <DisabledReason reason={problem}>
            {/* The label never changes while the request is in the air
                (CUI-ACT-5): a spinner beside "Add documents" is what says it is
                working, and the promise the button made stays on it. */}
            <Button
              data-testid="ingest-submit"
              disabled={problem !== null || submit.isPending}
              aria-busy={submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? <Spinner data-icon="inline-start" /> : null}
              Add documents
            </Button>
          </DisabledReason>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
