import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DataState } from '@/components/data-state'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { RelativeTime } from '@/components/ui/relative-time'
import { Skeleton } from '@/components/ui/skeleton'
import { useSpace } from '@/lib/space'
import { STATUS_STATE, type DomainState } from '@/lib/tokens'
import { isUuidLike, presentValue, semanticLabel } from '@/lib/presentation'

/**
 * One decision, read as a document.
 *
 * A decision is prose, not a record: the context, what was decided, why, and
 * what was turned down. Rendering it as a form of four labelled fields would be
 * the same mistake as rendering a concept page as a form — so it is a document,
 * in `wk-doc`, with the four parts as headings a reader can scan.
 *
 * The shape is `zDecisionResponse`: slug, title, status, created_at, context,
 * decision, rationale, alternatives[], agent_meta. There is no `markdown` field
 * and no `body` — the three prose fields ARE the document. They are rendered
 * through `react-markdown` because the synthesizer writes prose with lists and
 * emphasis in it, and plain text renders identically through the same pipe. No
 * `rehype-raw`: nothing in this base is trusted HTML.
 */
type Decision = Awaited<ReturnType<typeof wk.decisions.get>>

/**
 * Restated rather than shared with `pages/decisions.tsx` on purpose: a page
 * module exports exactly one page component (CUI-PAGE-2), so exporting this from
 * the list page would be the wrong home for it — and a five-line table is a
 * cheaper duplicate than a shared module nobody owns.
 *
 * `superseded` is `unknown`, never `danger`. A decision this wiki later revised
 * is history; the log exists precisely to keep it readable.
 */
const BADGE_TONE: Record<DomainState, NonNullable<BadgeProps['tone']>> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
}

const STATUS_WORD: Record<string, string> = {
  active: 'In force',
  superseded: 'Superseded',
}

export function DecisionPage() {
  const space = useSpace()
  // `strict: false` because no route in router.tsx declares a params schema —
  // the same escape hatch `useTableView` documents for search parameters.
  const params = useParams({ strict: false }) as { slug?: string }
  const slug = params.slug ?? ''

  const query = useQuery({
    queryKey: keys.decision(space, slug),
    queryFn: () => wk.decisions.get(space, slug),
  })

  // The title is the decision's own once it has arrived, and the slug until
  // then. A frame that says "Decision" while the document loads and then
  // renames itself is a heading that moves under the reader's eyes; the slug is
  // what they clicked and it is already true.
  const title = semanticLabel([query.data?.title, slug], 'Decision')

  return (
    <Page title={title} description="A decision this wiki recorded: what was decided, why, and what was turned down.">
      <DataState testId="decision-document" query={query} skeleton={<DocumentSkeleton />}>
        {(decision) => <DecisionDocument decision={decision} />}
      </DataState>
    </Page>
  )
}

function DecisionDocument({ decision }: { decision: Decision }) {
  const state = STATUS_STATE[decision.status] ?? 'unknown'
  const replacedBy = namedSlugs(decision.agent_meta, 'superseded_by')
  const replaces = namedSlugs(decision.agent_meta, 'supersedes')

  return (
    <article className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={BADGE_TONE[state]} data-testid="decision-status">
          {STATUS_WORD[decision.status] ?? decision.status}
        </Badge>
        <span className="text-muted-foreground text-xs">
          Recorded <RelativeTime value={decision.created_at} data-testid="decision-recorded" />
        </span>
        {!isUuidLike(decision.slug) ? (
          <span className="text-muted-foreground font-mono text-xs" data-testid="decision-slug">
            {decision.slug}
          </span>
        ) : null}
      </div>

      <Supersession status={decision.status} replacedBy={replacedBy} replaces={replaces} />

      <Section id="context" title="Context" body={decision.context} />
      <Section id="decision" title="The decision" body={decision.decision} />
      <Section id="rationale" title="Why" body={decision.rationale} />
      <Alternatives entries={decision.alternatives} />
      <Provenance meta={decision.agent_meta} />
    </article>
  )
}

/**
 * What replaced this decision, or what it replaced.
 *
 * THE SCHEMA DOES NOT CARRY THIS EDGE. `wk_decisions` has a status and no
 * successor column, and `zDecisionResponse` has no `superseded_by` — the only
 * place a supersession can be named is the free-form `agent_meta` the proposal
 * stamped. So this reads that, links what it finds, and — when it finds nothing
 * — says plainly that the record names no successor rather than inventing a
 * link or, worse, leaving a superseded decision looking merely stale.
 *
 * Deliberately not an `<Alert>`: `Alert` is `role="alert"`, an assertive live
 * region, and being superseded is not an alarm. It is the ordinary end of a
 * decision's life and reads as a note.
 */
function Supersession({
  status,
  replacedBy,
  replaces,
}: {
  status: string
  replacedBy: readonly string[]
  replaces: readonly string[]
}) {
  if (status !== 'superseded' && replaces.length === 0) return null
  return (
    <div
      className="border-border bg-muted/40 flex flex-col gap-2 rounded-lg border p-3 text-sm"
      data-testid="decision-supersession"
    >
      {status === 'superseded' ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium">Superseded — kept as history</span>
          {replacedBy.length > 0 ? (
            <span className="text-muted-foreground">
              Replaced by <SlugLinks slugs={replacedBy} testId="decision-replaced-by" />.
            </span>
          ) : (
            <span className="text-muted-foreground">
              This record does not name what replaced it. The{' '}
              <Link to="/decisions" data-testid="decision-back-to-log" className="underline underline-offset-2">
                decision log
              </Link>{' '}
              shows what this wiki decided since.
            </span>
          )}
        </div>
      ) : null}
      {replaces.length > 0 ? (
        <span className="text-muted-foreground">
          Replaces <SlugLinks slugs={replaces} testId="decision-replaces" />.
        </span>
      ) : null}
    </div>
  )
}

function SlugLinks({ slugs, testId }: { slugs: readonly string[]; testId: string }) {
  return (
    <>
      {slugs.map((slug, index) => (
        <span key={slug}>
          {index > 0 ? ', ' : null}
          <Link
            to="/decisions/$slug"
            params={{ slug }}
            data-testid={`${testId}-${slug}`}
            className="font-mono underline underline-offset-2"
          >
            {slug}
          </Link>
        </span>
      ))}
    </>
  )
}

/** One prose part of the document. An empty part is `—`, never a blank space. */
function Section({ id: sectionId, title, body }: { id: string; title: string; body: string }) {
  const text = body.trim()
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`decision-${sectionId}-heading`}>
      <h2 id={`decision-${sectionId}-heading`} className="text-sm font-semibold tracking-tight">
        {title}
      </h2>
      {text ? (
        <div className="wk-doc" data-testid={`decision-${sectionId}`}>
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid={`decision-${sectionId}`}>
          —
        </p>
      )}
    </section>
  )
}

/**
 * The options that were considered and not taken — the part of a decision log
 * that stops a wiki from re-litigating the same question every quarter.
 *
 * The wire type is `unknown[]`, and that is not laziness in the schema: the
 * synthesizer writes plain strings, while a decision imported from an export can
 * carry a structured object. So a string is rendered as prose and anything else
 * is printed as the JSON it is, rather than as `[object Object]`.
 */
function Alternatives({ entries }: { entries: readonly unknown[] }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="decision-alternatives-heading">
      <h2 id="decision-alternatives-heading" className="text-sm font-semibold tracking-tight">
        Alternatives turned down
      </h2>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="decision-alternatives">
          This record names none.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="decision-alternatives">
          {entries.map((entry, index) => (
            <li key={index} className="border-border rounded-lg border p-3 text-sm">
              {typeof entry === 'string' ? (
                <div className="wk-doc">
                  <Markdown remarkPlugins={[remarkGfm]}>{entry}</Markdown>
                </div>
              ) : (
                <pre className="scrollbar-thin overflow-x-auto font-mono text-xs">
                  {JSON.stringify(presentValue(entry), null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Who wrote this decision down.
 *
 * `agent_meta` is free-form by design — it is the provenance stamp the proposal
 * carried, which for a synthesized decision names the model and the prompt
 * version and for a hand-written one says `manual`. It is printed as it stands,
 * because provenance rewritten into friendlier words is provenance nobody can
 * check, and omitted entirely when there is none.
 */
function Provenance({ meta }: { meta: Record<string, unknown> }) {
  const entries = Object.entries(presentValue(meta) as Record<string, unknown>)
  if (entries.length === 0) return null
  return (
    <section className="flex flex-col gap-2" aria-labelledby="decision-provenance-heading">
      <h2 id="decision-provenance-heading" className="text-sm font-semibold tracking-tight">
        Provenance
      </h2>
      <dl
        className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]"
        data-testid="decision-provenance"
      >
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-wrap gap-2 sm:contents">
            <dt className="text-muted-foreground font-mono">{key}</dt>
            <dd className="font-mono break-all">{scalar(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** Loading is the shape of the document that is coming, never the word "Loading". */
function DocumentSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="flex gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-32" />
      </div>
      {[0, 1, 2].map((section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  )
}

/**
 * Slugs a free-form provenance stamp names under a key, read defensively.
 *
 * Pure, and deliberately narrow: a string is one slug, an array contributes its
 * strings, and anything else contributes nothing. A supersession the console
 * cannot read is a supersession it does not draw — the alternative is a link to
 * `/decisions/[object Object]`.
 */
function namedSlugs(meta: Record<string, unknown>, key: string): string[] {
  const value = meta[key]
  if (typeof value === 'string') return value ? [value] : []
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return []
}

/** A provenance value as one line. An absent value is `—`, never an empty cell. */
function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value || '—'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(presentValue(value))
}
