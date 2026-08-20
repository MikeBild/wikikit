import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
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
import { useSpaceContext } from '@/lib/space'
import type { TranslationKey } from '@/lib/i18n'
import { useI18n } from '@/lib/i18n-context'
import {
  AGING_DAYS,
  GLOBAL_ATTENTION_QUERY,
  bySpace,
  countOpenDecisions,
  decisionId,
  dedupe,
  type SpaceTally,
} from '@/pages/decisions.logic'

type AttentionResponse = Awaited<ReturnType<typeof wk.attention.list>>
type AttentionItem = AttentionResponse['items'][number]
type AttentionState = 'open' | 'deferred' | 'discarded' | 'decided'
type AttentionKind = AttentionItem['kind']
type TriageSuggestion = NonNullable<Awaited<ReturnType<typeof wk.ingest.suggestTriage>>['suggestion']>

/**
 * One row of the queue, whichever feed it arrived on.
 *
 * The open tab reads the INSTALLATION-WIDE feed and the shelves read the
 * current wiki, and the two answer different shapes: the global feed carries
 * the wiki a position belongs to but not its origins, targets or rejection
 * history. Rather than teach the card about two shapes, both are narrowed to
 * this one here, and `detail` is null exactly when the full payload has not
 * been fetched yet — §8.4's panel loads it when somebody opens the row, which
 * is the only place it is shown.
 */
interface QueueRow {
  space: string
  spaceName: string
  key: string
  kind: AttentionKind
  state: AttentionState
  title: string
  summary: string | null
  createdAt: string
  detail: AttentionItem | null
}

const STATE_KEYS: Record<AttentionState, TranslationKey> = {
  open: 'attention.state.open',
  deferred: 'attention.state.deferred',
  discarded: 'attention.state.discarded',
  decided: 'attention.state.decided',
}

const KIND_KEYS: Record<AttentionKind, TranslationKey> = {
  proposal: 'attention.kind.proposal',
  triage: 'attention.kind.triage',
}

export function DecisionsPage() {
  const { space, options } = useSpaceContext()
  const { t } = useI18n()
  const [state, setState] = useState<AttentionState>('open')
  const [kind, setKind] = useState<AttentionKind | 'all'>('all')
  const [wiki, setWiki] = useState<string>('all')

  /*
    The open queue is the INSTALLATION, the shelves are this wiki.

    §8.1 wants one queue and one counter for the whole installation, and the
    console used to have neither: the page counted the current wiki, the
    sidebar badge counted the current wiki, and the overview counted every
    wiki — so an operator read "1" in two places and "3" in a third, all of
    them correct, none of them the same question. The open tab now reads the
    global feed with the SAME arguments as the overview and the badge, which
    is why they cannot disagree: it is one cache entry.

    The shelves stay per-wiki on purpose. They feed none of the four numbers,
    the state they show is an operator note on a wiki's own object, and the
    global feed does not carry deferred or discarded positions at all.
  */
  const openQuery = useQuery({
    queryKey: keys.globalAttention(GLOBAL_ATTENTION_QUERY),
    queryFn: () => wk.attention.global(GLOBAL_ATTENTION_QUERY),
    enabled: state === 'open',
  })
  const shelfArgs = { state, ...(kind === 'all' ? {} : { kind }), limit: 200 }
  const shelfQuery = useQuery({
    queryKey: keys.attention(space ?? '', shelfArgs),
    queryFn: () => wk.attention.list(space!, shelfArgs),
    enabled: state !== 'open' && Boolean(space),
  })
  const query = state === 'open' ? openQuery : shelfQuery

  const openData = openQuery.data
  const open = openData
    ? countOpenDecisions({
        items: openData.items,
        counts: openData.counts,
        nowMs: new Date(openData.generated_at).getTime(),
      })
    : null
  const tallies: SpaceTally[] = openData ? bySpace(openData.items) : []
  const spaceName = (slug: string) =>
    options.find((option) => option.slug === slug)?.name ?? tallies.find((tally) => tally.space === slug)?.name ?? slug

  const generatedAt = new Date(
    (state === 'open' ? openData?.generated_at : shelfQuery.data?.generated_at) ?? 0,
  ).getTime()
  const rows: QueueRow[] =
    state === 'open'
      ? dedupe(openData?.items ?? []).map((item) => ({
          space: item.space,
          spaceName: item.space_name ?? item.space,
          key: item.key,
          kind: item.kind,
          state: 'open' as const,
          title: item.title,
          summary: item.summary || null,
          createdAt: item.created_at,
          detail: null,
        }))
      : (shelfQuery.data?.items ?? []).map((item) => ({
          space: space ?? '',
          spaceName: spaceName(space ?? ''),
          key: item.key,
          kind: item.kind,
          state: item.state as AttentionState,
          title: item.title,
          summary: item.summary || null,
          createdAt: item.created_at,
          detail: item,
        }))

  // Chips filter ROWS. Neither the counter beside them nor the three other
  // numbers on screen move when one is pressed — see decisions.logic.ts.
  const visible = rows.filter(
    (row) => (kind === 'all' || row.kind === kind) && (state !== 'open' || wiki === 'all' || row.space === wiki),
  )
  const filtered = kind !== 'all' || (state === 'open' && wiki !== 'all')
  const waitingLonger =
    state === 'open'
      ? visible.filter((row) => generatedAt - new Date(row.createdAt).getTime() >= AGING_DAYS * 86_400_000)
      : []
  const currentItems = visible.filter((row) => !waitingLonger.includes(row))
  const total = state === 'open' ? (open?.total ?? 0) : rows.length
  const oldestDays = state === 'open' ? (open?.oldestAgeDays ?? null) : (shelfQuery.data?.counts.oldest_days ?? null)
  const data = state === 'open' ? openData : shelfQuery.data

  return (
    <Page title="Decisions" description={t('page.decisions.description')}>
      <div
        className="flex w-full min-w-0 flex-col gap-6"
        data-testid="attention-list"
        data-total={total}
        data-capped={state === 'open' ? String(Boolean(open?.capped)) : 'false'}
      >
        {state !== 'open' && shelfQuery.data?.counts.overdue ? (
          <Alert tone="danger" title={t('decisions.overdueTitle')}>
            {t('decisions.overdueDescription', { count: shelfQuery.data.counts.overdue })}
          </Alert>
        ) : null}

        <section className="flex flex-col gap-3" aria-label={t('decisions.filters')}>
          <ToggleGroup
            type="single"
            value={state}
            onValueChange={(value) => value && setState(value as AttentionState)}
            variant="outline"
            size="sm"
            className="max-w-full flex-wrap justify-start"
          >
            {(Object.keys(STATE_KEYS) as AttentionState[]).map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                aria-label={t(STATE_KEYS[value])}
                data-testid={`decisions-state-${value}`}
              >
                {t(STATE_KEYS[value])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
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
          {state === 'open' && tallies.length ? (
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
            state={state}
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
          <section
            className="flex flex-col gap-3"
            aria-label={state === 'open' ? t('decisions.needsAttention') : t(STATE_KEYS[state])}
          >
            {currentItems.map((row, index) => (
              <AttentionCard key={decisionId(row)} row={row} testId={`decision-item-${index + 1}`} />
            ))}
          </section>
        ) : null}
      </div>
    </Page>
  )
}

function DecisionEmpty({
  state,
  filtered,
  onShowAll,
}: {
  state: AttentionState
  filtered: boolean
  onShowAll: () => void
}) {
  const { t } = useI18n()
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldCheck />
        </EmptyMedia>
        <EmptyTitle>
          {filtered
            ? t('decisions.empty.filtered')
            : state === 'open'
              ? t('decisions.empty.open')
              : t('decisions.empty.other')}
        </EmptyTitle>
        <EmptyDescription>{t('decisions.empty.description')}</EmptyDescription>
      </EmptyHeader>
      {filtered ? (
        <EmptyContent>
          <Button variant="outline" data-testid="decisions-empty-show-all" onClick={onShowAll}>
            {t('decisions.showAll')}
          </Button>
        </EmptyContent>
      ) : state === 'open' ? (
        <EmptyContent>
          <Button asChild>
            <Link to="/inbox" data-testid="decisions-empty-inbox">
              {t('decisions.openInbox')}
            </Link>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

/**
 * One position in the queue.
 *
 * The card takes a `QueueRow`, not a feed payload, because the open tab and the
 * shelves arrive on different endpoints with different shapes and a component
 * that knows about both would have to guess which one it got.
 *
 * `detail` is the per-wiki payload — origins, targets, the earlier rejection —
 * and the open tab does not have it: the installation-wide feed carries what a
 * queue needs to be read (wiki, kind, title, summary, age) and not what one row
 * needs to be JUDGED. So the row fetches it when somebody opens the panel,
 * which is the only place any of it is shown. One request per wiki, shared by
 * every open row in it, because react-query keys it by wiki rather than by row.
 */
function AttentionCard({ row, testId }: { row: QueueRow; testId: string }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const space = row.space
  const stateMutation = useMutation({
    mutationFn: (state: 'open' | 'deferred' | 'discarded') =>
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
      data-state={row.state}
      data-decision-key={row.key}
      data-space={row.space}
      data-testid={testId}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge tone={row.kind === 'proposal' ? 'accent' : 'neutral'}>{t(KIND_KEYS[row.kind])}</Badge>
          <Badge tone={row.state === 'open' ? 'warning' : 'neutral'}>{t(STATE_KEYS[row.state])}</Badge>
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
        <CardTitle>{row.title}</CardTitle>
        {row.summary ? <CardDescription>{row.summary}</CardDescription> : null}
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
        {row.kind === 'triage' && row.state === 'open' ? (
          <TriagePanel ingestId={row.key.slice('triage:'.length)} space={space} testId={`${testId}-triage`} />
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20">
        <TaskLink row={row} testId={testId} />
        {row.state === 'open' ? (
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
        ) : (
          <Button
            variant="outline"
            size="sm"
            data-testid={`${testId}-restore`}
            disabled={stateMutation.isPending}
            onClick={() => stateMutation.mutate('open')}
          >
            {t('decisions.restore')}
          </Button>
        )}
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
