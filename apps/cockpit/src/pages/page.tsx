import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { PencilLine, Trash2 } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DataState } from '@/components/data-state'
import { Confirm } from '@/components/confirm'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RelativeTime } from '@/components/ui/relative-time'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabPanel, type TabDefinition } from '@/components/ui/tabs'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  claimSentence,
  evidenceOf,
  evidenceSummary,
  neighborGroups,
  neighborhoodEmpty,
  sharedSourcesLabel,
  statusBadge,
  type NeighborRelation,
} from '@/pages/page.logic'

/**
 * One page of the wiki, read as a document.
 *
 * The markdown is rendered, not shown as a field in a form, because a concept IS
 * a document — that is the promise the product makes and the reason `wk-doc`
 * exists. Under it sits the thing that makes this a knowledge base rather than a
 * notes app: every claim the page makes, with the VERBATIM QUOTE that backs it.
 *
 * The quotes are behind a `<details>` and not behind a click that fetches
 * something. They arrive with the concept read, so opening one is instant and
 * costs nothing, and a reader auditing a page can open all of them. What is NOT
 * negotiable is that a claim with no quote looks different from a claim with
 * three: an uncited claim is the defect this whole review pipeline exists to
 * prevent, so it wears the destructive frame and says out loud that nobody can
 * check it. Rendering it as a plain row would let the page look evidenced while
 * being nothing of the kind.
 *
 * No `rehype-raw`. A concept's markdown is synthesized from source documents the
 * console did not write, and HTML passthrough would make an archived web page
 * able to inject markup into the console that reviews it.
 */

const TAB_LIST = 'page'

/**
 * The open panel is an ADDRESS, not component state.
 *
 * "Look at this page's history" has to be a link somebody can send, and Back has
 * to undo the switch. There is no route for a panel — the router names
 * `/pages/$slug` and nothing under it — so the choice lives in the search
 * parameters, which is the same place this console keeps every other view
 * decision, and `useUrlFilters` is what already reads and writes those with a
 * closed alphabet.
 */
const TAB_FILTER = [{ key: 'tab', values: ['document', 'history'], fallback: 'document' }] as const

type PanelId = 'document' | 'history'

const TABS: readonly TabDefinition<PanelId>[] = [
  { id: 'document', label: 'Page' },
  { id: 'history', label: 'History' },
]

/** `?space=` is the address of the wiki; a link that drops it changes the subject. */
const KEEP_SEARCH = (previous: { space?: string }) => previous

export function PageDetailPage() {
  const space = useSpace()
  const can = useCan()
  const canPropose = can('knowledge:propose')
  const client = useQueryClient()
  const navigate = useNavigate()

  // `strict: false` because no route declares a params schema; the slug is a
  // string or the route did not match at all.
  const params = useParams({ strict: false })
  const slug = typeof params.slug === 'string' ? params.slug : ''

  const { filters, setFilters } = useUrlFilters(TAB_LIST, TAB_FILTER)
  const tab: PanelId = filters.tab === 'history' ? 'history' : 'document'

  const concept = useQuery({
    queryKey: keys.concept(space, slug),
    queryFn: () => wk.concepts.get(space, slug),
    enabled: slug !== '',
  })

  // The history is asked for when it is looked at. It is a second read of the
  // same page and most visits never open it, so paying for it on every page
  // open would double the cost of browsing to save one click for a minority.
  const history = useQuery({
    queryKey: keys.conceptHistory(space, slug),
    queryFn: () => wk.concepts.history(space, slug),
    enabled: slug !== '' && tab === 'history',
  })

  const title = concept.data?.title ?? slug
  const remove = useMutation({
    mutationFn: () => wk.concepts.remove(space, slug),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: keys.space(space) })
      toast({
        tone: 'success',
        title: 'Deletion submitted for review',
        detail: 'The page stays visible until a reviewer approves the change.',
      })
      void navigate({ to: '/changes/$id', params: { id: result.proposal_id }, search: KEEP_SEARCH })
    },
  })

  return (
    <Page
      title={title}
      description="What this wiki knows on this subject, with the quote behind every claim it makes."
      actions={
        canPropose ? (
          <div className="flex gap-2">
            <Button asChild>
              <Link to="/pages/$slug/edit" params={{ slug }} search={KEEP_SEARCH} data-testid="page-edit">
                <PencilLine data-icon="inline-start" />
                Edit
              </Link>
            </Button>
            <Confirm
              title="Delete this page"
              description="This submits a deletion for review. History and evidence remain retained."
              confirmLabel="Submit deletion"
              destructive
              onConfirm={() => remove.mutateAsync()}
            >
              {(open) => (
                <Button variant="destructive" data-testid="page-delete" onClick={open}>
                  <Trash2 data-icon="inline-start" />
                  Delete
                </Button>
              )}
            </Confirm>
          </div>
        ) : (
          <DisabledReason reason="Needs knowledge:propose — editing a page means submitting a change for review.">
            <Button disabled data-testid="page-edit">
              <PencilLine data-icon="inline-start" />
              Edit
            </Button>
          </DisabledReason>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <Tabs
          tabs={TABS}
          value={tab}
          onValueChange={(next) => setFilters({ tab: next })}
          group={TAB_LIST}
          data-testid="page-tabs"
        />

        <TabPanel active={tab === 'document'} group={TAB_LIST} id="document">
          <DataState testId="page-document" query={concept} skeleton={<DocumentSkeleton />}>
            {(data) => (
              <div className="flex flex-col gap-8">
                <div className="flex flex-col gap-3">
                  {data.summary ? (
                    <p data-testid="page-summary" className="text-muted-foreground text-sm">
                      {data.summary}
                    </p>
                  ) : null}
                  {data.markdown.trim() ? (
                    <article className="wk-doc" data-testid="page-document">
                      <Markdown remarkPlugins={[remarkGfm]}>{data.markdown}</Markdown>
                    </article>
                  ) : (
                    <EmptyState
                      title="This page has no text"
                      description="Its revision carries claims but no prose. Editing it submits a change that gives it a document."
                      data-testid="page-document-empty"
                    />
                  )}
                </div>

                <ClaimsPanel claims={data.claims} />

                <NeighborsPanel space={space} slug={slug} />

                <p className="text-muted-foreground text-xs">
                  Revision {data.rev}, last changed <RelativeTime value={data.updated_at} data-testid="page-updated" />.
                </p>
              </div>
            )}
          </DataState>
        </TabPanel>

        <TabPanel active={tab === 'history'} group={TAB_LIST} id="history">
          <DataState
            testId="page-history"
            query={history}
            skeleton={<HistorySkeleton />}
            isEmpty={(data) => data.revisions.length === 0}
            empty={
              <EmptyState
                title="No revisions recorded"
                description="No approved change has written a revision for this page yet."
                data-testid="page-history-empty"
              />
            }
          >
            {(data) => <RevisionList revisions={data.revisions} />}
          </DataState>
        </TabPanel>
      </div>
    </Page>
  )
}

/* ----------------------------------------------------------------- the claims */

type Claim = {
  id: string
  subject: string
  predicate: string
  object: string
  status: string
  confidence: number
  citations: readonly { source_id: string; quote: string; locator: string }[]
}

function ClaimsPanel({ claims }: { claims: readonly Claim[] }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="page-claims-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="page-claims-heading" className="text-sm font-semibold tracking-tight">
          Claims
        </h2>
        <p data-testid="page-claims-summary" className="text-muted-foreground text-xs">
          {evidenceSummary(claims)}
        </p>
      </div>
      {claims.length === 0 ? (
        <EmptyState
          title="No claims yet"
          description="Ingest a source to add quoted, reviewable claims to this page."
          data-testid="page-claims-empty"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {claims.map((claim, index) => (
            <ClaimRow key={claim.id} claim={claim} index={index} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ClaimRow({ claim, index: claimIndex }: { claim: Claim; index: number }) {
  const evidence = evidenceOf(claim.citations.length)
  const status = statusBadge(claim.status)
  return (
    <li
      data-testid={`page-claim-${claimIndex + 1}`}
      data-cited={evidence.cited ? 'yes' : 'no'}
      // The frame is the difference a reader sees before they read anything, and
      // it is never the only signal: the badge beside it says "No quote" in
      // words, because colour alone conveys nothing to a reader who cannot see
      // it (CUI-A11Y-5).
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-3',
        evidence.cited ? 'border-border' : 'border-destructive/40 bg-destructive/5',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 text-sm">{claimSentence(claim)}</p>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Badge tone={status.tone}>{status.label}</Badge>
          <Badge tone={evidence.tone} data-testid={`page-claim-${claimIndex + 1}-evidence`}>
            {evidence.label}
          </Badge>
        </div>
      </div>

      {evidence.cited ? (
        <details data-testid={`page-claim-${claimIndex + 1}-quotes`}>
          <summary className="focus-visible:ring-ring cursor-pointer rounded text-xs text-muted-foreground focus-visible:ring-2 focus-visible:outline-none">
            Read the {evidence.label.toLowerCase()}
          </summary>
          <ul className="mt-2 flex flex-col gap-3">
            {claim.citations.map((citation, index) => (
              <li key={`${citation.source_id}-${index}`} className="border-border flex flex-col gap-1 border-l-2 pl-3">
                {/* The quote is archived text, printed exactly as it was
                    archived. It wraps and it is never truncated: a quote cut
                    off in the middle is no longer evidence of anything. */}
                <blockquote className="text-sm break-words whitespace-pre-wrap italic">{citation.quote}</blockquote>
                <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                  <Link
                    to="/sources/$id"
                    params={{ id: citation.source_id }}
                    search={KEEP_SEARCH}
                    data-testid={`page-claim-${claimIndex + 1}-source-${index + 1}`}
                    className="underline underline-offset-2"
                  >
                    The source this is quoted from
                  </Link>
                  {citation.locator ? <span className="font-mono">{citation.locator}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="text-destructive text-xs">
          Nothing in the archive is quoted for this claim, so nobody can check it.
        </p>
      )}

      {Number.isFinite(claim.confidence) ? (
        <p className="text-muted-foreground text-xs">Stated with confidence {claim.confidence.toFixed(2)}.</p>
      ) : null}
    </li>
  )
}

/* ------------------------------------------------------------ the neighborhood */

/**
 * The pages around this one, from its own read: relations both directions
 * (incoming is the backlink surface the concept response never carried) and
 * the pages quoting the same archived sources, where the shared count is the
 * whole argument for the suggestion.
 *
 * Its own query and its own DataState on purpose — the neighborhood is a
 * second, heavier read, and a slow or failing one must never blank the
 * document above it. An empty neighborhood renders as a statement, not as a
 * panel that silently is not there.
 */
function NeighborsPanel({ space, slug }: { space: string; slug: string }) {
  const neighbors = useQuery({
    queryKey: keys.conceptNeighbors(space, slug),
    queryFn: () => wk.concepts.neighbors(space, slug),
    enabled: slug !== '',
  })
  return (
    <section className="flex flex-col gap-3" aria-labelledby="page-neighbors-heading">
      <h2 id="page-neighbors-heading" className="text-sm font-semibold tracking-tight">
        Related pages
      </h2>
      <DataState
        testId="page-neighbors"
        query={neighbors}
        skeleton={<NeighborsSkeleton />}
        isEmpty={neighborhoodEmpty}
        empty={
          <EmptyState
            title="No neighbors yet"
            description="No reviewed relation touches this page, and no other page quotes the sources it quotes."
            data-testid="page-neighbors-empty"
          />
        }
      >
        {(data) => {
          const groups = neighborGroups(data.relations)
          return (
            <div className="flex flex-col gap-4">
              {groups.outgoing.length > 0 ? (
                <NeighborGroup group="out" label="Outgoing">
                  {groups.outgoing.map((relation) => (
                    <NeighborChip
                      key={`${relation.space ?? ''}:${relation.slug}:${relation.kind}`}
                      group="out"
                      relation={relation}
                    />
                  ))}
                </NeighborGroup>
              ) : null}
              {groups.incoming.length > 0 ? (
                <NeighborGroup group="in" label="Incoming">
                  {groups.incoming.map((relation) => (
                    <NeighborChip key={`${relation.slug}:${relation.kind}`} group="in" relation={relation} />
                  ))}
                </NeighborGroup>
              ) : null}
              {data.same_source.length > 0 ? (
                <NeighborGroup group="sources" label="Same sources">
                  {data.same_source.map((sibling) => (
                    <li
                      key={sibling.slug}
                      className="border-border flex items-center gap-2 rounded-lg border px-2 py-1 text-xs"
                    >
                      <Link
                        to="/pages/$slug"
                        params={{ slug: sibling.slug }}
                        search={KEEP_SEARCH}
                        data-testid={`page-neighbor-sources-${sibling.slug}`}
                        className="underline underline-offset-2"
                      >
                        {sibling.title}
                      </Link>
                      {/* The ranking, said out loud: why THIS page is suggested. */}
                      <span className="text-muted-foreground">{sharedSourcesLabel(sibling.shared_sources)}</span>
                    </li>
                  ))}
                </NeighborGroup>
              ) : null}
            </div>
          )
        }}
      </DataState>
    </section>
  )
}

function NeighborGroup({ group, label, children }: { group: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 id={`page-neighbors-${group}-heading`} className="text-muted-foreground text-xs font-medium tracking-tight">
        {label}
      </h3>
      <ul
        className="flex flex-wrap gap-2"
        aria-labelledby={`page-neighbors-${group}-heading`}
        data-testid={`page-neighbors-${group}`}
      >
        {children}
      </ul>
    </div>
  )
}

function NeighborChip({ group, relation }: { group: string; relation: NeighborRelation }) {
  return (
    <li className="border-border flex items-center gap-2 rounded-lg border px-2 py-1 text-xs">
      <span className="text-muted-foreground">{relation.kind.replace(/_/g, ' ')}</span>
      {/* A relation into another wiki names a page this console cannot
          address from here — `/pages/$slug` is scoped to the wiki in the
          URL — so it is printed with its wiki rather than linked to a
          page that would resolve to the wrong one. */}
      {relation.space ? (
        <span className="font-mono">
          {relation.space}:{relation.slug}
        </span>
      ) : (
        <Link
          to="/pages/$slug"
          params={{ slug: relation.slug }}
          search={KEEP_SEARCH}
          data-testid={`page-neighbor-${group}-${relation.slug}`}
          className="font-mono underline underline-offset-2"
        >
          {relation.slug}
        </Link>
      )}
    </li>
  )
}

function NeighborsSkeleton() {
  return (
    <div className="flex flex-wrap gap-2" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-6 w-36" />
    </div>
  )
}

/* --------------------------------------------------------------- the history */

type Revision = {
  id: string
  rev: number
  status: string
  title: string
  summary: string
  proposal_id: string | null
  agent_meta: Record<string, unknown>
  created_at: string
}

function RevisionList({ revisions }: { revisions: readonly Revision[] }) {
  // Newest first: a history is read backwards from what is true now. The
  // endpoint's own order is not relied on, because "which revision is current"
  // is a question the reader asks before any other.
  const ordered = [...revisions].sort((left, right) => right.rev - left.rev)
  return (
    <ol className="flex flex-col gap-2" data-testid="page-history">
      {ordered.map((revision) => {
        const status = statusBadge(revision.status)
        const model = typeof revision.agent_meta.model === 'string' ? revision.agent_meta.model : null
        return (
          <li
            key={revision.id}
            data-testid={`page-history-${revision.rev}`}
            className="border-border flex flex-col gap-1 rounded-lg border p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">
                Revision {revision.rev} — {revision.title}
              </span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            {revision.summary ? <p className="text-muted-foreground text-sm">{revision.summary}</p> : null}
            <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
              <RelativeTime value={revision.created_at} data-testid={`page-history-${revision.rev}-at`} />
              {/* Provenance, where the server recorded any. A revision written
                  by a model and one typed by a person are different facts about
                  how much a reader should trust it before the quotes are read. */}
              {model ? <span data-testid={`page-history-${revision.rev}-model`}>{model}</span> : null}
              {revision.proposal_id ? (
                <Link
                  to="/changes/$id"
                  params={{ id: revision.proposal_id }}
                  search={KEEP_SEARCH}
                  data-testid={`page-history-${revision.rev}-change`}
                  className="underline underline-offset-2"
                >
                  The change that made it
                </Link>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* -------------------------------------------------------------- the skeletons */

/** A document's shape: a paragraph, a heading, more paragraph — never a spinner. */
function DocumentSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="mt-4 h-5 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}

function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((row) => (
        <div key={row} className="border-border flex flex-col gap-2 rounded-lg border p-3">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  )
}
