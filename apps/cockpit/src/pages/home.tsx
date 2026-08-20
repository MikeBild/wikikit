import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { GLOBAL_ATTENTION_QUERY, bannerSubset, countOpenDecisions, type BannerSubset } from '@/pages/decisions.logic'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RelativeTime } from '@/components/ui/relative-time'
import { useI18n } from '@/lib/i18n-context'

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

        <section className="min-w-0" aria-labelledby="home-tasks-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="home-tasks-heading" className="text-base font-semibold">
              {t('home.compact.tasks')}
            </h2>
            {open ? (
              /*
                The same number the badge, the banner and the queue print, from
                the same call — `data-total` carries it as a number so a checker
                does not have to parse a sentence to find out whether the four
                surfaces agree.
              */
              <p className="text-sm text-muted-foreground" data-testid="home-task-summary">
                <span data-testid="zone-a-decisions-count" data-total={open.total}>
                  {t('home.compact.taskCount', { count: open.total })}
                </span>
                {' · '}
                {open.oldestAgeDays === null
                  ? t('home.compact.taskUndated')
                  : t('home.compact.taskOldest', { days: open.oldestAgeDays })}
              </p>
            ) : null}
          </div>

          {attention.isPending ? <p className="text-sm text-muted-foreground">{t('common.loading')}…</p> : null}
          {attention.isError ? <Alert tone="danger" title={t('home.compact.tasksError')} /> : null}
          {attention.data && attention.data.items.length === 0 ? (
            <p className="border-y py-4 text-sm text-muted-foreground">{t('home.compact.tasksEmpty')}</p>
          ) : null}
          {attention.data?.items.length ? (
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
                  {attention.data.items.map((task, index) => (
                    <TaskRow key={`${task.space}:${task.key}`} task={task} position={index + 1} />
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </section>
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

function TaskRow({ task, position }: { task: Task; position: number }) {
  const { t } = useI18n()
  const proposalId = task.kind === 'proposal' ? task.key.slice('proposal:'.length) : null
  const triageId = task.kind === 'triage' ? task.key.slice('triage:'.length) : null
  const action = proposalId ? (
    <Button asChild size="sm">
      <Link
        to="/decisions/proposals/$id"
        params={{ id: proposalId }}
        search={{ space: task.space }}
        data-testid={`home-task-${position}-action`}
      >
        {t('home.compact.reviewProposal')}
      </Link>
    </Button>
  ) : (
    <Button asChild size="sm">
      <Link
        to="/inbox"
        search={{ space: task.space, triage: triageId } as never}
        data-testid={`home-task-${position}-action`}
      >
        {t('home.compact.triageInbox')}
      </Link>
    </Button>
  )
  return (
    <TableRow data-testid={`home-task-${position}`}>
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
        <span className="block font-medium">{task.title}</span>
        {task.summary ? (
          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{task.summary}</span>
        ) : null}
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
