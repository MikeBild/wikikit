import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Clock3, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { I18nText } from '@/components/i18n-text'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { RelativeTime } from '@/components/ui/relative-time'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useSpace } from '@/lib/space'
import { useI18n } from '@/lib/i18n-context'
import { lintMessage } from '@/pages/care.logic'

type AttentionResponse = Awaited<ReturnType<typeof wk.attention.list>>
type AttentionItem = AttentionResponse['items'][number]
type AttentionState = 'open' | 'deferred' | 'discarded' | 'decided'
type AttentionKind = 'proposal' | 'triage' | 'output' | 'care'
type TriageSuggestion = NonNullable<Awaited<ReturnType<typeof wk.ingest.suggestTriage>>['suggestion']>

const STATE_LABELS: Record<AttentionState, string> = {
  open: 'Open',
  deferred: 'Deferred',
  discarded: 'Discarded',
  decided: 'Decided',
}

const KIND_LABELS: Record<AttentionKind, string> = {
  proposal: 'Proposal',
  triage: 'Triage',
  output: 'Output',
  care: 'Care',
}

export function DecisionsPage() {
  const space = useSpace()
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
    <Page
      title="Decisions"
      description="Everything waiting for a person: sort captures, review proposals, file useful outputs and act on care findings."
    >
      {data?.counts.overdue ? (
        <Alert tone="danger" title="A reminder is overdue">
          {data.counts.overdue} deferred item{data.counts.overdue === 1 ? '' : 's'} reached their reminder time.
        </Alert>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Decision filters">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ToggleGroup
            type="single"
            value={state}
            onValueChange={(value) => value && setState(value as AttentionState)}
            variant="outline"
            size="sm"
          >
            {(Object.keys(STATE_LABELS) as AttentionState[]).map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                aria-label={STATE_LABELS[value]}
                data-testid={`decisions-state-${value}`}
              >
                {STATE_LABELS[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {data ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock3 />
              <span>
                {data.counts.oldest_days == null ? 'Nothing waiting' : `Oldest: ${data.counts.oldest_days} days`}
              </span>
              <Badge tone={data.counts.overdue ? 'danger' : data.counts.open ? 'warning' : 'success'}>
                {data.counts.open} open
              </Badge>
            </div>
          ) : null}
        </div>
        <ToggleGroup
          type="single"
          value={kind}
          onValueChange={(value) => value && setKind(value as AttentionKind | 'all')}
          variant="outline"
          size="sm"
          className="max-w-full flex-wrap"
        >
          <ToggleGroupItem value="all" data-testid="decisions-kind-all">
            Everything
          </ToggleGroupItem>
          {(Object.keys(KIND_LABELS) as AttentionKind[]).map((value) => (
            <ToggleGroupItem key={value} value={value} data-testid={`decisions-kind-${value}`}>
              {KIND_LABELS[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </section>

      {query.isLoading ? <p className="text-sm text-muted-foreground">Loading decisions…</p> : null}
      {query.isError ? <Alert tone="danger" title="Decisions could not be loaded" /> : null}
      {data && data.items.length === 0 ? (
        <DecisionEmpty state={state} filtered={kind !== 'all'} onShowAll={() => setKind('all')} />
      ) : null}

      <div className="mx-auto flex w-full max-w-[780px] flex-col gap-6" data-testid="attention-list">
        {waitingLonger.length ? (
          <section className="flex flex-col gap-3" aria-labelledby="decisions-waiting-longer">
            <h2 id="decisions-waiting-longer" className="text-sm font-semibold text-warning">
              Waiting longer
            </h2>
            {waitingLonger.map((item) => (
              <AttentionCard key={item.key} item={item} space={space} />
            ))}
          </section>
        ) : null}
        {currentItems.length ? (
          <section
            className="flex flex-col gap-3"
            aria-label={state === 'open' ? 'Needs attention' : STATE_LABELS[state]}
          >
            {currentItems.map((item) => (
              <AttentionCard key={item.key} item={item} space={space} />
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
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldCheck />
        </EmptyMedia>
        <EmptyTitle>
          {filtered
            ? 'Nothing matches these filters'
            : state === 'open'
              ? 'Nothing needs a decision'
              : `No ${STATE_LABELS[state].toLowerCase()} items`}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? 'Show every kind to see the whole shelf.'
            : state === 'open'
              ? 'Capture a thought in the Inbox or run a care check. New work will appear here.'
              : 'Choose another shelf to continue.'}
        </EmptyDescription>
      </EmptyHeader>
      {filtered ? (
        <EmptyContent>
          <Button variant="outline" data-testid="decisions-empty-show-all" onClick={onShowAll}>
            Show every kind
          </Button>
        </EmptyContent>
      ) : state === 'open' ? (
        <EmptyContent>
          <Button asChild>
            <Link to="/inbox" data-testid="decisions-empty-inbox">
              Open Inbox
            </Link>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

function AttentionCard({ item, space }: { item: AttentionItem; space: string }) {
  const { locale } = useI18n()
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
  const careRule = item.kind === 'care' && item.summary.startsWith('Rule: ') ? item.summary.slice(6) : null
  const title = careRule
    ? lintMessage(locale, { rule: careRule, message: { key: careRule, args: {}, default_text: item.title } })
    : item.title

  return (
    <Card data-kind={item.kind} data-state={item.state}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={item.kind === 'care' ? 'warning' : item.kind === 'proposal' ? 'accent' : 'neutral'}>
            {KIND_LABELS[item.kind]}
          </Badge>
          <RelativeTime value={item.created_at} />
        </div>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{item.summary || item.effect}</CardDescription>
        <CardAction>
          <Badge tone={item.state === 'open' ? 'warning' : 'neutral'}>{STATE_LABELS[item.state]}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{item.effect}</p>
        {item.previous_rejection ? (
          <Alert tone="warning" title="An identical proposal was rejected before">
            {item.previous_rejection.note || 'The previous review did not include a note.'}
          </Alert>
        ) : null}
        {proposalId ? (
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm" aria-expanded={expanded} data-testid="decision-preview-toggle">
                <ChevronDown data-icon="inline-start" />
                {expanded ? 'Hide diff' : 'Show diff and evidence'}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 flex flex-col gap-3">
              {proposal.isLoading || lint.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading diff…</p>
              ) : null}
              {proposal.data?.concepts.map((concept) => (
                <div key={concept.slug} className="grid gap-3 md:grid-cols-2">
                  <DiffBlock label="Before" value={concept.old_markdown ?? 'New page'} />
                  <DiffBlock label="After" value={concept.new_markdown} />
                </div>
              ))}
              {proposal.data?.sources.map((source) => (
                <div key={source.id} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge tone="unknown">Source locked</Badge>
                  <span>{source.title}</span>
                </div>
              ))}
              {lint.data ? (
                <p className="text-xs text-muted-foreground">
                  Check: {lint.data.counts.error} errors, {lint.data.counts.warn} warnings
                </p>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {item.kind === 'triage' && item.state === 'open' ? (
          <TriagePanel ingestId={item.key.slice('triage:'.length)} space={space} />
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-2">
        <TaskLink item={item} />
        <div className="flex flex-wrap gap-2">
          {item.state === 'open' ? (
            <>
              <Button
                variant="outline"
                size="sm"
                data-testid="decision-defer"
                onClick={() => stateMutation.mutate('deferred')}
              >
                Remind in 3 days
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="decision-remove"
                onClick={() => stateMutation.mutate('discarded')}
              >
                Remove from queue
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              data-testid="decision-restore"
              onClick={() => stateMutation.mutate('open')}
            >
              Return to open
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  )
}

function TriagePanel({ ingestId, space }: { ingestId: string; space: string }) {
  const suggestion = useQuery({
    queryKey: keys.triage(ingestId),
    queryFn: () => wk.ingest.suggestTriage(ingestId),
  })
  if (suggestion.isLoading) return <p className="text-sm text-muted-foreground">Preparing a sorting suggestion…</p>
  if (suggestion.isError || !suggestion.data?.suggestion)
    return <Alert tone="danger" title="No sorting suggestion is available" />
  return (
    <TriageForm
      key={suggestion.data.suggestion.generated_at}
      ingestId={ingestId}
      space={space}
      suggestion={suggestion.data.suggestion}
    />
  )
}

function TriageForm({
  ingestId,
  space,
  suggestion,
}: {
  ingestId: string
  space: string
  suggestion: TriageSuggestion
}) {
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
          Title
          <Input data-testid="triage-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Target wiki
          <Input data-testid="triage-target" value={target} onChange={(event) => setTarget(event.target.value)} />
        </label>
      </div>
      <label className="grid gap-1 text-xs font-medium">
        Summary
        <Textarea data-testid="triage-summary" value={summary} onChange={(event) => setSummary(event.target.value)} />
      </label>
      <label className="grid gap-1 text-xs font-medium">
        Question to keep open
        <Textarea
          data-testid="triage-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid="triage-process"
          disabled={!title || resolve.isPending}
          onClick={() => resolve.mutate('process')}
        >
          Process here
        </Button>
        {duplicate ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="triage-use-existing"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate('use_existing')}
          >
            Use existing source
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          data-testid="triage-leave"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate('leave')}
        >
          Leave open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="triage-discard"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate('discard')}
        >
          Discard capture
        </Button>
      </div>
    </div>
  )
}

function TaskLink({ item }: { item: AttentionItem }) {
  if (item.kind === 'triage') return <span className="text-xs text-muted-foreground">Resolve above</span>
  if (item.kind === 'proposal') {
    return (
      <Button asChild size="sm">
        <Link
          to="/decisions/proposals/$id"
          params={{ id: item.key.slice('proposal:'.length) }}
          data-testid="decision-open-review"
        >
          <I18nText>Open review</I18nText>
        </Link>
      </Button>
    )
  }
  if (item.kind === 'output') {
    return (
      <Button asChild size="sm">
        <Link to="/answers/$id" params={{ id: item.key.slice('output:'.length) }} data-testid="decision-open-output">
          <I18nText>Open output</I18nText>
        </Link>
      </Button>
    )
  }
  return (
    <Button asChild size="sm">
      <Link to="/care" data-testid="decision-open-care">
        <I18nText>Open care</I18nText>
      </Link>
    </Button>
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
