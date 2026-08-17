import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Archive, Plus, Radio, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { SectionHeading } from '@/components/context-help'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import { RelativeTime } from '@/components/ui/relative-time'
import { useTableView } from '@/hooks/use-table-view'
import { firstPage, type CursorPage } from '@/lib/cursor'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { semanticLabel } from '@/lib/presentation'
import { STREAM_CAP_NOTE, STREAM_CEILING, sourceLabel } from '@/pages/sources.logic'

/**
 * The evidence, once it is in.
 *
 * Sources are the floor the whole product stands on: a concept page may not
 * assert anything that is not quoted verbatim from one of these rows. So this
 * page is two lists and nothing else — what is archived, and which connectors
 * are feeding it.
 *
 * The way in used to be here as well, as a dialog. It moved to the Inbox, and
 * that is a decision rather than a tidy-up: a document being added and a
 * document already archived are different questions asked by people in
 * different moods, and answering both on one page meant the wiki grew through
 * a modal on the ARCHIVE. What is left here is read-only by nature — an
 * editable source would be a knowledge base whose citations can be made true
 * after the fact, which is the one thing WikiKit exists to prevent.
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
    className: 'max-w-64 whitespace-normal',
    cell: (row, index) => (
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          to="/sources/$id"
          params={{ id: row.id }}
          data-testid={`sources-row-${index + 1}-open`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {sourceLabel(row)}
        </Link>
        <span className="line-clamp-2 text-xs text-muted-foreground">{row.summary}</span>
      </div>
    ),
  },
  {
    id: 'kind',
    label: 'Kind',
    priority: 'secondary',
    // A kind is not a status — it is what the bytes are, and nothing about it
    // is good or bad news. `neutral` is the only honest tone; a `url` source
    // wearing `accent` would read as though the console had an opinion about
    // where evidence should come from.
    cell: (row) => <Badge tone="neutral">{KIND_WORDS[row.kind] ?? row.kind}</Badge>,
  },
  {
    id: 'archived',
    label: 'Archived',
    priority: 'secondary',
    cell: (row) => <RelativeTime value={row.created_at} />,
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
    priority: 'secondary',
    // The first twelve characters of a sha256, which is what the eye compares.
    // The whole 64 and a copy control live on the source page: a copy button in
    // every row of every page is 25 tab stops for a value nobody copies 25 of.
    cell: (row) => <code className="text-muted-foreground font-mono text-xs">{row.content_hash.slice(0, 12)}</code>,
  },
]

export function SourcesPage() {
  const space = useSpace()
  const can = useCan()
  const queryClient = useQueryClient()

  const [page, setPage] = useState<CursorPage>(firstPage)
  const [streamPage, setStreamPage] = useState<CursorPage>(firstPage)

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
        className: 'max-w-56 whitespace-normal',
        cell: (row, index) => (
          <span className="font-mono text-xs break-all" data-testid={`streams-row-${index + 1}-document`}>
            {semanticLabel([row.external_source_id], 'Connector document')}
          </span>
        ),
      },
      {
        id: 'version',
        label: 'Version',
        priority: 'secondary',
        cell: (row) => <span className="text-muted-foreground text-xs">{row.latest_version ?? '—'}</span>,
      },
      {
        id: 'seen',
        label: 'Last seen',
        priority: 'secondary',
        cell: (row, index) => (
          <RelativeTime value={row.latest_observed_at} data-testid={`streams-row-${index + 1}-seen`} />
        ),
      },
      {
        id: 'head',
        label: 'Current version',
        priority: 'secondary',
        cell: (row, index) =>
          row.latest_source_id ? (
            <Link
              to="/sources/$id"
              params={{ id: row.latest_source_id }}
              data-testid={`streams-row-${index + 1}-open`}
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
        cell: (row, index) => (
          <ForgetStream
            stream={row}
            allowed={mayAdd}
            testId={`streams-row-${index + 1}-forget`}
            onForget={forget.mutateAsync}
          />
        ),
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
        // A LINK, not a button: adding a document happens in the Inbox now, and
        // this page is what the archive holds afterwards. The form used to open
        // here as a dialog, which put "what is in the archive" and "what is on
        // its way into it" on one screen and neither of them anywhere else.
        <Button asChild>
          <Link to="/inbox" search={(prev) => prev} data-testid="sources-open-inbox">
            <Plus data-icon="inline-start" />
            Add documents
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-3" aria-labelledby="sources-heading">
          <h2 id="sources-heading" className="text-sm font-semibold">
            Archive
          </h2>
          <DataTable
            testId="sources"
            columns={SOURCE_COLUMNS}
            rows={sourcesQuery.data?.items ?? []}
            rowKey={(row) => row.id}
            rowTestId={(_row, index) => `sources-row-${index + 1}`}
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
                description="Add a document to archive evidence and draft reviewable pages."
                data-testid="sources-empty-state"
              />
            }
          />
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="streams-heading">
          <SectionHeading
            id="streams-heading"
            helpTitle="About connector streams"
            help={
              <p>
                One stream is one upstream document that a connector keeps in step — each push archives a new version
                and moves the stream's head.
              </p>
            }
            testId="sources-streams-help"
          >
            Connector streams
          </SectionHeading>
          <DataTable
            testId="streams"
            columns={streamColumns}
            rows={streamsQuery.data?.items ?? []}
            rowKey={(row) => row.id}
            rowTestId={(_row, index) => `streams-row-${index + 1}`}
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
                description="Connector-pushed documents appear here with their current version."
                data-testid="streams-empty-state"
              />
            }
          />
        </section>
      </div>
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
  testId,
  onForget,
}: {
  stream: SourceStream
  allowed: boolean
  testId: string
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
        <DisabledReason
          reason={allowed ? null : 'Needs knowledge:propose'}
          label={`Forget ${stream.external_source_id}`}
          data-testid={`${testId}-tooltip`}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Forget ${stream.external_source_id}`}
            data-testid={testId}
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
