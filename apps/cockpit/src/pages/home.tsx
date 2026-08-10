import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleCheck, Telescope } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DataState, RowSkeleton } from '@/components/data-state'
import { EmptyState } from '@/components/empty-state'
import { I18nText } from '@/components/i18n-text'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { RelativeTime } from '@/components/ui/relative-time'
import { Skeleton } from '@/components/ui/skeleton'
import { useSpace } from '@/lib/space'
import { useI18n } from '@/lib/i18n-context'
import { semanticLabel } from '@/lib/presentation'
import {
  averageSeconds,
  changeStanding,
  count,
  durationHours,
  measured,
  staleShare,
  windowLabel,
} from '@/pages/home.logic'

/**
 * The wiki's front page — a FRONT PAGE, not a dashboard.
 *
 * The difference is not decoration. A dashboard answers "how is the system
 * doing"; a front page answers the three questions somebody actually arrives
 * with: what has this wiki learned lately, what is waiting for a person, and
 * where is its knowledge thin. Everything here is one of those three, and the
 * numbers that belong to the installation rather than to the knowledge —
 * request rates, token spend, webhook delivery — live on System, where an
 * operator goes on purpose.
 *
 * Five independent reads, five independent `DataState`s, deliberately NOT one.
 * A single combined query would let the slowest endpoint hold the whole page
 * blank, and — worse — let one refusal blank four surfaces that were answering
 * fine. Coverage in particular is the endpoint most likely to say no, and a
 * reviewer must still be able to see what is waiting for them when it does.
 *
 * No chart. This console vendors no chart library, and the three questions above
 * are answered by counts and a list; a sparkline of "concepts created per hour"
 * would be the first thing on the page that nobody could act on.
 */

/**
 * Five is a GLANCE, not a page of the queue.
 *
 * The front page's job is to say that something is waiting and who it is
 * waiting on; the queue itself is `/changes`, which has the filters, the
 * columns and the address bar to hold them. A twenty-row list here would be a
 * second, worse review queue that nobody could link to.
 */
const WAITING_QUERY = { status: 'pending', limit: 5 } as const

/**
 * How far back "lately" reaches on this page.
 *
 * Coverage takes a required window because a disputed-claim count or a median
 * review latency means nothing without a stated period. Thirty days is long
 * enough that a quiet fortnight does not read as a dead wiki, and short enough
 * that a number here is about now — and the window is printed beside the
 * figures rather than left for the reader to assume.
 */
const COVERAGE_DAYS = 30

export function HomePage() {
  const space = useSpace()
  const { text } = useI18n()

  // Pinned to the hour, not to `now`: a fresh millisecond on every render is a
  // fresh query key, and the front page would refetch its coverage forever.
  const window = useMemo(() => {
    const to = new Date()
    to.setUTCMinutes(0, 0, 0)
    const from = new Date(to.getTime() - COVERAGE_DAYS * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [])

  const knowledge = useQuery({ queryKey: keys.stats(space, 'knowledge'), queryFn: () => wk.stats.knowledge(space) })
  const reviews = useQuery({ queryKey: keys.stats(space, 'reviews'), queryFn: () => wk.stats.reviews(space) })
  const ingests = useQuery({ queryKey: keys.stats(space, 'ingests'), queryFn: () => wk.stats.ingests(space) })
  const coverage = useQuery({
    queryKey: [...keys.stats(space, 'coverage'), window],
    queryFn: () => wk.stats.coverage(space, window),
  })
  const waiting = useQuery({
    queryKey: keys.changes(space, WAITING_QUERY),
    queryFn: () => wk.changes.list(space, WAITING_QUERY),
  })

  return (
    <Page
      // The heading is the wiki, not the word "Home". A reader who opens a
      // pasted link has to be able to tell which of several wikis they landed
      // in without hunting for the sidebar, and on a phone the sidebar is
      // closed.
      title={space}
      description="What this wiki learned lately, what is waiting for a reviewer, and where its knowledge is thin."
      actions={
        <Button asChild>
          <Link to="/changes" search={(prev) => prev} data-testid="home-open-changes">
            Review changes
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <DataState query={knowledge} skeleton={<StripSkeleton />}>
          {(stats) => {
            const when = windowLabel(stats.from, stats.to)
            return (
              <section className="flex flex-col gap-2" aria-label="What changed lately">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat testId="stat-pages" label="Pages created" value={count(stats.totals.concepts_created)} />
                  <Stat testId="stat-revisions" label="Page revisions" value={count(stats.totals.revisions_created)} />
                  <Stat
                    testId="stat-sources"
                    label="Sources archived"
                    value={count(stats.totals.sources_created)}
                    hint={`${count(stats.totals.citations_created)} quotes cited`}
                  />
                  <Stat
                    testId="stat-approved"
                    label="Changes approved"
                    value={count(stats.totals.proposals_approved)}
                    hint={`${count(stats.totals.proposals_created)} submitted · ${count(stats.totals.proposals_rejected)} rejected`}
                  />
                </div>
                {when ? (
                  <p className="text-muted-foreground text-xs" data-testid="stat-window">
                    {text(`In ${when}.`)}
                  </p>
                ) : null}
              </section>
            )
          }}
        </DataState>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card data-testid="waiting-card">
            <CardHeader>
              <CardTitle>Waiting for review</CardTitle>
              <CardDescription>Nothing becomes visible knowledge until a person approves it.</CardDescription>
            </CardHeader>
            <CardContent>
              <DataState
                query={waiting}
                skeleton={<RowSkeleton rows={5} columns={2} />}
                isEmpty={(data) => data.items.length === 0}
                empty={
                  // An empty queue is GOOD NEWS and must not read like a
                  // failure (CUI-LOAD-4), and it needs no action: the way to
                  // fill it is to write knowledge, which is another page's job.
                  <EmptyState
                    icon={CircleCheck}
                    framed={false}
                    title="Nothing is waiting"
                    description="Every change proposed in this wiki has been decided."
                    data-testid="waiting-empty"
                  />
                }
              >
                {(data) => (
                  <ul className="flex flex-col gap-0.5">
                    {data.items.map((item) => {
                      const standing = changeStanding(item.status, item.changes_requested)
                      return (
                        <li key={item.id}>
                          <Link
                            to="/changes/$id"
                            params={{ id: item.id }}
                            search={(prev) => prev}
                            data-testid={`waiting-change-${item.id}`}
                            className="hover:bg-muted focus-visible:ring-ring/50 flex flex-col gap-1 rounded-md px-2 py-1.5 transition-colors focus-visible:ring-3 focus-visible:outline-none sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                          >
                            <span className="min-w-0 truncate text-sm font-medium">
                              {semanticLabel([item.title], 'Knowledge change')}
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              <Badge tone={standing.tone}>{standing.label}</Badge>
                              <RelativeTime value={item.created_at} className="text-muted-foreground text-xs" />
                            </span>
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </DataState>
            </CardContent>
            <CardFooter>
              <Link
                to="/changes"
                search={(prev) => prev}
                data-testid="waiting-all"
                className="text-sm underline-offset-4 hover:underline"
              >
                All changes
              </Link>
            </CardFooter>
          </Card>

          <Card data-testid="coverage-card">
            <CardHeader>
              <CardTitle>Where the knowledge is thin</CardTitle>
              <CardDescription>
                Claims somebody disputed, pages nobody has revisited, and how long a change waits.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataState query={coverage} skeleton={<FactsSkeleton facts={3} />}>
                {(data) => (
                  <div className="flex flex-col gap-4">
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Fact
                        testId="coverage-disputed"
                        label="Disputed claims"
                        value={count(data.disputed.open)}
                        hint={
                          data.disputed.oldest_days === null
                            ? 'none open'
                            : `oldest ${count(Math.round(data.disputed.oldest_days))} days`
                        }
                      />
                      <Fact
                        testId="coverage-stale"
                        label="Untouched 90 days"
                        value={staleShare(data.freshness.concepts, data.freshness.stale_over_90d)}
                        hint={`${count(data.freshness.stale_over_90d)} of ${count(data.freshness.concepts)} pages`}
                      />
                      <Fact
                        testId="coverage-latency"
                        label="Median time to decide"
                        value={durationHours(data.review_latency.median_hours)}
                        hint={`${count(data.review_latency.decided)} decided`}
                      />
                    </dl>
                    <GapTopics gaps={data.gap_topics} />
                  </div>
                )}
              </DataState>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card data-testid="ingests-card">
            <CardHeader>
              <CardTitle>Documents coming in</CardTitle>
              <CardDescription>Every page here is written from an archived document.</CardDescription>
            </CardHeader>
            <CardContent>
              <DataState query={ingests} skeleton={<FactsSkeleton facts={3} />}>
                {(data) => (
                  <dl className="grid grid-cols-3 gap-3">
                    <Fact testId="ingest-created" label="Submitted" value={count(data.totals.jobs.created)} />
                    <Fact
                      testId="ingest-done"
                      label="Finished"
                      value={count(data.totals.jobs.done)}
                      hint={`${averageSeconds(data.totals.duration_seconds)} each`}
                    />
                    <Fact testId="ingest-failed" label="Failed" value={count(data.totals.jobs.failed)} />
                  </dl>
                )}
              </DataState>
            </CardContent>
          </Card>

          <Card data-testid="reviews-card">
            <CardHeader>
              <CardTitle>Reviewing</CardTitle>
              <CardDescription>
                What reviewers did here — through this console, the API and agents alike.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataState
                query={reviews}
                skeleton={<FactsSkeleton facts={2} />}
                isEmpty={(data) => data.totals.length === 0}
                empty={
                  <EmptyState
                    icon={Telescope}
                    framed={false}
                    title="No review activity"
                    description="Nobody opened or decided a change in this window."
                    data-testid="reviews-empty"
                  />
                }
              >
                {(data) => {
                  // `totals` is an ARRAY because the endpoint can group by a
                  // dimension; ungrouped it holds exactly one row. Reading
                  // `[0]` through `measured` rather than asserting it means a
                  // window the server grouped away renders as unmeasured
                  // instead of crashing the front page.
                  const totals = data.totals[0]
                  return (
                    <dl className="grid grid-cols-2 gap-3">
                      <Fact
                        testId="review-actions"
                        label="Changes opened or decided"
                        value={count(measured(totals?.metrics.calls))}
                      />
                      <Fact
                        testId="review-actors"
                        label="People doing it"
                        value={count(measured(totals?.metrics.unique_actors))}
                      />
                    </dl>
                  )
                }}
              </DataState>
            </CardContent>
          </Card>
        </div>
      </div>
    </Page>
  )
}

/**
 * The questions readers asked that this wiki could not answer.
 *
 * `enabled: false` is not emptiness and is not a failure — it is a capability
 * the deployment never switched on, and saying "no gaps" there would be the
 * console reporting a clean result for a measurement nobody took.
 */
function GapTopics({ gaps }: { gaps: { enabled: boolean; items: readonly { lexeme: string; count: number }[] } }) {
  if (!gaps.enabled)
    return (
      <I18nText>
        <p className="text-muted-foreground text-xs" data-testid="coverage-gaps-off">
          Unanswered-question tracking is switched off in this deployment.
        </p>
      </I18nText>
    )
  if (gaps.items.length === 0)
    return (
      <I18nText>
        <p className="text-muted-foreground text-xs" data-testid="coverage-gaps-none">
          Every question readers asked found an answer.
        </p>
      </I18nText>
    )
  return (
    <I18nText>
      <div className="flex flex-col gap-1.5" data-testid="coverage-gaps">
        <p className="text-muted-foreground text-xs">Asked for, not answered</p>
        <div className="flex flex-wrap gap-1">
          {gaps.items.map((gap) => (
            <Badge key={gap.lexeme} tone="unknown">
              {gap.lexeme} · {count(gap.count)}
            </Badge>
          ))}
        </div>
      </div>
    </I18nText>
  )
}

/** One number from the growth window, large enough to read from across a desk. */
function Stat({ testId, label, value, hint }: { testId: string; label: string; value: string; hint?: string }) {
  return (
    <Card size="sm" data-testid={testId}>
      <CardHeader>
        <CardDescription className="text-xs">{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? <CardContent className="text-muted-foreground truncate text-xs">{hint}</CardContent> : null}
    </Card>
  )
}

/** One number inside a card, where a second card would nest (CUI-LADDER-2). */
function Fact({ testId, label, value, hint }: { testId: string; label: string; value: string; hint?: string }) {
  return (
    <I18nText>
      <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
        <dt className="text-muted-foreground text-xs">{label}</dt>
        <dd className="text-base font-medium tabular-nums">{value}</dd>
        {hint ? <dd className="text-muted-foreground truncate text-xs">{hint}</dd> : null}
      </div>
    </I18nText>
  )
}

function StripSkeleton(): ReactNode {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading">
      {[0, 1, 2, 3].map((index) => (
        <Card key={index} size="sm">
          <CardHeader>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-1 h-7 w-16" />
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

function FactsSkeleton({ facts }: { facts: number }): ReactNode {
  return (
    <div className="flex gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: facts }, (_unused, index) => (
        <div key={index} className="flex flex-1 flex-col gap-1">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-5 w-12" />
        </div>
      ))}
    </div>
  )
}
