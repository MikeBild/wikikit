import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronDown, Clock3, MoreHorizontal, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { RelativeTime } from '@/components/ui/relative-time'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { TranslationKey } from '@/lib/i18n'
import { useI18n } from '@/lib/i18n-context'
import { readableTitle } from '@/lib/presentation'
import {
  AGING_DAYS,
  GLOBAL_ATTENTION_QUERY,
  bySpace,
  countOpenDecisions,
  decisionId,
  dedupe,
  summaryLine,
  type SpaceTally,
} from '@/pages/decisions.logic'

type AttentionResponse = Awaited<ReturnType<typeof wk.attention.list>>
type AttentionItem = AttentionResponse['items'][number]
type AttentionKind = AttentionItem['kind']
type TriageSuggestion = NonNullable<Awaited<ReturnType<typeof wk.ingest.suggestTriage>>['suggestion']>

/**
 * One row of the queue, and there is only ever one kind of row: a position that
 * is still waiting.
 *
 * THIS PAGE SHOWS THE PRESENT. It used to carry three more tabs — deferred,
 * discarded, decided — and each of them answered a question about the PAST from
 * a second endpoint, with its own counts, its own emptiness and its own restore
 * button. The whole of that history is in the audit trail (`/audit`), complete
 * and append-only, so a second, shorter copy of it here was a place where a
 * reader could read a different past than the record holds. What is left is the
 * queue: what waits, and nothing that is finished.
 *
 * `detail` is null exactly when the full payload has not been fetched yet —
 * §8.4's panel loads it when somebody opens the row, which is the only place it
 * is shown. The installation-wide feed carries what a queue needs to be READ;
 * the per-wiki read carries what one row needs to be JUDGED.
 */
interface QueueRow {
  space: string
  spaceName: string
  key: string
  kind: AttentionKind
  title: string
  summary: string | null
  createdAt: string
  detail: AttentionItem | null
}

/**
 * The state every row on this page is in, written down rather than derived.
 *
 * The global feed answers open positions and nothing else, so this is a claim
 * about the endpoint, not a value read off a row — and it is on the card as
 * `data-state` so the convention check can hold the page to it: a card here
 * whose state is not `open` is the defect §8.5 used to institutionalise.
 */
const QUEUE_STATE = 'open'

const KIND_KEYS: Record<AttentionKind, TranslationKey> = {
  proposal: 'attention.kind.proposal',
  triage: 'attention.kind.triage',
}

export function DecisionsPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  /*
    The kind chip is an ADDRESS, not component state.

    A counter tile on the overview breaks the queue down by kind and each tile
    has to lead to the list it counted; a filter in `useState` cannot be linked
    to. `/decisions` declares the parameter in router.tsx, so an unknown value
    is dropped there rather than turned into a request nobody can answer.
  */
  const { kind = 'all' } = useSearch({ strict: false }) as { kind?: AttentionKind | 'all' }
  const setKind = (next: AttentionKind | 'all') =>
    void navigate({
      to: '.',
      search: ((previous: Record<string, unknown>) => ({
        ...previous,
        kind: next === 'all' ? undefined : next,
      })) as never,
    })
  const [wiki, setWiki] = useState<string>('all')

  /*
    ONE queue, the whole installation, and only what is still waiting.

    §8.1 wants one queue and one counter for the whole installation, and the
    console used to have neither: the page counted the current wiki, the
    sidebar badge counted the current wiki, and the overview counted every
    wiki — so an operator read "1" in two places and "3" in a third, all of
    them correct, none of them the same question. The queue reads the global
    feed with the SAME arguments as the overview and the badge, which is why
    they cannot disagree: it is one cache entry.

    There is no second read any more. The deferred/discarded/decided tabs read
    the per-wiki endpoint and showed a SHORTER past beside the audit trail's
    complete one; the per-wiki read is still here, but only inside an opened
    row, where it carries the origins and targets one position needs to be
    judged.
  */
  const query = useQuery({
    queryKey: keys.globalAttention(GLOBAL_ATTENTION_QUERY),
    queryFn: () => wk.attention.global(GLOBAL_ATTENTION_QUERY),
  })

  const data = query.data
  const open = data
    ? countOpenDecisions({
        items: data.items,
        counts: data.counts,
        nowMs: new Date(data.generated_at).getTime(),
      })
    : null
  const tallies: SpaceTally[] = data ? bySpace(data.items) : []

  const generatedAt = new Date(data?.generated_at ?? 0).getTime()
  const rows: QueueRow[] = dedupe(data?.items ?? []).map((item) => ({
    space: item.space,
    spaceName: item.space_name ?? item.space,
    key: item.key,
    kind: item.kind,
    title: item.title,
    summary: item.summary || null,
    createdAt: item.created_at,
    detail: null,
  }))

  // Chips filter ROWS. Neither the counter beside them nor the three other
  // numbers on screen move when one is pressed — see decisions.logic.ts.
  const visible = rows.filter((row) => (kind === 'all' || row.kind === kind) && (wiki === 'all' || row.space === wiki))
  const filtered = kind !== 'all' || wiki !== 'all'
  const waitingLonger = visible.filter(
    (row) => generatedAt - new Date(row.createdAt).getTime() >= AGING_DAYS * 86_400_000,
  )
  const currentItems = visible.filter((row) => !waitingLonger.includes(row))
  const total = open?.total ?? 0
  const oldestDays = open?.oldestAgeDays ?? null

  return (
    <Page title="Decisions" description={t('page.decisions.description')}>
      <div
        className="flex w-full min-w-0 flex-col gap-6"
        data-testid="attention-list"
        data-total={total}
        data-capped={String(Boolean(open?.capped))}
      >
        <section className="flex flex-col gap-3" aria-label={t('decisions.filters')}>
          <ToggleGroup
            type="single"
            value={kind}
            onValueChange={(value) => value && setKind(value as AttentionKind | 'all')}
            variant="outline"
            size="sm"
            className="max-w-full flex-wrap justify-start"
          >
            <ToggleGroupItem value="all" data-testid="decisions-kind-all">
              {t('attention.kind.all')}
            </ToggleGroupItem>
            {(Object.keys(KIND_KEYS) as AttentionKind[]).map((value) => (
              <ToggleGroupItem key={value} value={value} data-testid={`decisions-kind-${value}`}>
                {t(KIND_KEYS[value])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {tallies.length ? (
            <ToggleGroup
              type="single"
              value={wiki}
              onValueChange={(value) => value && setWiki(value)}
              variant="outline"
              size="sm"
              className="max-w-full flex-wrap justify-start"
              aria-label={t('decisions.wikiFilter')}
            >
              <ToggleGroupItem value="all" data-testid="decisions-space-all">
                {t('decisions.wikiAll')}
              </ToggleGroupItem>
              {tallies.map((tally) => (
                <ToggleGroupItem key={tally.space} value={tally.space} data-testid={`decisions-space-${tally.space}`}>
                  {tally.name} · {tally.count}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
          {data ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Clock3 />
              <span>{oldestDays == null ? t('attention.noAge') : t('attention.oldest', { count: oldestDays })}</span>
              {/*
                The counter beside the chips is the WHOLE installation, and it
                does not move when a chip is pressed. A filter that also moves
                the counter answers a question nobody asked ("how many are open
                in what I am looking at") with the words of the question they
                did ("how many are open").
              */}
              <Badge
                tone={total ? 'warning' : 'success'}
                data-testid="decisions-queue-count"
                data-total={total}
                data-visible={visible.length}
              >
                {t('attention.openCount', { count: total })}
              </Badge>
            </div>
          ) : null}
        </section>

        {query.isLoading ? <p className="text-sm text-muted-foreground">{t('decisions.loading')}</p> : null}
        {query.isError ? <Alert tone="danger" title={t('decisions.error')} /> : null}
        {data && visible.length === 0 ? (
          <DecisionEmpty
            filtered={filtered}
            onShowAll={() => {
              setKind('all')
              setWiki('all')
            }}
          />
        ) : null}
        {waitingLonger.length ? (
          <section className="flex flex-col gap-3" aria-labelledby="decisions-waiting-longer">
            <h2 id="decisions-waiting-longer" className="text-sm font-semibold text-warning">
              {t('decisions.waitingLonger')}
            </h2>
            {waitingLonger.map((row, index) => (
              <AttentionCard key={decisionId(row)} row={row} testId={`decision-waiting-${index + 1}`} />
            ))}
          </section>
        ) : null}
        {currentItems.length ? (
          <section className="flex flex-col gap-3" aria-label={t('decisions.needsAttention')}>
            {currentItems.map((row, index) => (
              <AttentionCard key={decisionId(row)} row={row} testId={`decision-item-${index + 1}`} />
            ))}
          </section>
        ) : null}
      </div>
    </Page>
  )
}

/**
 * §8.6 — two emptinesses, and they are different sentences.
 *
 * "Nothing is waiting" is the good one and gets the green check; "nothing
 * matches these chips" is the reader's own doing and gets the way back. There
 * is no third one any more: the shelves had an emptiness of their own ("this
 * view holds no entries"), which said nothing about the wiki and everything
 * about a tab that should not have been here.
 */
function DecisionEmpty({ filtered, onShowAll }: { filtered: boolean; onShowAll: () => void }) {
  const { t } = useI18n()
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldCheck />
        </EmptyMedia>
        <EmptyTitle>{filtered ? t('decisions.empty.filtered') : t('decisions.empty.open')}</EmptyTitle>
        <EmptyDescription>{t('decisions.empty.description')}</EmptyDescription>
      </EmptyHeader>
      {filtered ? (
        <EmptyContent>
          <Button variant="outline" data-testid="decisions-empty-show-all" onClick={onShowAll}>
            {t('decisions.showAll')}
          </Button>
        </EmptyContent>
      ) : (
        <EmptyContent>
          <Button asChild>
            <Link to="/inbox" data-testid="decisions-empty-inbox">
              {t('decisions.openInbox')}
            </Link>
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

/**
 * One position in the queue — always one that is still waiting.
 *
 * `detail` is the per-wiki payload — origins, targets, the earlier rejection —
 * and the queue's own feed does not carry it: the installation-wide read
 * carries what a queue needs to be read (wiki, kind, title, summary, age) and
 * not what one row needs to be JUDGED. So the row fetches it when somebody
 * opens the panel, which is the only place any of it is shown. One request per
 * wiki, shared by every open row in it, because react-query keys it by wiki
 * rather than by row.
 */
function AttentionCard({ row, testId }: { row: QueueRow; testId: string }) {
  const { t, date } = useI18n()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const space = row.space
  // Two destinations, both of them OUT of the queue. `open` was the third and
  // is gone with the shelves: nothing on this page puts a position back,
  // because nothing on this page shows one that left.
  const stateMutation = useMutation({
    mutationFn: (state: 'deferred' | 'discarded') =>
      wk.attention.setState(space, row.key, {
        state,
        ...(state === 'deferred' ? { remind_at: new Date(Date.now() + 3 * 86_400_000).toISOString() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.attention(space).slice(0, -1) })
      // The badge, the overview card and the banner all read the global feed.
      // Deciding here without invalidating it would leave three surfaces
      // showing a number this page has just disproved.
      void queryClient.invalidateQueries({ queryKey: keys.globalAttention().slice(0, -1) })
    },
  })
  const detailArgs = { state: 'open', limit: 200 }
  const detailQuery = useQuery({
    queryKey: keys.attention(space, detailArgs),
    queryFn: () => wk.attention.list(space, detailArgs),
    enabled: expanded && row.detail === null,
  })
  const detail = row.detail ?? detailQuery.data?.items.find((entry) => entry.key === row.key) ?? null
  const title = readableTitle(row.title, t('decisions.untitled'))
  const summary = summaryLine(row.summary, t)
  const proposalId = row.kind === 'proposal' ? row.key.slice('proposal:'.length) : null
  const proposal = useQuery({
    queryKey: proposalId ? keys.proposal(proposalId) : ['proposal-preview', 'none'],
    queryFn: () => wk.proposals.get(proposalId!),
    enabled: expanded && Boolean(proposalId),
  })
  const lint = useQuery({
    queryKey: proposalId ? keys.proposalLint(proposalId) : ['proposal-lint', 'none'],
    queryFn: () => wk.proposals.lint(proposalId!),
    enabled: expanded && Boolean(proposalId),
  })
  return (
    <Card
      data-kind={row.kind}
      data-state={QUEUE_STATE}
      data-decision-key={row.key}
      data-space={row.space}
      data-testid={testId}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge tone={row.kind === 'proposal' ? 'accent' : 'neutral'}>{t(KIND_KEYS[row.kind])}</Badge>
          <Badge tone="warning">{t('attention.state.open')}</Badge>
          {/*
            The wiki, named in the row rather than assumed from the switcher.
            The queue is installation-wide now, so "which wiki is this?" is a
            question the row has to answer on its own — §8.3's source reference.
          */}
          <Link to="/spaces" className="underline-offset-4 hover:underline" data-testid={`${testId}-wiki`}>
            {row.spaceName}
          </Link>
          <RelativeTime value={row.createdAt} />
        </div>
        {/*
          §5/§8.3 — the title is a summary, never a raw identifier. The server
          composes it from whatever the source was called, and an ingested
          coding session is called "Codex session <id>": a row a reviewer can
          neither say out loud nor tell apart from the next one. The date takes
          over that job; the identifier keeps its own, in the panel below.
        */}
        <CardTitle>
          {title.text}
          {title.redacted ? ` · ${date(row.createdAt)}` : ''}
        </CardTitle>
        {summary ? <CardDescription>{summary}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{t(attentionEffectKey(row.kind))}</p>
        {detail?.previous_rejection ? (
          <Alert tone="warning" title={t('decisions.previousRejection')}>
            {detail.previous_rejection.note || t('decisions.previousRejectionNoNote')}
          </Alert>
        ) : null}
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" aria-expanded={expanded} data-testid={`${testId}-preview-toggle`}>
              <ChevronDown data-icon="inline-start" />
              {expanded ? t('decisions.hideEvidence') : t('decisions.showEvidence')}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 flex flex-col gap-3">
            {/*
              The raw title, in the one place §5 allows an identifier: the
              detail depth. It is not a name, it is EVIDENCE of where the
              position came from — the raw title survives capture on purpose,
              so hiding it entirely would trade one loss for another.
            */}
            {title.redacted ? (
              <p className="text-xs text-muted-foreground" data-testid={`${testId}-raw-title`}>
                {t('decisions.rawTitle')}: <span className="font-mono break-all">{row.title}</span>
              </p>
            ) : null}
            {/*
              The English original, for the same reason as the raw title: the
              German line above is a DERIVATION, and a reader who wants to check
              what the pipeline actually wrote should not have to open an API
              client to do it.
            */}
            {row.summary && summary !== row.summary ? (
              <p className="text-xs text-muted-foreground" data-testid={`${testId}-raw-summary`}>
                {t('summary.original')}: <span className="break-words">{row.summary}</span>
              </p>
            ) : null}
            {detail ? (
              <DecisionTrace item={detail} testId={`${testId}-trace`} />
            ) : detailQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">{t('decisions.loadingDiff')}</p>
            ) : null}
            {proposal.isLoading || lint.isLoading ? (
              <p className="text-sm text-muted-foreground">{t('decisions.loadingDiff')}</p>
            ) : null}
            {proposal.data?.concepts.map((concept) => (
              <div key={concept.slug} className="grid gap-3 md:grid-cols-2">
                <DiffBlock label={t('decisions.before')} value={concept.old_markdown ?? t('decisions.newPage')} />
                <DiffBlock label={t('decisions.after')} value={concept.new_markdown} />
              </div>
            ))}
            {proposal.data?.sources.map((source) => (
              <div key={source.id} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge tone="unknown">{t('decisions.sourceLocked')}</Badge>
                <span>{source.title}</span>
              </div>
            ))}
            {lint.data ? (
              <p className="text-xs text-muted-foreground">
                {t('decisions.checkSummary', {
                  errors: lint.data.counts.error,
                  warnings: lint.data.counts.warn,
                })}
              </p>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
        {row.kind === 'triage' ? (
          <TriagePanel ingestId={row.key.slice('triage:'.length)} space={space} testId={`${testId}-triage`} />
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20">
        <TaskLink row={row} testId={testId} />
        {
          /*
            §8.3's ⋯ menu, and no "return to open" beside it.

            Both entries take a position OUT of the queue and neither pretends
            to file it somewhere this page then shows: deferring re-arms it for
            a later day, discarding ends it. Where it went is a question the
            audit trail answers, which is why nothing here offers to fetch it
            back — a restore button belongs to a shelf, and there is none.
          */
          <Confirm
            title={t('decisions.removeConfirmTitle')}
            description={t('decisions.removeConfirmDescription')}
            confirmLabel={t('decisions.remove')}
            onConfirm={() => stateMutation.mutateAsync('discarded')}
            ids={{ dialog: `${testId}-remove-dialog`, accept: `${testId}-remove-confirm` }}
          >
            {(openRemove) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" data-testid={`${testId}-more`} disabled={stateMutation.isPending}>
                    <MoreHorizontal data-icon="inline-start" />
                    {t('decisions.more')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem data-testid={`${testId}-defer`} onSelect={() => stateMutation.mutate('deferred')}>
                    {t('decisions.remind')}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" data-testid={`${testId}-remove`} onSelect={openRemove}>
                    {t('decisions.remove')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </Confirm>
        }
      </CardFooter>
    </Card>
  )
}

function TriagePanel({ ingestId, space, testId }: { ingestId: string; space: string; testId: string }) {
  const { t } = useI18n()
  const suggestion = useQuery({
    queryKey: keys.triage(ingestId),
    queryFn: () => wk.ingest.suggestTriage(ingestId),
  })
  if (suggestion.isLoading) return <p className="text-sm text-muted-foreground">{t('decisions.triage.preparing')}</p>
  if (suggestion.isError || !suggestion.data?.suggestion)
    return <Alert tone="danger" title={t('decisions.triage.unavailable')} />
  return (
    <TriageForm
      key={suggestion.data.suggestion.generated_at}
      ingestId={ingestId}
      space={space}
      testId={testId}
      suggestion={suggestion.data.suggestion}
    />
  )
}

function TriageForm({
  ingestId,
  space,
  testId,
  suggestion,
}: {
  ingestId: string
  space: string
  testId: string
  suggestion: TriageSuggestion
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState(suggestion.title)
  const [summary, setSummary] = useState(suggestion.summary)
  const [target, setTarget] = useState(suggestion.target_space ?? space)
  const [question, setQuestion] = useState(suggestion.question ?? '')
  const resolve = useMutation({
    mutationFn: (action: 'process' | 'use_existing' | 'leave' | 'discard') =>
      wk.ingest.resolveTriage(ingestId, {
        action,
        title,
        summary,
        target_space: target,
        question: question || null,
        ...(action === 'use_existing' && suggestion.duplicate_source_id
          ? { source_id: suggestion.duplicate_source_id }
          : {}),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.space(space) }),
  })
  const duplicate = suggestion.duplicate_source_id
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-medium">
          {t('decisions.triage.title')}
          <Input data-testid={`${testId}-title`} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          {t('decisions.triage.target')}
          <Input data-testid={`${testId}-target`} value={target} onChange={(event) => setTarget(event.target.value)} />
        </label>
      </div>
      <label className="grid gap-1 text-xs font-medium">
        {t('decisions.triage.summary')}
        <Textarea
          data-testid={`${testId}-summary`}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-xs font-medium">
        {t('decisions.triage.question')}
        <Textarea
          data-testid={`${testId}-question`}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid={`${testId}-process`}
          disabled={!title || resolve.isPending}
          onClick={() => resolve.mutate('process')}
        >
          {t('decisions.triage.process')}
        </Button>
        {duplicate ? (
          <Button
            size="sm"
            variant="outline"
            data-testid={`${testId}-use-existing`}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate('use_existing')}
          >
            {t('decisions.triage.useExisting')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          data-testid={`${testId}-leave`}
          disabled={resolve.isPending}
          onClick={() => resolve.mutate('leave')}
        >
          {t('decisions.triage.leave')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid={`${testId}-discard`}
          disabled={resolve.isPending}
          onClick={() => resolve.mutate('discard')}
        >
          {t('decisions.triage.discard')}
        </Button>
      </div>
    </div>
  )
}

function TaskLink({ row, testId }: { row: QueueRow; testId: string }) {
  const { t } = useI18n()
  if (row.kind === 'triage') return <span className="text-xs text-muted-foreground">{t('decisions.sortAbove')}</span>
  const href = `/decisions/proposals/${row.key.slice('proposal:'.length)}`
  // The wiki travels with the link. The queue crosses wikis now, so a review
  // opened from a row in another wiki must not land in whichever one the
  // switcher happens to hold.
  return (
    <Button asChild size="sm">
      <Link to={href as never} search={{ space: row.space } as never} data-testid={`${testId}-open-target`}>
        {t(taskActionKey(href))}
      </Link>
    </Button>
  )
}

function attentionEffectKey(kind: AttentionKind): TranslationKey {
  return `attention.effect.${kind}` as TranslationKey
}

function taskActionKey(href: string): TranslationKey {
  if (href.startsWith('/sources/')) return 'decisions.openSource'
  if (href.startsWith('/pages/')) return 'decisions.openPage'
  if (href.startsWith('/decisions/proposals/')) return 'decisions.openProposal'
  if (href.startsWith('/charter')) return 'decisions.openGuidelines'
  if (href.startsWith('/care')) return 'decisions.openCheck'
  return 'decisions.openObject'
}

function DecisionTrace({ item, testId }: { item: AttentionItem; testId: string }) {
  const { t } = useI18n()
  return (
    <dl className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2" data-testid={testId}>
      <div className="min-w-0">
        <dt className="text-xs font-medium text-muted-foreground">{t('decisions.origin')}</dt>
        <dd className="mt-1 flex flex-col gap-1.5">
          {item.origins.length ? (
            item.origins.map((origin, index) => (
              <span key={`${origin.href}-${index}`} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <Link
                  to={origin.href as never}
                  className="truncate underline-offset-4 hover:underline"
                  data-testid={`${testId}-origin-${index + 1}`}
                >
                  {origin.label}
                </Link>
                {origin.provenance === 'generated' ? <Badge tone="unknown">{t('decisions.generated')}</Badge> : null}
              </span>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">{t('decisions.noOrigin')}</span>
          )}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs font-medium text-muted-foreground">{t('decisions.target')}</dt>
        <dd className="mt-1 flex flex-col gap-1.5">
          {item.targets.length ? (
            item.targets.map((target, index) => (
              <span key={`${target.label}-${index}`} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                {target.href ? (
                  <Link
                    to={target.href as never}
                    className="truncate underline-offset-4 hover:underline"
                    data-testid={`${testId}-target-${index + 1}`}
                  >
                    {target.label}
                  </Link>
                ) : (
                  <span className="truncate">{target.label}</span>
                )}
                <Badge tone="neutral">{t(`decisions.target.${target.change}`)}</Badge>
              </span>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">{t('decisions.noTarget')}</span>
          )}
        </dd>
      </div>
    </dl>
  )
}

function DiffBlock({ label, value }: { label: string; value: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted p-3">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{value}</pre>
    </section>
  )
}
