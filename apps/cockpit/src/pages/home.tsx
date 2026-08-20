import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import {
  GLOBAL_ATTENTION_QUERY,
  bannerSubset,
  countOpenDecisions,
  dedupe,
  summaryLine,
  type BannerSubset,
} from '@/pages/decisions.logic'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RelativeTime } from '@/components/ui/relative-time'
import { useI18n } from '@/lib/i18n-context'
import { readableTitle } from '@/lib/presentation'

import type { TranslationKey } from '@/lib/i18n'

type GlobalAttention = Awaited<ReturnType<typeof wk.attention.global>>
type Task = GlobalAttention['items'][number]

export function HomePage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const attention = useQuery({
    queryKey: keys.globalAttention(GLOBAL_ATTENTION_QUERY),
    queryFn: () => wk.attention.global(GLOBAL_ATTENTION_QUERY),
  })

  // Measured against the response's own `generated_at`, not against the
  // browser clock: the queue page ages its rows the same way, and two surfaces
  // that disagree about what "three days" means produce two different rubrics
  // from one set of rows.
  const open = attention.data
    ? countOpenDecisions({
        items: attention.data.items,
        counts: attention.data.counts,
        nowMs: new Date(attention.data.generated_at).getTime(),
      })
    : null
  const incident = open ? bannerSubset(open) : null
  /*
    The SAME deduplicated list the counter above was computed from (§8.1/§1).

    `countOpenDecisions` folds the feed by `space:key` before it counts,
    because the feed repeats itself in production — a retry, a cursor overlap,
    two synthesis runs on one source. The rows underneath used to be rendered
    from `attention.data.items` unfolded, so the head said „6 offen" and the
    table showed seven lines with one position twice. A card whose head and
    body disagree about the same set is worse than a wrong number: nothing
    looks broken, and the reader is the one who has to notice.

    The decisions queue has always deduplicated. This is the same call.
  */
  const tasks = attention.data ? dedupe(attention.data.items) : []

  function search(event: FormEvent) {
    event.preventDefault()
    const q = query.trim()
    if (!q) return
    void navigate({ to: '/search', search: { q, scope: 'all' } as never })
  }

  return (
    <Page title={t('nav.home')} description={t('page.home.description')}>
      <div className="flex min-w-0 flex-col gap-8">
        {incident ? <IncidentBanner subset={incident} /> : null}

        <form className="flex max-w-4xl flex-col gap-2 sm:flex-row" onSubmit={search} data-testid="home-search">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('home.compact.searchPlaceholder')}
              aria-label={t('home.compact.searchPlaceholder')}
              data-testid="home-search-input"
            />
          </div>
          <Button type="submit" disabled={!query.trim()} data-testid="home-search-submit">
            {t('home.compact.searchAction')}
          </Button>
        </form>

        {/*
          Zone A (§1): every human gate in ONE card — the count in the head, the
          age of the oldest position beside it, and one action per row. Amber
          from one, and the card is the short form of the decisions page rather
          than a second place to decide: it shows the top of the same queue and
          links there.

          The table did not go away, it moved INSIDE. It was already the right
          content; what it lacked was a head that answered "how much and how
          old" before a reader started reading rows.
        */}
        <Card
          data-testid="zone-a"
          data-total={open?.total ?? 0}
          className={open?.total ? 'border-warning/40' : undefined}
        >
          <CardHeader className="gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <CardTitle id="home-tasks-heading">{t('home.zoneA.title')}</CardTitle>
              {open ? (
                <p className="text-sm text-muted-foreground">
                  {/*
                    No counter without a link (§1) — so the counter IS the link.
                    `data-total` carries the number as a number, so a checker
                    comparing the four surfaces does not have to parse a
                    sentence to find it.
                  */}
                  <Link
                    to="/decisions"
                    data-testid="zone-a-decisions-count"
                    data-total={open.total}
                    className="underline underline-offset-4"
                  >
                    <Badge tone={open.total ? 'warning' : 'success'}>
                      {t('home.compact.taskCount', { count: open.total })}
                    </Badge>
                  </Link>
                  {' · '}
                  {open.oldestAgeDays === null
                    ? t('home.compact.taskUndated')
                    : t('home.compact.taskOldest', { days: open.oldestAgeDays })}
                </p>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="min-w-0">
            {attention.isPending ? <p className="text-sm text-muted-foreground">{t('common.loading')}…</p> : null}
            {attention.isError ? <Alert tone="danger" title={t('home.compact.tasksError')} /> : null}
            {attention.data && tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('home.compact.tasksEmpty')}</p>
            ) : null}
            {tasks.length ? (
              <div className="overflow-hidden rounded-lg border" data-testid="home-task-table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="hidden lg:table-cell">{t('home.compact.columnWiki')}</TableHead>
                      <TableHead>{t('home.compact.columnTask')}</TableHead>
                      <TableHead className="hidden md:table-cell">{t('home.compact.columnType')}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t('home.compact.columnWaiting')}</TableHead>
                      <TableHead className="w-44 min-w-44 whitespace-nowrap text-right">
                        <span className="sr-only">{t('home.compact.columnAction')}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.map((task, index) => (
                      <TaskRow key={`${task.space}:${task.key}`} task={task} position={index + 1} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}

const SUBSET_KEYS: Record<BannerSubset['kind'], TranslationKey> = {
  blocking: 'home.incident.blocking',
  overdue: 'home.incident.overdue',
  aging: 'home.incident.aging',
  open: 'home.incident.open',
}

/**
 * §8.7's banner: red, above every tile on the overview, and not dismissible.
 *
 * Not dismissible is the whole point, so it is stated by omission rather than
 * by a prop — `Alert` only lets `info` be closed. A banner an operator can wave
 * away is a banner that is gone on the morning it matters, and "the dashboard
 * said nothing" is indistinguishable from "nothing was wrong".
 *
 * Exactly one link, and it goes to the decisions page. Two links would make the
 * banner a menu, and a banner that offers a choice is one an operator reads
 * twice before doing anything.
 */
function IncidentBanner({ subset }: { subset: BannerSubset }) {
  const { t } = useI18n()
  // "mindestens" outranks "alle": a short list cannot honestly claim to have
  // seen every position, so the hedge wins over the stronger sentence.
  const key: TranslationKey =
    subset.kind === 'aging' && subset.capped
      ? 'home.incident.agingCapped'
      : subset.kind === 'aging' && subset.all
        ? 'home.incident.agingAll'
        : SUBSET_KEYS[subset.kind]
  return (
    <Alert tone="danger" data-testid="incident-banner" title={t('home.incident.title', { total: subset.total })}>
      <span
        data-testid="incident-decisions-count"
        data-subset={subset.kind}
        data-subset-count={subset.count}
        data-subset-total={subset.total}
      >
        {t(key, { count: subset.count, total: subset.total })}
      </span>{' '}
      <Link to="/decisions" className="underline underline-offset-4" data-testid="incident-decisions-link">
        {t('home.incident.link')}
      </Link>
    </Alert>
  )
}

/**
 * Where a waiting task is dealt with — stated once, rendered twice.
 *
 * A proposal is reviewed on its own page; an unsorted capture is sorted in the
 * inbox. Two destinations, and the row needs both of them in two places (the
 * title and the button), which is exactly the arrangement where they drift
 * apart and a title quietly stops matching the button beside it.
 */
function TaskTarget({
  task,
  children,
  className,
  'data-testid': testId,
}: {
  task: Task
  children: ReactNode
  className?: string
  'data-testid': string
}) {
  const proposalId = task.kind === 'proposal' ? task.key.slice('proposal:'.length) : null
  if (proposalId) {
    return (
      <Link
        to="/decisions/proposals/$id"
        params={{ id: proposalId }}
        search={{ space: task.space }}
        className={className}
        data-testid={testId}
      >
        {children}
      </Link>
    )
  }
  return (
    <Link
      to="/inbox"
      search={{ space: task.space, triage: task.key.slice('triage:'.length) } as never}
      className={className}
      data-testid={testId}
    >
      {children}
    </Link>
  )
}

function TaskRow({ task, position }: { task: Task; position: number }) {
  const { t, date } = useI18n()
  // §5 — a row is named by what it is about, not by the identifier the source
  // happened to carry. The date takes over the job the identifier was doing
  // badly: telling one ingested session from the next.
  const title = readableTitle(task.title, t('decisions.untitled'))
  const summary = summaryLine(task.summary, t)
  const proposalId = task.kind === 'proposal' ? task.key.slice('proposal:'.length) : null
  /*
    §1 — one action per row, and the row itself leads there.

    `TaskTarget` states the destination once and both the title and the button
    render through it. A row whose only way in is a button on the far right is
    a row people click at and miss; the title is what they aim for.
  */
  const action = (
    <Button asChild size="sm">
      <TaskTarget task={task} data-testid={`home-task-${position}-action`}>
        {proposalId ? t('home.compact.reviewProposal') : t('home.compact.triageInbox')}
      </TaskTarget>
    </Button>
  )
  return (
    /*
      The identity of the position, on the row (§8.1/§1).

      Named exactly like the queue's rows so one assert can hold both to the
      same rule: the card's line count equals the counter in its head, and the
      keys are distinct. Before this the check compared only NUMBERS across the
      four surfaces, which is why a card that rendered a duplicate line under a
      correct counter passed it.
    */
    <TableRow data-testid={`home-task-${position}`} data-space={task.space} data-decision-key={task.key}>
      <TableCell className="hidden max-w-36 align-top lg:table-cell">
        <Link
          to="/"
          search={{ space: task.space }}
          className="block min-w-0 underline-offset-4 hover:underline"
          data-testid={`home-task-${position}-wiki`}
        >
          <span className="block truncate font-medium">{task.space_name}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">{task.space}</span>
        </Link>
      </TableCell>
      <TableCell className="min-w-0 align-top whitespace-normal">
        <span className="mb-0.5 block truncate text-xs text-muted-foreground lg:hidden">{task.space_name}</span>
        <TaskTarget
          task={task}
          className="block font-medium underline-offset-4 hover:underline"
          data-testid={`home-task-${position}-open`}
        >
          {title.text}
          {title.redacted ? ` · ${date(task.created_at)}` : ''}
        </TaskTarget>
        {summary ? <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{summary}</span> : null}
      </TableCell>
      <TableCell className="hidden align-top md:table-cell">
        <Badge tone="neutral">
          {task.kind === 'proposal' ? t('home.compact.typeProposal') : t('home.compact.typeTriage')}
        </Badge>
      </TableCell>
      <TableCell className="hidden align-top text-sm text-muted-foreground lg:table-cell">
        <RelativeTime value={task.created_at} />
      </TableCell>
      <TableCell className="w-44 min-w-44 align-top whitespace-nowrap text-right">{action}</TableCell>
    </TableRow>
  )
}
