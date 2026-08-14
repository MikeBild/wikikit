import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleCheck, Telescope } from 'lucide-react'
import type { ReactNode } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DataState, RowSkeleton } from '@/components/data-state'
import { EmptyState } from '@/components/empty-state'
import { I18nText } from '@/components/i18n-text'
import { Fact } from '@/components/fact'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { RelativeTime } from '@/components/ui/relative-time'
import { Skeleton } from '@/components/ui/skeleton'
import { useSpace } from '@/lib/space'
import { useI18n } from '@/lib/i18n-context'
import { semanticLabel } from '@/lib/presentation'
import { averageSeconds, changeStanding, count, measured, staleShare, windowLabel } from '@/pages/home.logic'
import { waitedDays, type Waited } from '@/pages/care.logic'

/**
 * The wiki's front page — the LOOP, in the order it turns.
 *
 * It used to be three questions arranged as a dashboard: what changed, what is
 * waiting, where is it thin. Each of those was true and none of them said what
 * to do next, so a reader who was not already a reviewer had nothing to act on.
 * The four cards below are the product instead: something arrives, a person
 * decides what it became, a reader asks the wiki a question, and what the
 * asking exposes gets maintained. Every step carries a real number and the one
 * link that continues it — the same order the sidebar reads in, so a reader who
 * has read either has read the product.
 *
 * Four independent `DataState`s over three reads, deliberately not one. A
 * single combined query would let the slowest endpoint hold the whole page
 * blank and — worse — let one refusal blank four surfaces that were answering
 * fine. A reviewer must still see what is waiting for them when the composed
 * health read says no.
 *
 * `/health` rather than `/stats/coverage`: it carries the same coverage block
 * AND the two live queues the loop is actually measured by, so the front page
 * asks once for numbers it used to guess at — chiefly how OLD the oldest
 * waiting change is, which is the number a bare count hides.
 *
 * No chart. This console vendors no chart library, and none of the four
 * questions above is answered by a shape; a sparkline of "concepts created per
 * hour" would be the first thing here nobody could act on.
 */

/**
 * Five is a GLANCE, not a page of the queue.
 *
 * The front page's job is to say that something is waiting and how long it has
 * been; the queue itself is `/changes`, which has the filters, the columns and
 * the address bar to hold them. A twenty-row list here would be a second, worse
 * review queue that nobody could link to.
 */
const WAITING_QUERY = { status: 'pending', limit: 5 } as const

export function HomePage() {
  const space = useSpace()
  const { text } = useI18n()

  const knowledge = useQuery({ queryKey: keys.stats(space, 'knowledge'), queryFn: () => wk.stats.knowledge(space) })
  const reviews = useQuery({ queryKey: keys.stats(space, 'reviews'), queryFn: () => wk.stats.reviews(space) })
  const ingests = useQuery({ queryKey: keys.stats(space, 'ingests'), queryFn: () => wk.stats.ingests(space) })
  const health = useQuery({ queryKey: keys.health(space), queryFn: () => wk.health.space(space) })
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
      description="The loop this wiki turns on: something arrives, a person decides it, a reader asks, and what the asking exposes gets maintained."
      actions={
        <Button asChild>
          <Link to="/changes" search={(prev) => prev} data-testid="home-open-changes">
            Review changes
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <DataState testId="home-knowledge" query={knowledge} skeleton={<StripSkeleton />}>
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
          {/* 1 — something arrives. */}
          <Card data-testid="loop-capture">
            <CardHeader>
              <CardTitle>Documents coming in</CardTitle>
              <CardDescription>Every page here is written from an archived document.</CardDescription>
            </CardHeader>
            <CardContent>
              {/*
                Deliberately the ingest STATS and not the live queue depth,
                even though `/health` carries one: this card already costs a
                read that cannot fail with the other three, and a fourth
                `DataState` over the same composed read would paint a fourth
                copy of one refusal across one page.
              */}
              <DataState testId="home-ingests" query={ingests} skeleton={<FactsSkeleton facts={3} />}>
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
            <CardFooter>
              <Link
                to="/inbox"
                search={(prev) => prev}
                data-testid="loop-capture-next"
                className="text-sm underline-offset-4 hover:underline"
              >
                Throw something in
              </Link>
            </CardFooter>
          </Card>

          {/* 2 — a person decides what it became. */}
          <Card data-testid="loop-review">
            <CardHeader>
              <CardTitle>Waiting for review</CardTitle>
              <CardDescription>Nothing becomes visible knowledge until a person approves it.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3">
                <DataState testId="home-backlog" query={health} skeleton={<FactsSkeleton facts={2} />}>
                  {(data) => (
                    <dl className="grid grid-cols-2 gap-3">
                      <Fact testId="review-waiting" label="Waiting" value={count(data.review_queue.pending)} />
                      {/*
                        The number a bare count hides. `oldest_days` is null
                        exactly when nothing is waiting, and null is the em
                        dash, never "0 days" (CUI-SEV-2).
                      */}
                      <Fact
                        testId="review-oldest"
                        label="The oldest has waited"
                        value={waitedLabel(text, waitedDays(data.review_queue.oldest_days))}
                      />
                    </dl>
                  )}
                </DataState>
                <DataState
                  testId="home-waiting"
                  query={waiting}
                  skeleton={<RowSkeleton rows={3} columns={2} />}
                  isEmpty={(data) => data.items.length === 0}
                  empty={
                    // An empty queue is GOOD NEWS and must not read like a
                    // failure (CUI-LOAD-4), and it needs no action: the way to
                    // fill it is to write knowledge, which is another card.
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
                      {data.items.map((item, index) => {
                        const standing = changeStanding(item.status, item.changes_requested)
                        return (
                          <li key={item.id}>
                            <Link
                              to="/changes/$id"
                              params={{ id: item.id }}
                              search={(prev) => prev}
                              data-testid={`waiting-change-${index + 1}`}
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
              </div>
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

          {/* 3 — a reader asks. */}
          <Card data-testid="loop-ask">
            <CardHeader>
              <CardTitle>What readers asked for</CardTitle>
              <CardDescription>
                An answer is kept, with the pages it quoted, and a good one can be filed back in.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataState testId="home-gaps" query={health} skeleton={<FactsSkeleton facts={2} />}>
                {(data) => <GapTopics gaps={data.coverage.gap_topics} />}
              </DataState>
            </CardContent>
            <CardFooter>
              <Link
                to="/search"
                search={(prev) => prev}
                data-testid="loop-ask-next"
                className="text-sm underline-offset-4 hover:underline"
              >
                Ask this wiki something
              </Link>
            </CardFooter>
          </Card>

          {/* 4 — what the asking exposes gets maintained. */}
          <Card data-testid="loop-care">
            <CardHeader>
              <CardTitle>What needs care</CardTitle>
              <CardDescription>
                Claims with no quote behind them, pages that contradict each other, knowledge nobody has revisited.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataState testId="home-care" query={health} skeleton={<FactsSkeleton facts={3} />}>
                {(data) => (
                  <dl className="grid grid-cols-3 gap-3">
                    <Fact testId="loop-lint-errors" label="Errors" value={count(data.lint.counts.error)} />
                    <Fact testId="loop-lint-warnings" label="Warnings" value={count(data.lint.counts.warn)} />
                    <Fact
                      testId="loop-lint-stale"
                      label="Untouched 90 days"
                      value={staleShare(data.coverage.freshness.concepts, data.coverage.freshness.stale_over_90d)}
                      hint={`${count(data.coverage.freshness.stale_over_90d)} of ${count(data.coverage.freshness.concepts)} pages`}
                    />
                  </dl>
                )}
              </DataState>
            </CardContent>
            <CardFooter>
              <Link
                to="/care"
                search={(prev) => prev}
                data-testid="loop-care-next"
                className="text-sm underline-offset-4 hover:underline"
              >
                What this wiki needs
              </Link>
            </CardFooter>
          </Card>
        </div>

        <Card data-testid="reviews-card">
          <CardHeader>
            <CardTitle>Reviewing</CardTitle>
            <CardDescription>What reviewers did here — through this console, the API and agents alike.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              testId="home-reviews"
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
                // dimension; ungrouped it holds exactly one row. Reading `[0]`
                // through `measured` rather than asserting it means a window
                // the server grouped away renders as unmeasured instead of
                // crashing the front page.
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

/** A `Waited` as a string: the em dash when there is nothing to say (CUI-SEV-2). */
function waitedLabel(
  text: (source: string, values?: Readonly<Record<string, string | number>>) => string,
  waited: Waited,
): string {
  return waited.phrase === null ? '—' : text(waited.phrase, waited.values)
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
