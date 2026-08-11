import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ExternalLink, Search, SearchX, Sparkles } from 'lucide-react'
import { useMemo, type FormEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ApiError } from '@/api/client'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { SegmentedControl } from '@/components/controls'
import { SectionHeading } from '@/components/context-help'
import { DataState } from '@/components/data-state'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { EmptyState } from '@/components/empty-state'
import { I18nText } from '@/components/i18n-text'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/spinner'
import { describeFailure } from '@/lib/failure'
import { useSpace } from '@/lib/space'
import { semanticLabel } from '@/lib/presentation'
import type { FilterSpec } from '@/lib/url-filters'
import { rendersAsDash, type EvidenceCounts, type NotMeasured } from '@/pages/page.logic'
import { RESULT_LIMIT, hitEvidence, resultCeilingNote } from '@/pages/search.logic'

/**
 * Search, in two tiers — and the tier is the whole point.
 *
 * `GET /v1/spaces/{space}/search` answers hits labelled `tier: 'approved' |
 * 'source_evidence'`. An approved hit is knowledge: a human reviewed the change
 * that published it, and every claim on the page it belongs to carries a
 * verbatim quote from an archived source. A `source_evidence` hit is a line
 * somebody's document happened to contain. **Nobody has approved it, nothing
 * vouches for it, and it must never be dressed in a token that means verified.**
 * The two tiers are therefore two sections with two headings, the second one
 * saying in words what it is, and the second one wearing the `unknown` badge —
 * dashed and muted, visibly present and visibly not a verdict.
 *
 * The server ranks the tiers independently and never interleaves them (ts_rank
 * across two corpora is not comparable), so this page never re-sorts hits: the
 * order on screen is the order the server ranked, and the only rearranging is
 * the split into the two sections it already labelled.
 *
 * A hit on a page now also says HOW THE WIKI KNOWS IT — the claims that page
 * makes, how many of them quote nothing, and how many sources stand behind it —
 * because a ranked list is a choice about what to open, and rank answers "does
 * this mention my words" while evidence answers "is any of it backed". The
 * three numbers are read by `pageEvidence` in `page.logic`, the same function
 * the pages index reads them with; `hitEvidence` in `search.logic` decides only
 * which hits are pages at all. Nothing about the evidence line ever appears on a
 * `source_evidence` hit: the counts describe an approved page, and a screen that
 * let an unreviewed excerpt wear them would have undone the split above.
 */

/**
 * `evidence` is widened onto the generated hit rather than waited for.
 *
 * The response type is generated from the OpenAPI document, so a field lands
 * here the moment the schema declares it — but optional-and-nullable is what
 * this console can actually receive either way, and the reason is in
 * `EvidenceBearingHit`: a rolling upgrade serves one tab from the new binary and
 * answers its next search from the old one. The intersection collapses to the
 * server's own required shape as soon as the generated type carries it.
 */
type SearchHit = Awaited<ReturnType<typeof wk.search.run>>['hits'][number] & {
  evidence?: EvidenceCounts | null
  not_measured?: NotMeasured | null
}

/** `zSearchQuery`: `q` is 1–500 chars. `RESULT_LIMIT` and its ceiling note live in `search.logic.ts`. */
const MAX_QUERY = 500
/** `zQueryRequest.top_k` — how many pages the answer is allowed to lean on. */
const ANSWER_TOP_K = 8

type KindChoice = 'all' | 'concept' | 'claim'
type ModeChoice = 'approved_only' | 'approved_then_sources'

const KIND_OPTIONS: readonly { id: KindChoice; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'concept', label: 'Pages' },
  { id: 'claim', label: 'Claims' },
]

const MODE_OPTIONS: readonly { id: ModeChoice; label: string }[] = [
  { id: 'approved_only', label: 'Approved only' },
  { id: 'approved_then_sources', label: 'Also archived sources' },
]

/**
 * `mode` and `kind` are closed alphabets the server declares, so they go through
 * the URL-filter machinery; `approved_only` is the server's own default and is
 * therefore the neutral value that is never written to the address.
 */
const FILTERS: readonly FilterSpec[] = [
  { key: 'kind', values: ['concept', 'claim'], fallback: 'all' },
  { key: 'mode', values: ['approved_then_sources'], fallback: 'approved_only' },
]

export function SearchPage() {
  const space = useSpace()
  const navigate = useNavigate()
  // `strict: false`: no route in router.tsx declares a search schema, so this is
  // how a page reads a parameter the router does not know about — the same
  // escape hatch `useTableView` and `useUrlFilters` use.
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const q = typeof search.q === 'string' ? search.q.trim().slice(0, MAX_QUERY) : ''

  const { filters, setFilters } = useUrlFilters('search', FILTERS)
  const kind = (filters.kind ?? 'all') as KindChoice
  const mode = (filters.mode ?? 'approved_only') as ModeChoice

  const params = useMemo(() => ({ q, limit: RESULT_LIMIT, mode, ...(kind === 'all' ? {} : { kind }) }), [q, mode, kind])

  const results = useQuery({
    queryKey: keys.search(space, params),
    queryFn: () => wk.search.run(space, params),
    // A search with no words is not a search. Without this the page would ask
    // the server for the empty string on every first paint and get a 400 for it.
    enabled: q !== '',
  })

  /**
   * The grounded answer, as a MUTATION rather than a query — and that is a
   * deliberate reading of a POST that only reads.
   *
   * `POST /v1/spaces/{space}/query` changes nothing in the knowledge base, so it
   * takes no `Confirm`: there is no effect to restate. What it does spend is
   * model tokens, which is exactly why it must not be a query — a query fires
   * when a link is opened, and a search link pasted into a chat would then bill
   * the deployment for every person who clicked it. A mutation fires when
   * somebody presses the button and never otherwise.
   */
  const ask = useMutation({
    mutationFn: (input: { question: string; mode: ModeChoice }) =>
      wk.search.ask(space, { question: input.question, top_k: ANSWER_TOP_K, mode: input.mode }),
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const typed = String(new FormData(event.currentTarget).get('q') ?? '')
      .trim()
      .slice(0, MAX_QUERY)
    // The query lives in the address so a search can be sent to somebody. An
    // empty box clears it rather than writing `?q=`, which is not a search.
    void navigate({
      to: '.',
      search: ((previous: Record<string, unknown>) => ({ ...previous, q: typed || undefined })) as never,
    })
  }

  return (
    <Page
      title="Search"
      description="Find what this wiki has approved — and, when you ask for it, the archived sources behind it."
    >
      <div className="flex flex-col gap-6">
        <form onSubmit={submit} className="flex flex-col gap-3" data-testid="search-form">
          <div className="flex gap-2">
            {/*
              The address is the truth and the field is only its editor, so the
              field is uncontrolled and re-keyed on `q`. Pressing Back after a
              search then puts the previous words back in the box, which a
              `useState` seeded once from the URL would not — and it takes no
              effect to keep the two in step.
            */}
            <Input
              key={q}
              name="q"
              type="search"
              defaultValue={q}
              maxLength={MAX_QUERY}
              placeholder="A word or a phrase"
              aria-label="Search this wiki"
              data-testid="search-input"
            />
            <Button type="submit" data-testid="search-submit">
              <Search data-icon="inline-start" />
              Search
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <SegmentedControl
              value={kind}
              options={KIND_OPTIONS}
              label="What to search"
              data-testid="search-kind"
              onChange={(next) => setFilters({ kind: next })}
            />
            <SegmentedControl
              value={mode}
              options={MODE_OPTIONS}
              label="Which tiers to search"
              data-testid="search-mode"
              onChange={(next) => setFilters({ mode: next })}
            />
          </div>
        </form>

        {q === '' ? (
          // Not a `DataState` branch: nothing has been asked, so there is no
          // read to be loading, empty or refused. A skeleton here would claim a
          // request is in flight that nobody made.
          <EmptyState
            icon={Search}
            data-testid="search-idle"
            title="Search this wiki"
            description="Search approved knowledge or include archived source evidence."
          />
        ) : (
          <DataState
            testId="search-results"
            query={results}
            skeleton={<ResultsSkeleton />}
            isEmpty={(data) => data.hits.length === 0}
            empty={
              <EmptyState
                icon={SearchX}
                data-testid="search-empty"
                title={`Nothing matches “${q}”`}
                description={
                  mode === 'approved_only'
                    ? 'No approved page or claim contains those words. The archived sources behind this wiki have not been searched.'
                    : 'Neither the approved pages nor the archived sources contain those words.'
                }
                action={
                  mode === 'approved_only' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="search-widen"
                      onClick={() => setFilters({ mode: 'approved_then_sources' })}
                    >
                      Also search archived sources
                    </Button>
                  ) : undefined
                }
              />
            }
          >
            {(data) => <Results hits={data.hits} searched={data.searched_spaces} space={space} />}
          </DataState>
        )}

        <AskPanel
          question={q}
          mode={mode}
          pending={ask.isPending}
          error={ask.error}
          // The answer is shown only while it is still ABOUT the question on
          // screen. The mutation's own variables carry that fact, so editing the
          // query retires the old answer without an effect and without a stale
          // paragraph sitting under a different question.
          answer={
            ask.data !== undefined && ask.variables?.question === q && ask.variables.mode === mode
              ? ask.data
              : undefined
          }
          onAsk={() => ask.mutate({ question: q, mode })}
        />
      </div>
    </Page>
  )
}

function Results({
  hits,
  searched,
  space,
}: {
  hits: readonly SearchHit[]
  searched: readonly string[]
  space: string
}) {
  const approved = hits.filter((hit) => hit.tier === 'approved')
  const evidence = hits.filter((hit) => hit.tier === 'source_evidence')
  // Measured per tier because the server limits per tier: a search that filled
  // the approved ceiling and found three excerpts has been truncated in one
  // section and answered completely in the other.
  const approvedCeiling = resultCeilingNote(approved.length, 'hits')
  const evidenceCeiling = resultCeilingNote(evidence.length, 'excerpts')
  // Whether to explain the evidence line at all. A search for a phrase that only
  // matches claims returns approved hits with no page among them and therefore
  // no evidence line anywhere, and a heading promising one would send the reader
  // hunting for something that is legitimately absent.
  const explainsEvidence = approved.some((hit) => hit.kind === 'concept')

  return (
    <div className="flex flex-col gap-6">
      {searched.length > 1 ? (
        <p className="text-muted-foreground text-xs" data-testid="search-scope">
          Searched {searched.join(', ')}.
        </p>
      ) : null}

      {approved.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="search-approved-heading">
          <div className="flex flex-col gap-1">
            <h2 id="search-approved-heading" className="text-sm font-semibold tracking-tight">
              Approved knowledge
            </h2>
            <p className="text-muted-foreground text-xs">
              {approved.length === 1 ? '1 hit' : `${approved.length} hits`} on pages a human reviewed and published.
              {explainsEvidence
                ? ' Each page also says what stands behind it: the claims it makes, and how many sources they quote.'
                : ''}
            </p>
            {approvedCeiling ? (
              <p className="text-muted-foreground text-xs" data-testid="search-approved-ceiling">
                {approvedCeiling}
              </p>
            ) : null}
          </div>
          <ul className="flex flex-col gap-3" data-testid="search-approved">
            {approved.map((hit, index) => (
              <ApprovedHit key={hitKey(hit, index)} hit={hit} index={index} space={space} />
            ))}
          </ul>
        </section>
      ) : null}

      {evidence.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="search-evidence-heading">
          <div className="border-muted-foreground/40 flex flex-col gap-1 rounded-lg border border-dashed p-3">
            <h2 id="search-evidence-heading" className="text-sm font-semibold tracking-tight">
              Found only in archived sources — not approved knowledge
            </h2>
            {/*
              Said in words, not in colour (CUI-A11Y-5), and said before the
              hits rather than after them. This is the sentence that keeps a
              reader from quoting a source excerpt as though the wiki had
              vouched for it.
            */}
            <p className="text-muted-foreground text-xs">
              {evidence.length === 1 ? 'This excerpt comes' : `These ${evidence.length} excerpts come`} from a document
              this wiki archived. Nobody has reviewed {evidence.length === 1 ? 'it' : 'them'} into a page, so
              {evidence.length === 1 ? ' it is' : ' they are'} evidence to follow up — not something this wiki knows.
            </p>
            {evidenceCeiling ? (
              <p className="text-muted-foreground text-xs" data-testid="search-evidence-ceiling">
                {evidenceCeiling}
              </p>
            ) : null}
          </div>
          <ul className="flex flex-col gap-3" data-testid="search-evidence">
            {evidence.map((hit, index) => (
              <EvidenceHit key={hitKey(hit, index)} hit={hit} index={index} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function ApprovedHit({ hit, index, space }: { hit: SearchHit; index: number; space: string }) {
  return (
    <li className="border-border bg-card flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success">Approved</Badge>
        <span className="text-muted-foreground text-xs">{hit.kind === 'claim' ? 'A claim on this page' : 'Page'}</span>
        {/* Provenance, printed only where it is news: every hit carries the
            space it came from, and naming the wiki you are already reading is
            noise. It becomes a fact worth showing the day imported wikis are
            searched too. */}
        {hit.space !== space ? <Badge tone="neutral">{hit.space}</Badge> : null}
      </div>
      {hit.slug ? (
        <Link
          to="/pages/$slug"
          params={{ slug: hit.slug }}
          data-testid={`search-hit-${index}`}
          className="font-medium underline-offset-2 hover:underline"
        >
          {hit.title}
        </Link>
      ) : (
        <span className="font-medium" data-testid={`search-hit-${index}`}>
          {hit.title}
        </span>
      )}
      <Headline text={hit.headline} />
      {/* Below the excerpt, not above it. The excerpt is why this hit is on the
          screen and it stays next to the title it belongs to; the evidence is
          what a reader weighs once they have seen the match, and it holds the
          same last line on every card so a list of ten can be scanned down that
          one column rather than read. */}
      <PageEvidenceLine hit={hit} index={index} />
    </li>
  )
}

/**
 * What the archive puts behind the page this hit is on.
 *
 * Same five states as the pages index and the same shapes, laid out on one line
 * because a search result is a card of prose rather than a table cell:
 *
 *   Evidence: 12 claims · 4 sources                a page whose promise is kept
 *   Evidence: 12 claims · 4 sources  [2 uncited]   a page with holes in it
 *   Evidence: [No claims]                          a hand-written page, backed by nothing
 *   Evidence: —                                    a reference target, OR counts that never arrived
 *   Evidence: —  2 claims not counted              a reference target that holds claims
 *
 * The word "Evidence:" is here and is not on the index, where the column header
 * carries it — a bare "12 claims · 4 sources" under a paragraph of excerpt would
 * be two numbers about nothing in particular.
 *
 * `backed` still wears no badge and emphatically no green one: every claim
 * quoting a source is this product's baseline, not an achievement, and a success
 * token beside "how does the wiki know this" is exactly what CUI-AI-1 forbids.
 * The plain count is the whole statement.
 *
 * The em dash is ONE glyph over three different facts, and the card no longer
 * works out which by looking at its neighbours. It used to: a response-wide
 * boolean, derived from whether any OTHER hit carried counts, was threaded down
 * through two components to tell a reference target from an old build. The
 * server states it on the hit now — the same `not_measured` object the index row
 * carries — so the prop, the derivation and the drift between the two surfaces
 * are gone. The third fact is the one that had no way of being said at all: a
 * reference target that holds visible claims, whose count is printed beside the
 * dash and nowhere given a badge, because the index is not the linter.
 *
 * And the sentence is now reachable by a reader who can SEE the dash as well,
 * on the same reasoning the pages index already settled: `sr-only` alone made
 * the only reader who could get at the reason the one using a screen reader,
 * which is backwards — an operator asking "why is this blank" has a pointer and
 * a keyboard and nowhere to ask. So the dash is a Tooltip trigger, not a
 * `title=` (CUI-WORDS-2: a native title is one sentence offered to a pointer and
 * to nobody else, and here it would be CARRYING the explanation rather than
 * adding to one already on screen — which is why the measured branch below may
 * keep its `title`, every word of that reading being rendered beside it).
 *
 * The `sr-only` sentence stays as well as the tooltip, and the redundancy is
 * deliberate: a tooltip nobody opens says nothing, so a screen reader going down
 * a list of cards would otherwise reach an `aria-hidden` glyph and hear a line
 * that reads "Evidence:" and stops.
 */
function PageEvidenceLine({ hit, index }: { hit: SearchHit; index: number }) {
  const evidence = hitEvidence(hit)
  if (evidence === null) return null

  const testId = `search-hit-${index}-evidence`

  // Asked by the predicate rather than by name, because "has no number to print"
  // is two levels and this branch is the one that prints no number. A surface
  // that asked `=== 'unmeasured'` would fall through to the measured branch for
  // a reference target and render "Evidence:" followed by nothing.
  if (rendersAsDash(evidence.level))
    return (
      <p className="text-muted-foreground text-xs" data-testid={testId} data-evidence={evidence.level}>
        <span className="font-medium">Evidence:</span>{' '}
        {/* Its own provider, like every other Tooltip in this console: Radix
            throws rather than degrades when a Tooltip cannot find one, and these
            cards are rendered under a route that mounts no tree of its own. */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="focus-visible:ring-ring/50 rounded focus-visible:ring-[3px] focus-visible:outline-none"
                data-testid={`${testId}-dash`}
              >
                <span aria-hidden="true">—</span>
                <span className="sr-only">{evidence.reading}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent data-testid={`${testId}-reason`}>{evidence.reading}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {/* The withheld count, on `reference_withheld` and no other level. Plain
            muted text on the same line — no badge, no tone, no advice: what a
            reader needs from this screen is that a real number exists and is not
            being shown, and what to do about it belongs to the lint report,
            which reports the same count with both readings of the cause.
            aria-hidden because the sr-only sentence above already spells it. */}
        {evidence.detail ? (
          <>
            {' '}
            <span aria-hidden="true" data-testid={`${testId}-withheld`}>
              {evidence.detail}
            </span>
          </>
        ) : null}
      </p>
    )

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      data-testid={testId}
      data-evidence={evidence.level}
    >
      <span className="text-muted-foreground font-medium">Evidence:</span>
      {evidence.count ? <span className="text-muted-foreground tabular-nums">{evidence.count}</span> : null}
      {evidence.detail ? (
        <>
          {/* Punctuation, not information: the two counts are separate spans and
              a screen reader hears them as such, so the dot is hidden rather
              than announced. */}
          <span className="text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span className="text-muted-foreground tabular-nums">{evidence.detail}</span>
        </>
      ) : null}
      {evidence.flag ? <Badge tone={evidence.tone}>{evidence.flag}</Badge> : null}
    </div>
  )
}

function EvidenceHit({ hit, index }: { hit: SearchHit; index: number }) {
  const original = httpUrl(hit.url)
  return (
    <li className="border-muted-foreground/40 flex flex-col gap-2 rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="unknown">Source evidence</Badge>
        <span className="text-muted-foreground text-xs">Not approved knowledge</span>
      </div>
      <span className="font-medium">{hit.title}</span>
      {hit.heading ? <span className="text-muted-foreground text-xs">{hit.heading}</span> : null}
      <Headline text={hit.headline} />
      <div className="flex flex-wrap gap-3 text-xs">
        {hit.source_id ? (
          <Link
            to="/sources/$id"
            params={{ id: hit.source_id }}
            data-testid={`search-evidence-${index}-source`}
            className="underline underline-offset-2"
          >
            Read the archived source
          </Link>
        ) : null}
        {original ? (
          // `rel="noreferrer"` and an http(s) guard: this URL came out of a
          // document somebody uploaded, and a `javascript:` href in a source
          // record must not become a link this console offers to click.
          <a
            href={original}
            target="_blank"
            rel="noreferrer"
            data-testid={`search-evidence-${index}-url`}
            className="inline-flex items-center gap-1 underline underline-offset-2"
          >
            Where it came from
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The server's `ts_headline` excerpt, with its `<mark>` rendered as EMPHASIS and
 * never as HTML.
 *
 * The excerpt is source text — a chunk of a document somebody uploaded — and
 * handing it to `dangerouslySetInnerHTML` would let that document put script
 * into this console. So the string is scanned for the one pair of delimiters
 * Postgres puts in it, and every span between them becomes a React `<mark>`
 * element built here. Everything else stays literal text: an excerpt that
 * happens to contain `<script>` renders as the four visible words `<script>`,
 * which is exactly what a reader should see.
 */
function Headline({ text }: { text: string }) {
  return (
    <p className="text-muted-foreground text-sm break-words">
      {markedParts(text).map((part, index) =>
        part.marked ? (
          // A highlight is typographic emphasis, not a status: it carries no
          // severity token and says nothing about whether the hit is good news.
          <mark key={index} className="bg-accent/20 text-foreground rounded-sm px-0.5 font-medium">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  )
}

/**
 * A grounded answer, written by a model over what this wiki has approved.
 *
 * Kept below the raw hits and behind a button on purpose: search is the evidence
 * and this is a READING of it. The most valuable thing it can say is that the
 * wiki does not know — `not_in_knowledge_base` — and that branch is rendered as
 * plainly as the answer itself, because a knowledge base whose console hides its
 * own ignorance is the failure mode the whole review gate exists to prevent.
 */
function AskPanel({
  question,
  mode,
  pending,
  error,
  answer,
  onAsk,
}: {
  question: string
  mode: ModeChoice
  pending: boolean
  error: unknown
  answer: unknown
  onAsk: () => void
}) {
  const read = answer === undefined ? null : readAnswer(answer)
  return (
    <I18nText>
      <section className="border-border flex flex-col gap-3 rounded-lg border p-4" aria-labelledby="search-ask-heading">
        <SectionHeading
          id="search-ask-heading"
          helpTitle="About asking"
          help={
            <p>
              A model reads the approved pages{mode === 'approved_then_sources' ? ' and the archived sources' : ''} and
              answers in prose, citing what it used. It costs model tokens, so it runs only when you ask.
            </p>
          }
          testId="search-ask-help"
        >
          Ask instead of searching
        </SectionHeading>

        <Button
          variant="outline"
          className="w-fit"
          data-testid="search-ask"
          disabled={question === '' || pending}
          onClick={onAsk}
        >
          {/* The label does not rewrite itself while it works (CUI-ACT-5): the
            spinner and the disabled state carry that, so the button an operator
            aimed at is still the button they hit. */}
          {pending ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
          Answer this question
        </Button>

        {error !== null && error !== undefined ? <AskFailure error={error} /> : null}

        {read ? (
          read.missing ? (
            <div
              className="border-muted-foreground/40 rounded-lg border border-dashed p-3 text-sm"
              data-testid="search-answer-missing"
            >
              <span className="font-medium">This wiki does not know.</span>{' '}
              <span className="text-muted-foreground">
                Nothing approved here answers that question. Adding a source is how the wiki learns it.
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {read.markdown ? (
                <div className="wk-doc" data-testid="search-answer">
                  <Markdown remarkPlugins={[remarkGfm]}>{read.markdown}</Markdown>
                </div>
              ) : (
                // An answer with no prose in it is not an empty page: it is a
                // model that returned nothing, and saying so beats a blank block.
                <p className="text-muted-foreground text-sm" data-testid="search-answer">
                  The model returned no answer.
                </p>
              )}
              {read.citations.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Cited pages:</span>
                  {read.citations.map((citation, index) => (
                    <Link
                      key={citation.slug}
                      to="/pages/$slug"
                      params={{ slug: citation.slug }}
                      data-testid={`search-answer-citation-${index}`}
                      className="underline underline-offset-2"
                    >
                      {semanticLabel([citation.title, citation.slug], 'Page')}
                    </Link>
                  ))}
                </div>
              ) : null}
              {read.sources.length > 0 ? (
                <div className="border-muted-foreground/40 flex flex-col gap-2 rounded-lg border border-dashed p-3 text-xs">
                  <span className="font-medium">
                    Part of this answer rests on archived sources rather than on approved knowledge
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {read.sources.map((source, index) => (
                      <Link
                        key={source.id}
                        to="/sources/$id"
                        params={{ id: source.id }}
                        data-testid={`search-answer-source-${index}`}
                        className="underline underline-offset-2"
                      >
                        {semanticLabel([source.title], 'Archived source')}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )
        ) : null}
      </section>
    </I18nText>
  )
}

/**
 * The refusal, in the server's own words.
 *
 * `503 llm_not_configured` is the one worth designing for: a deployment with no
 * model key answers it forever, and it is a fact about the installation rather
 * than a hiccup. `describeFailure` is what decides whether a retry could ever
 * help, so this surface and the read surfaces cannot disagree about it.
 */
function AskFailure({ error }: { error: unknown }) {
  const api = error instanceof ApiError ? error : null
  const notice = describeFailure({
    status: api?.status ?? null,
    message: error instanceof Error ? error.message : String(error),
    actions: api?.nextBestActions ?? [],
  })
  return (
    <Alert tone={notice.tone} title={notice.title} actions={notice.actions} data-testid="search-ask-error">
      {notice.message}
    </Alert>
  )
}

/** Loading is the shape of the hits that are coming, never a spinner. */
function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="border-border flex flex-col gap-2 rounded-lg border p-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------- rules */

/** A stable key per hit; the index is the fallback, never the identity. */
function hitKey(hit: SearchHit, index: number): string {
  return `${hit.tier}:${hit.claim_id ?? hit.chunk_id ?? hit.slug ?? index}`
}

/**
 * The excerpt, split into the spans Postgres marked and the spans it did not.
 * Pure: only the exact tokens `<mark>` and `</mark>` are delimiters, and an
 * unpaired one is left as the literal text it is.
 */
function markedParts(headline: string): { text: string; marked: boolean }[] {
  const parts: { text: string; marked: boolean }[] = []
  const pattern = /<mark>([\s\S]*?)<\/mark>/g
  let cursor = 0
  for (const match of headline.matchAll(pattern)) {
    const at = match.index
    if (at > cursor) parts.push({ text: headline.slice(cursor, at), marked: false })
    parts.push({ text: match[1] ?? '', marked: true })
    cursor = at + match[0].length
  }
  if (cursor < headline.length) parts.push({ text: headline.slice(cursor), marked: false })
  return parts
}

/**
 * The answer, narrowed by hand.
 *
 * `wk.search.ask` is typed `unknown` in the facade — the POST bodies there are
 * not generated from the schema the way the GET responses are — so the shape is
 * read defensively here rather than asserted. A field the server stops sending
 * becomes an absent field, not a crash in the middle of a rendered answer.
 */
function readAnswer(value: unknown): {
  markdown: string
  citations: { slug: string; title: string }[]
  sources: { id: string; title: string | null }[]
  missing: boolean
} {
  const body = (value ?? {}) as Record<string, unknown>
  const citations = Array.isArray(body.citations) ? body.citations : []
  const sources = Array.isArray(body.source_citations) ? body.source_citations : []
  return {
    markdown: typeof body.answer_markdown === 'string' ? body.answer_markdown : '',
    missing: body.not_in_knowledge_base === true,
    citations: citations.flatMap((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>
      return typeof record.slug === 'string'
        ? [{ slug: record.slug, title: typeof record.title === 'string' ? record.title : record.slug }]
        : []
    }),
    sources: sources.flatMap((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>
      return typeof record.source_id === 'string'
        ? [{ id: record.source_id, title: typeof record.title === 'string' ? record.title : null }]
        : []
    }),
  }
}

/** An href this console is willing to offer. Anything not http(s) is not a link. */
function httpUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}
