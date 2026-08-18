import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, BookOpen, CircleCheckBig, FolderKanban, Search } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { RelativeTime } from '@/components/ui/relative-time'
import { useI18n } from '@/lib/i18n-context'
import type { TranslationKey } from '@/lib/i18n'
import { useSpace } from '@/lib/space'

type AttentionResponse = Awaited<ReturnType<typeof wk.attention.list>>
type AttentionItem = AttentionResponse['items'][number]

interface HomeTask {
  key: string
  title: string
  description: string
  count: number
  href: string
  kind: AttentionItem['kind']
  createdAt: string | null
}

export function HomePage() {
  const space = useSpace()
  const navigate = useNavigate()
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const attention = useQuery({
    queryKey: keys.attention(space, { state: 'open', limit: 200 }),
    queryFn: () => wk.attention.list(space, { state: 'open', limit: 200 }),
  })
  const concepts = useQuery({
    queryKey: keys.concepts(space, { limit: 6 }),
    queryFn: () => wk.concepts.list(space, { limit: 6 }),
  })
  const overview = useQuery({ queryKey: keys.overview(), queryFn: () => wk.overview.get() })
  const tasks = useMemo(() => groupTasks(attention.data?.items ?? []), [attention.data?.items])
  const productionWikis = useMemo(
    () =>
      [...(overview.data?.items ?? [])]
        .filter((item) => item.environment === 'production')
        .sort(
          (left, right) =>
            (right.attention.oldest_days ?? -1) - (left.attention.oldest_days ?? -1) ||
            right.attention.open - left.attention.open ||
            left.name.localeCompare(right.name),
        ),
    [overview.data?.items],
  )

  function search(event: FormEvent) {
    event.preventDefault()
    const q = query.trim()
    if (!q) return
    void navigate({ to: '/search', search: (previous) => ({ ...previous, q }) })
  }

  return (
    <Page
      title={t('nav.home')}
      description={t('page.home.description')}
      actions={
        <Button asChild>
          <Link to="/decisions" data-testid="home-open-decisions">
            {t('home.openDecisions')}
          </Link>
        </Button>
      }
    >
      <div className="flex w-full max-w-5xl flex-col gap-8">
        <Card data-testid="home-all-wikis">
          <CardHeader className="border-b bg-muted/35">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FolderKanban /> {t('home.global.title')}
                </CardTitle>
                <CardDescription>{t('home.global.description')}</CardDescription>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link to="/spaces" data-testid="home-all-wikis-open">
                  {t('home.global.all')}
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {overview.isLoading ? <p className="text-sm text-muted-foreground">{t('home.global.loading')}</p> : null}
            {overview.isError ? <Alert tone="danger" title={t('home.global.error')} /> : null}
            {overview.data ? (
              <>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <GlobalFact label={t('home.global.production')} value={productionWikis.length} />
                  <GlobalFact
                    label={t('home.global.open')}
                    value={productionWikis.reduce((sum, item) => sum + item.attention.open, 0)}
                  />
                  <GlobalFact
                    label={t('home.global.oldest')}
                    value={globalOldest(
                      productionWikis.map((item) => item.attention.oldest_days),
                      t,
                    )}
                  />
                </dl>
                {productionWikis.some((item) => item.attention.open > 0) ? (
                  <div className="divide-y rounded-lg border" data-testid="home-wiki-attention">
                    {productionWikis
                      .filter((item) => item.attention.open > 0)
                      .slice(0, 5)
                      .map((item) => (
                        <Link
                          key={item.space}
                          to="/decisions"
                          search={{ space: item.space }}
                          className="flex min-w-0 items-center justify-between gap-4 p-3 hover:bg-muted"
                          data-testid={`home-wiki-${item.space}`}
                        >
                          <span className="min-w-0">
                            <strong className="block truncate text-sm">{item.name}</strong>
                            <span className="line-clamp-1 text-xs text-muted-foreground">
                              {item.purpose ?? t('home.global.noPurpose')}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-sm">
                            <Badge tone="warning">{item.attention.open}</Badge>
                            <span className="text-muted-foreground">
                              {globalOldest([item.attention.oldest_days], t)}
                            </span>
                            <ArrowRight />
                          </span>
                        </Link>
                      ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                    {t('home.global.empty')}
                  </p>
                )}
              </>
            ) : null}
          </CardContent>
        </Card>

        <div className="border-b pb-3" data-testid="home-current-wiki">
          <h2 className="text-base font-semibold">{t('home.current.title', { space })}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('home.current.description')}</p>
        </div>

        <Card className="overflow-hidden" data-testid="home-search">
          <CardHeader className="border-b bg-muted/35">
            <CardTitle className="flex items-center gap-2">
              <Search /> {t('home.search.title')}
            </CardTitle>
            <CardDescription>{t('home.search.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={search}>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('home.search.placeholder')}
                aria-label={t('home.search.placeholder')}
                data-testid="home-search-input"
              />
              <Button type="submit" disabled={!query.trim()} data-testid="home-search-submit">
                {t('home.search.action')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <section className="flex flex-col gap-3" aria-labelledby="home-attention-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="home-attention-heading" className="flex items-center gap-2 text-sm font-semibold">
                <CircleCheckBig /> {t('home.attention.title')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('home.attention.description')}</p>
            </div>
            {attention.data ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={attention.data.counts.overdue ? 'danger' : 'neutral'}>
                  {t('attention.openCount', { count: attention.data.counts.open })}
                </Badge>
                {attention.data.counts.oldest_days === null ? null : (
                  <span className="text-xs text-muted-foreground">
                    {t('attention.oldest', { count: attention.data.counts.oldest_days })}
                  </span>
                )}
              </div>
            ) : null}
          </div>
          {attention.isLoading ? <p className="text-sm text-muted-foreground">{t('common.loading')}…</p> : null}
          {attention.isError ? <Alert tone="danger" title={t('home.attention.error')} /> : null}
          {tasks.length ? (
            <div className="grid gap-3 lg:grid-cols-2" data-testid="home-attention-groups">
              {tasks.slice(0, 6).map((task, index) => (
                <Link
                  key={task.key}
                  to={task.href as never}
                  search
                  data-testid={`home-attention-${index + 1}`}
                  className="group flex min-w-0 items-center justify-between gap-4 rounded-xl border bg-card p-4 transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">{task.title}</strong>
                      {task.count > 1 ? <Badge tone="neutral">{task.count}</Badge> : null}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{task.description}</span>
                    <span className="mt-2 block text-xs text-muted-foreground">
                      {task.createdAt ? <RelativeTime value={task.createdAt} /> : '—'}
                    </span>
                  </span>
                  <ArrowRight className="shrink-0 transition-transform group-hover:translate-x-1" />
                </Link>
              ))}
            </div>
          ) : attention.data ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              {t('home.attention.empty')}
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="home-knowledge-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="home-knowledge-heading" className="flex items-center gap-2 text-sm font-semibold">
                <BookOpen /> {t('home.knowledge.title')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('home.knowledge.description')}</p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/pages" data-testid="home-all-pages">
                {t('home.knowledge.all')}
              </Link>
            </Button>
          </div>
          {concepts.isLoading ? <p className="text-sm text-muted-foreground">{t('common.loading')}…</p> : null}
          {concepts.isError ? <Alert tone="danger" title={t('home.attention.error')} /> : null}
          {concepts.data?.items.length ? (
            <div className="divide-y rounded-xl border bg-card" data-testid="home-knowledge-list">
              {concepts.data.items.map((concept, index) => (
                <Link
                  key={concept.slug}
                  to="/pages/$slug"
                  params={{ slug: concept.slug }}
                  search={(previous) => previous}
                  data-testid={`home-knowledge-${index + 1}`}
                  className="group flex min-w-0 items-center justify-between gap-4 p-4 first:rounded-t-xl last:rounded-b-xl hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="min-w-0">
                    <strong className="block truncate text-sm">{concept.title}</strong>
                    <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{concept.summary}</span>
                  </span>
                  <ArrowRight className="shrink-0 transition-transform group-hover:translate-x-1" />
                </Link>
              ))}
            </div>
          ) : concepts.data ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              {t('home.knowledge.empty')}
            </p>
          ) : null}
        </section>

        {attention.data?.recent_activity.length ? (
          <section className="flex flex-col gap-3" aria-labelledby="home-recent-heading">
            <h2 id="home-recent-heading" className="text-sm font-semibold">
              {t('home.recent.title')}
            </h2>
            <div className="flex flex-col divide-y rounded-xl border bg-card">
              {attention.data.recent_activity.slice(0, 5).map((item, index) => (
                <Link
                  key={item.key}
                  to={attentionHref(item) as never}
                  search
                  data-testid={`home-recent-${index + 1}`}
                  className="flex min-w-0 items-center justify-between gap-4 p-3 hover:bg-muted"
                >
                  <span className="truncate text-sm">{item.title}</span>
                  <Badge tone="success">{t('attention.state.decided')}</Badge>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </Page>
  )
}

function GlobalFact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-muted/45 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function globalOldest(
  values: readonly (number | null)[],
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string {
  const measured = values.filter((value): value is number => value !== null)
  if (!measured.length) return '—'
  const days = Math.max(...measured)
  if (days === 0) return t('time.today')
  return days === 1 ? t('time.oneDay') : t('time.days', { count: days })
}

function groupTasks(items: readonly AttentionItem[]): HomeTask[] {
  return items.map((item) => ({
    key: item.key,
    title: item.title,
    description: item.summary || item.effect,
    count: 1,
    href: attentionHref(item),
    kind: item.kind,
    createdAt: item.created_at,
  }))
}

function attentionHref(item: AttentionItem): string {
  if (item.kind === 'proposal') return `/decisions/proposals/${item.key.slice('proposal:'.length)}`
  return item.origins.find((origin) => origin.href)?.href ?? '/decisions'
}
