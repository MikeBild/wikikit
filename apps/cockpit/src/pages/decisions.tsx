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
import { useSpace } from '@/lib/space'
import type { TranslationKey } from '@/lib/i18n'
import { useI18n } from '@/lib/i18n-context'

type AttentionResponse = Awaited<ReturnType<typeof wk.attention.list>>
type AttentionItem = AttentionResponse['items'][number]
type AttentionState = 'open' | 'deferred' | 'discarded' | 'decided'
type AttentionKind = AttentionItem['kind']
type TriageSuggestion = NonNullable<Awaited<ReturnType<typeof wk.ingest.suggestTriage>>['suggestion']>

const STATE_KEYS: Record<AttentionState, TranslationKey> = {
  open: 'attention.state.open',
  deferred: 'attention.state.deferred',
  discarded: 'attention.state.discarded',
  decided: 'attention.state.decided',
}

const KIND_KEYS: Record<AttentionKind, TranslationKey> = {
  proposal: 'attention.kind.proposal',
  triage: 'attention.kind.triage',
  output: 'attention.kind.output',
}

export function DecisionsPage() {
  const space = useSpace()
  const { t } = useI18n()
  const [state, setState] = useState<AttentionState>('open')
  const [kind, setKind] = useState<AttentionKind | 'all'>('all')
  const queryArgs = { state, ...(kind === 'all' ? {} : { kind }), limit: 200 }
  const query = useQuery({
    queryKey: keys.attention(space, queryArgs),
    queryFn: () => wk.attention.list(space, queryArgs),
  })
  const data = query.data
  const waitingLonger =
    state === 'open' && data
      ? data.items.filter(
          (item) => new Date(data.generated_at).getTime() - new Date(item.created_at).getTime() >= 3 * 86_400_000,
        )
      : []
  const currentItems = data?.items.filter((item) => !waitingLonger.includes(item)) ?? []

  return (
    <Page title="Decisions" description={t('page.decisions.description')}>
      <div className="flex w-full max-w-[780px] flex-col gap-6" data-testid="attention-list">
        {data?.counts.overdue ? (
          <Alert tone="danger" title={t('decisions.overdueTitle')}>
            {t('decisions.overdueDescription', { count: data.counts.overdue })}
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
          {data ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Clock3 />
              <span>
                {data.counts.oldest_days == null
                  ? t('attention.noAge')
                  : t('attention.oldest', { count: data.counts.oldest_days })}
              </span>
              <Badge tone={data.counts.overdue ? 'danger' : data.counts.open ? 'warning' : 'success'}>
                {t('attention.openCount', { count: data.counts.open })}
              </Badge>
            </div>
          ) : null}
        </section>

        {query.isLoading ? <p className="text-sm text-muted-foreground">{t('decisions.loading')}</p> : null}
        {query.isError ? <Alert tone="danger" title={t('decisions.error')} /> : null}
        {data && data.items.length === 0 ? (
          <DecisionEmpty state={state} filtered={kind !== 'all'} onShowAll={() => setKind('all')} />
        ) : null}
        {waitingLonger.length ? (
          <section className="flex flex-col gap-3" aria-labelledby="decisions-waiting-longer">
            <h2 id="decisions-waiting-longer" className="text-sm font-semibold text-warning">
              {t('decisions.waitingLonger')}
            </h2>
            {waitingLonger.map((item, index) => (
              <AttentionCard key={item.key} item={item} space={space} testId={`decision-waiting-${index + 1}`} />
            ))}
          </section>
        ) : null}
        {currentItems.length ? (
          <section
            className="flex flex-col gap-3"
            aria-label={state === 'open' ? t('decisions.needsAttention') : t(STATE_KEYS[state])}
          >
            {currentItems.map((item, index) => (
              <AttentionCard key={item.key} item={item} space={space} testId={`decision-item-${index + 1}`} />
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

function AttentionCard({ item, space, testId }: { item: AttentionItem; space: string; testId: string }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const stateMutation = useMutation({
    mutationFn: (state: 'open' | 'deferred' | 'discarded') =>
      wk.attention.setState(space, item.key, {
        state,
        ...(state === 'deferred' ? { remind_at: new Date(Date.now() + 3 * 86_400_000).toISOString() } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.attention(space).slice(0, -1) }),
  })
  const proposalId = item.kind === 'proposal' ? item.key.slice('proposal:'.length) : null
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
    <Card data-kind={item.kind} data-state={item.state} data-testid={testId}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge tone={item.kind === 'proposal' ? 'accent' : 'neutral'}>{t(KIND_KEYS[item.kind])}</Badge>
          <Badge tone={item.state === 'open' ? 'warning' : 'neutral'}>{t(STATE_KEYS[item.state])}</Badge>
          <RelativeTime value={item.created_at} />
        </div>
        <CardTitle>{item.title}</CardTitle>
        {item.summary ? <CardDescription>{item.summary}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{t(attentionEffectKey(item.kind))}</p>
        <DecisionTrace item={item} />
        {item.previous_rejection ? (
          <Alert tone="warning" title={t('decisions.previousRejection')}>
            {item.previous_rejection.note || t('decisions.previousRejectionNoNote')}
          </Alert>
        ) : null}
        {proposalId ? (
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm" aria-expanded={expanded} data-testid={`${testId}-preview-toggle`}>
                <ChevronDown data-icon="inline-start" />
                {expanded ? t('decisions.hideEvidence') : t('decisions.showEvidence')}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 flex flex-col gap-3">
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
        ) : null}
        {item.kind === 'triage' && item.state === 'open' ? (
          <TriagePanel ingestId={item.key.slice('triage:'.length)} space={space} testId={`${testId}-triage`} />
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20">
        <TaskLink item={item} testId={testId} />
        {item.state === 'open' ? (
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

function TaskLink({ item, testId }: { item: AttentionItem; testId: string }) {
  const { t } = useI18n()
  if (item.kind === 'triage') return <span className="text-xs text-muted-foreground">{t('decisions.sortAbove')}</span>
  const href =
    item.kind === 'proposal'
      ? `/decisions/proposals/${item.key.slice('proposal:'.length)}`
      : item.origins.find((origin) => origin.href)?.href
  if (!href) return null
  return (
    <Button asChild size="sm">
      <Link to={href as never} search data-testid={`${testId}-open-target`}>
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

function DecisionTrace({ item }: { item: AttentionItem }) {
  const { t } = useI18n()
  return (
    <dl className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2" data-testid="decision-trace">
      <div className="min-w-0">
        <dt className="text-xs font-medium text-muted-foreground">{t('decisions.origin')}</dt>
        <dd className="mt-1 flex flex-col gap-1.5">
          {item.origins.length ? (
            item.origins.map((origin, index) => (
              <span key={`${origin.href}-${index}`} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <Link
                  to={origin.href as never}
                  className="truncate underline-offset-4 hover:underline"
                  data-testid={`decision-origin-${index + 1}`}
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
                    data-testid={`decision-target-${index + 1}`}
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
