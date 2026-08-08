import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DataState } from '@/components/data-state'
import { CopyButton } from '@/components/copy-button'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { pollAlways } from '@/lib/live'
import { useSpace } from '@/lib/space'
import {
  averageMs,
  count,
  declarationSentence,
  durationMs,
  groupFindings,
  measured,
  originLegend,
  percent,
  readDescriptor,
  readReadiness,
  readinessStanding,
  scaffoldingMarkers,
  SCAFFOLDING_EFFECT,
  shortDigest,
  versionsDisagree,
  windowLabel,
  type LintFinding,
  type Readiness,
  type ServiceDescriptor,
} from '@/pages/system.logic'

/**
 * What this installation is, and how it is doing.
 *
 * The page an operator opens on purpose — the front page answers "what does
 * this wiki know", and everything that is about the PROCESS rather than the
 * knowledge lives here: which build is serving, whether it is taking traffic,
 * what the linter thinks of the knowledge, and what the endpoints have been
 * doing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DECISION THIS PAGE IS BUILT AROUND: a card a session may not read is
 * still a card.
 *
 * `/v1/stats/mcp` is admin-only (ROUTES). A reader opening System could be
 * shown nine cards or seven, and seven is the version almost every console
 * ships — hide what would 403, keep the page tidy. It is also the version that
 * teaches the reader something false: that this installation has no MCP
 * surface. "There is nothing to see" and "there is something here and it is not
 * yours" are different facts, and on the page whose whole subject is what this
 * installation IS, the difference is the point. So every card is rendered and
 * every refusal is the SERVER's own refusal, carried through `DataState` with
 * the server's words and its `next_best_actions` — which also means the console
 * never has to keep its own copy of who may read what, and can never be wrong
 * about it in the quiet direction.
 *
 * `/v1/installation/knowledge-config` is the second card under that rule, and
 * it is the one where hiding would cost the most. That configuration decides
 * which pages this installation measures at all; a card that vanishes for a
 * reader tells them there is no such setting, which is the exact belief this
 * card was added to correct.
 *
 * The page's nav scope is `knowledge:read` for the same reason. A reader is
 * meant to arrive here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nine independent reads, nine independent `DataState`s, deliberately not one
 * combined query. A single read would let the slowest endpoint hold the page
 * blank and — worse — let one refusal blank seven surfaces that were answering.
 * On this page that is not hypothetical: one of them is refused by design for
 * most sessions.
 *
 * No chart. This console vendors no chart library, and a sparkline of requests
 * per hour is the first thing here nobody could act on.
 */

/**
 * `/ready` and the descriptor are fetched by hand, and that is the exception
 * this comment exists to justify.
 *
 * PAGES.md's rule is that pages call `wk.*` and never `fetch`, because the nav
 * table declares which paths a page may reach and that declaration is only
 * worth making if there is one place to compare it against. Both of these are
 * outside `wk`: `/ready` is the deploy gate's probe and the descriptor is
 * documented in ROUTES with prose and no response schema, so neither has a
 * typed client method to call, and `api/wk.ts` belongs to nobody's page. They
 * are still declared in nav-entries/system.json, so the navigation test still
 * holds this page to them.
 *
 * A non-2xx from `/ready` is an ANSWER, not an exception: a draining process
 * answers 503 with `{status: 'draining', version}` — the graceful-shutdown
 * state, working exactly as designed. Throwing there would paint the console's
 * error banner over the one word the operator came to read. Anything without a
 * usable body still throws, so a proxy's HTML 502 lands in the error branch
 * where it belongs.
 */
const READY_KEY = ['system', 'ready'] as const
const DESCRIPTOR_KEY = ['system', 'descriptor'] as const

async function fetchReadiness(): Promise<Readiness> {
  const response = await fetch('/ready', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  const body: unknown = await response.json().catch(() => null)
  const readiness = readReadiness(body)
  if (readiness.status === null) throw new Error(`WikiKit answered ${response.status} with no readiness in it`)
  return readiness
}

async function fetchDescriptor(): Promise<ServiceDescriptor> {
  const response = await fetch('/.well-known/service-descriptor.json', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`WikiKit answered ${response.status} for its own service descriptor`)
  return readDescriptor(await response.json())
}

/**
 * How many findings of one severity this card shows before it stops listing and
 * starts counting.
 *
 * A wiki with four hundred missing citations has four hundred findings, and a
 * card that prints all of them is a scroll no operator finishes. The card's job
 * is to say WHAT is wrong and HOW MUCH of it there is — the counts strip above
 * never truncates — and the fix happens on the page the finding names, which is
 * one click away from each row.
 */
const FINDINGS_SHOWN = 8

export function SystemPage() {
  const space = useSpace()

  // Readiness on a fixed cadence, and it is the only poll on the page. It is a
  // few hundred bytes, and it is the one fact here that changes minute to
  // minute — during a rollout it is exactly what the operator is watching, and
  // a console tab left open on a second screen has to keep watching it while it
  // is not the foreground tab (see lib/live.ts).
  const readiness = useQuery({ queryKey: READY_KEY, queryFn: fetchReadiness, ...pollAlways(15_000) })
  const descriptor = useQuery({ queryKey: DESCRIPTOR_KEY, queryFn: fetchDescriptor })

  const lint = useQuery({ queryKey: keys.lint(space), queryFn: () => wk.lint.space(space) })
  const http = useQuery({ queryKey: keys.stats(space, 'http'), queryFn: () => wk.stats.http(space) })
  const usage = useQuery({ queryKey: keys.stats(space, 'usage'), queryFn: () => wk.stats.usage(space) })
  const llm = useQuery({ queryKey: keys.stats(space, 'llm'), queryFn: () => wk.stats.llm(space) })
  const webhooks = useQuery({ queryKey: keys.stats(space, 'webhooks'), queryFn: () => wk.stats.webhooks(space) })
  const mcp = useQuery({ queryKey: keys.mcpStats(), queryFn: () => wk.stats.mcp() })
  const knowledgeConfig = useQuery({
    queryKey: keys.knowledgeConfig(),
    queryFn: () => wk.installation.knowledgeConfig(),
  })

  return (
    <Page
      title="System"
      description="Which build is serving, whether it is taking traffic, what the linter finds in this wiki, and what the endpoints have been doing."
    >
      <div className="flex flex-col gap-4">
        <Card data-testid="build-card">
          <CardHeader>
            <CardTitle>This build</CardTitle>
            <CardDescription>
              The version this process is serving, and a fingerprint of every document it publishes about itself — so a
              deployment can be compared without downloading any of them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <DataState query={readiness} skeleton={<VersionSkeleton />}>
                {(ready) => {
                  const standing = readinessStanding(ready.status)
                  return (
                    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-muted-foreground text-xs">Serving version</span>
                        <span data-testid="system-version" className="truncate font-mono text-2xl">
                          {ready.version ?? '—'}
                        </span>
                      </div>
                      <Badge tone={standing.tone} data-testid="system-readiness">
                        {standing.label}
                      </Badge>
                    </div>
                  )
                }}
              </DataState>

              <DataState
                query={descriptor}
                skeleton={<ArtifactsSkeleton />}
                isEmpty={(data) => data.artifacts.length === 0}
                empty={
                  <EmptyState
                    framed={false}
                    title="This build publishes nothing about itself"
                    description="No llms.txt, agent guide or OpenAPI document is bundled here, so there is nothing to fingerprint."
                    data-testid="artifacts-empty"
                  />
                }
              >
                {(data) => (
                  <div className="flex flex-col gap-3">
                    {versionsDisagree(readiness.data?.version ?? null, data.version) ? (
                      // Two answers from one URL means two builds behind it —
                      // a rollout in progress. Worth naming, because every
                      // other number on this page came from one of them
                      // without saying which.
                      <p className="text-warning text-xs" data-testid="version-drift">
                        This installation answered with two versions — {readiness.data?.version} and {data.version}.
                        More than one build is behind this address.
                      </p>
                    ) : null}

                    <ul className="flex flex-col gap-2" data-testid="artifacts">
                      {data.artifacts.map((artifact) => (
                        <li
                          key={artifact.key}
                          className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                        >
                          {artifact.url ? (
                            <a
                              href={artifact.url}
                              target="_blank"
                              rel="noreferrer"
                              data-testid={`artifact-${artifact.key}`}
                              className="min-w-0 truncate text-sm underline-offset-4 hover:underline"
                            >
                              {artifact.label}
                            </a>
                          ) : (
                            <span className="min-w-0 truncate text-sm" data-testid={`artifact-${artifact.key}`}>
                              {artifact.label}
                            </span>
                          )}
                          <span className="flex shrink-0 items-center gap-2">
                            <code className="text-muted-foreground font-mono text-xs">
                              {shortDigest(artifact.sha256)}
                            </code>
                            {artifact.sha256 ? (
                              <CopyButton
                                value={artifact.sha256}
                                size="icon-sm"
                                label={`Copy the ${artifact.label} digest`}
                                data-testid={`artifact-${artifact.key}-copy`}
                              />
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {data.capabilities.length > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        <p className="text-muted-foreground text-xs">This build serves</p>
                        <div className="flex flex-wrap gap-1" data-testid="capabilities">
                          {data.capabilities.map((capability) => (
                            <Badge key={capability} tone="neutral">
                              {capability}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </DataState>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="knowledge-config-card">
          <CardHeader>
            <CardTitle>Pages this installation treats as reference targets</CardTitle>
            <CardDescription>
              {SCAFFOLDING_EFFECT} Which markers count is configuration, so it differs between installations — this is
              what yours honours. Reading it is an admin's right, not a reader's; a session without it is told so here
              rather than shown a card that is missing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              query={knowledgeConfig}
              skeleton={<MarkersSkeleton />}
              isEmpty={(data) => data.scaffolding_kinds.items.length === 0}
              empty={
                // Unreachable against a healthy build — WikiKit's own marker is
                // always in the list — which is exactly why it is written out
                // rather than left to the default empty branch. A build that
                // answered with no markers is saying it treats nothing as a
                // reference target, and that is a statement about measurement,
                // not an absence of data.
                <EmptyState
                  framed={false}
                  title="No marker is honoured here"
                  description="This installation reported no revision markers at all, so every page is measured and linted as knowledge."
                  data-testid="scaffolding-empty"
                />
              }
            >
              {(data) => (
                <div className="flex flex-col gap-4">
                  <ul className="flex flex-col gap-2" data-testid="scaffolding-markers">
                    {scaffoldingMarkers(data).map((marker) => (
                      <li
                        key={marker.kind}
                        data-testid={`scaffolding-marker-${marker.kind}`}
                        className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                      >
                        {/* The marker verbatim and in monospace, like a lint
                            rule name: it is the string an operator greps their
                            configuration and their revisions for, and a nicer
                            rendering of it would be a second name for one
                            thing. */}
                        <code className="min-w-0 truncate font-mono text-sm">{marker.kind}</code>
                        {/* The provenance says its word; the tone only agrees
                            with it (CUI-A11Y-5). */}
                        <Badge tone={marker.tone} className="shrink-0">
                          {marker.label}
                        </Badge>
                      </li>
                    ))}
                  </ul>

                  <dl className="flex flex-col gap-2" data-testid="scaffolding-legend">
                    {originLegend(data).map((entry) => (
                      <div key={entry.origin} className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
                        <dt className="shrink-0">
                          <Badge tone={entry.tone}>{entry.label}</Badge>
                        </dt>
                        <dd
                          className="text-muted-foreground text-xs"
                          data-testid={`scaffolding-origin-${entry.origin}`}
                        >
                          {entry.meaning}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <p className="text-muted-foreground text-xs" data-testid="scaffolding-declaration">
                    {declarationSentence(data)}
                  </p>
                </div>
              )}
            </DataState>
          </CardContent>
        </Card>

        <Card data-testid="lint-card">
          <CardHeader>
            <CardTitle>Knowledge health in {space}</CardTitle>
            <CardDescription>
              What the linter finds in this wiki: claims with no quote behind them, pages nothing links to, changes
              nobody has reviewed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              query={lint}
              skeleton={<FactsSkeleton facts={3} />}
              isEmpty={(data) => data.findings.length === 0}
              empty={
                // A clean lint is GOOD NEWS and must not read like a failure
                // (CUI-LOAD-4). No action either: the way to keep it clean is
                // to keep citing sources, which happens on other pages.
                <EmptyState
                  icon={CircleCheck}
                  framed={false}
                  title="Nothing to fix"
                  description="The linter found no errors, warnings or notes in this wiki."
                  data-testid="lint-empty"
                />
              }
            >
              {(data) => (
                <div className="flex flex-col gap-4">
                  <dl className="grid grid-cols-3 gap-3">
                    <Fact testId="lint-errors" label="Errors" value={count(data.counts.error)} />
                    <Fact testId="lint-warnings" label="Warnings" value={count(data.counts.warn)} />
                    <Fact testId="lint-notes" label="Notes" value={count(data.counts.info)} />
                  </dl>
                  {groupFindings(data.findings).map((group) => (
                    <section key={group.severity} className="flex flex-col gap-2" aria-label={group.many}>
                      <div className="flex items-center gap-2">
                        {/* The tone is never the only carrier: the badge says
                            the word too (CUI-A11Y-5). */}
                        <Badge tone={group.tone}>{group.many}</Badge>
                        <span className="text-muted-foreground text-xs">{count(group.items.length)}</span>
                      </div>
                      <ul className="flex flex-col gap-2">
                        {group.items.slice(0, FINDINGS_SHOWN).map((finding, index) => (
                          <Finding key={`${finding.rule}-${finding.concept_slug ?? index}`} finding={finding} />
                        ))}
                      </ul>
                      {group.items.length > FINDINGS_SHOWN ? (
                        <p className="text-muted-foreground text-xs" data-testid={`lint-more-${group.severity}`}>
                          And {count(group.items.length - FINDINGS_SHOWN)} more.
                        </p>
                      ) : null}
                    </section>
                  ))}
                </div>
              )}
            </DataState>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card data-testid="http-card">
            <CardHeader>
              <CardTitle>Requests to {space}</CardTitle>
              <CardDescription>Every HTTP request against this wiki — this console included.</CardDescription>
            </CardHeader>
            <CardContent>
              <DataState
                query={http}
                skeleton={<FactsSkeleton facts={4} />}
                isEmpty={(data) => data.totals.length === 0}
                empty={
                  <EmptyState
                    framed={false}
                    title="No requests recorded"
                    description="Nothing reached this wiki over HTTP in this window."
                    data-testid="http-empty"
                  />
                }
              >
                {(data) => {
                  // `totals` is an ARRAY because the endpoint can group by a
                  // dimension; ungrouped it holds exactly one row. Reading
                  // `[0]` through `measured` rather than asserting it means a
                  // grouped window renders as unmeasured instead of crashing.
                  const totals = data.totals[0]
                  return (
                    <div className="flex flex-col gap-3">
                      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <Fact
                          testId="http-calls"
                          label="Requests"
                          value={count(measured(totals?.metrics.calls))}
                          hint={`${count(measured(totals?.metrics.unique_actors))} callers`}
                        />
                        <Fact testId="http-success" label="Succeeded" value={percent(totals?.metrics.success_ratio)} />
                        <Fact testId="http-errors" label="Failed" value={percent(totals?.metrics.error_ratio)} />
                        <Fact
                          testId="http-p95"
                          label="Slowest 5%"
                          value={durationMs(measured(totals?.metrics.duration_ms_p95))}
                          hint={`${durationMs(measured(totals?.metrics.duration_ms_p50))} typical`}
                        />
                      </dl>
                      <StatsWindow from={data.from} to={data.to} testId="http-window" />
                    </div>
                  )
                }}
              </DataState>
            </CardContent>
          </Card>

          <Card data-testid="usage-card">
            <CardHeader>
              <CardTitle>Knowledge asked for</CardTitle>
              <CardDescription>
                Searches, reads, questions, ingests and proposals — through this console, the API and agents alike.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataState
                query={usage}
                skeleton={<FactsSkeleton facts={3} />}
                isEmpty={(data) => data.totals.length === 0}
                empty={
                  <EmptyState
                    framed={false}
                    title="Nobody asked this wiki anything"
                    description="No search, read, question or ingest was recorded in this window."
                    data-testid="usage-empty"
                  />
                }
              >
                {(data) => {
                  const totals = data.totals[0]
                  return (
                    <div className="flex flex-col gap-3">
                      <dl className="grid grid-cols-3 gap-3">
                        <Fact testId="usage-calls" label="Requests" value={count(measured(totals?.metrics.calls))} />
                        <Fact
                          testId="usage-actors"
                          label="People and agents"
                          value={count(measured(totals?.metrics.unique_actors))}
                        />
                        {/* The demand-vs-coverage number, and the reason this
                            card is not a duplicate of the one beside it: a
                            question WikiKit answered honestly with "not
                            covered" is a 200 on the wire and a gap in the
                            knowledge. */}
                        <Fact
                          testId="usage-no-answer"
                          label="Not covered"
                          value={percent(totals?.metrics.no_answer_ratio)}
                          hint={`${count(measured(totals?.metrics.no_answer))} questions`}
                        />
                      </dl>
                      <StatsWindow from={data.from} to={data.to} testId="usage-window" />
                    </div>
                  )
                }}
              </DataState>
            </CardContent>
          </Card>

          <Card data-testid="llm-card">
            <CardHeader>
              <CardTitle>Model work</CardTitle>
              <CardDescription>
                What synthesis cost this wiki: calls, tokens and time, from the audit ledger.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataState query={llm} skeleton={<FactsSkeleton facts={3} />}>
                {(data) => (
                  <div className="flex flex-col gap-3">
                    <dl className="grid grid-cols-3 gap-3">
                      <Fact testId="llm-calls" label="Calls" value={count(data.totals.calls)} />
                      <Fact
                        testId="llm-tokens"
                        label="Tokens"
                        value={count(data.totals.tokens.total)}
                        hint={`${count(data.totals.tokens.input)} in · ${count(data.totals.tokens.output)} out`}
                      />
                      <Fact
                        testId="llm-duration"
                        label="Each call"
                        value={averageMs(data.totals.calls, data.totals.duration_ms.avg)}
                        hint={`${durationMs(data.totals.duration_ms.max)} slowest`}
                      />
                    </dl>
                    <Models by={data.totals.by_model} />
                    <StatsWindow from={data.from} to={data.to} testId="llm-window" />
                  </div>
                )}
              </DataState>
            </CardContent>
          </Card>

          <Card data-testid="webhooks-card">
            <CardHeader>
              <CardTitle>Webhook delivery</CardTitle>
              <CardDescription>What this wiki told the outside world, and what never arrived.</CardDescription>
            </CardHeader>
            <CardContent>
              <DataState query={webhooks} skeleton={<FactsSkeleton facts={4} />}>
                {(data) => (
                  <div className="flex flex-col gap-3">
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Fact
                        testId="webhook-events"
                        label="Events"
                        value={count(data.totals.events)}
                        hint={`${count(data.totals.pending + data.totals.delivering)} in flight`}
                      />
                      <Fact testId="webhook-delivered" label="Delivered" value={count(data.totals.delivered)} />
                      <Fact testId="webhook-failed" label="Failed" value={count(data.totals.failed)} />
                      {/* `dead` is the one that needs a person: the attempts
                          are spent and the event is not coming back on its
                          own. */}
                      <Fact testId="webhook-dead" label="Given up on" value={count(data.totals.dead)} />
                    </dl>
                    <StatsWindow from={data.from} to={data.to} testId="webhook-window" />
                  </div>
                )}
              </DataState>
            </CardContent>
          </Card>
        </div>

        <Card data-testid="mcp-card">
          <CardHeader>
            <CardTitle>Agents on the MCP endpoint</CardTitle>
            <CardDescription>
              Every MCP client this installation serves, across all wikis rather than just {space}. Reading it is an
              admin's right, not a reader's — a session without it is told so here rather than shown a card that is
              missing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              query={mcp}
              skeleton={<FactsSkeleton facts={4} />}
              isEmpty={(data) => data.totals.length === 0}
              empty={
                <EmptyState
                  framed={false}
                  title="No agent connected"
                  description="No MCP session was recorded anywhere in this installation in this window."
                  data-testid="mcp-empty"
                />
              }
            >
              {(data) => {
                const totals = data.totals[0]
                return (
                  <div className="flex flex-col gap-3">
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Fact
                        testId="mcp-sessions"
                        label="Sessions"
                        value={count(measured(totals?.metrics.unique_sessions))}
                        hint={`${count(measured(totals?.metrics.active_sessions))} open now`}
                      />
                      <Fact testId="mcp-calls" label="Tool calls" value={count(measured(totals?.metrics.calls))} />
                      <Fact testId="mcp-success" label="Succeeded" value={percent(totals?.metrics.success_ratio)} />
                      <Fact
                        testId="mcp-p95"
                        label="Slowest 5%"
                        value={durationMs(measured(totals?.metrics.duration_ms_p95))}
                      />
                    </dl>
                    <StatsWindow from={data.from} to={data.to} testId="mcp-window" />
                  </div>
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
 * One lint finding: the rule that fired, what it says, and the page it is
 * about.
 *
 * The slug is a LINK, because a finding you cannot act on is a complaint. The
 * rule name is kept verbatim and in monospace rather than translated into
 * prose — it is what an operator greps the docs and the CLI for, and a nicer
 * sentence would be a second name for the same thing.
 */
function Finding({ finding }: { finding: LintFinding }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <code className="text-muted-foreground font-mono text-xs">{finding.rule}</code>
        {finding.concept_slug ? (
          <Link
            to="/pages/$slug"
            params={{ slug: finding.concept_slug }}
            search={(prev) => prev}
            data-testid={`lint-page-${finding.concept_slug}`}
            className="min-w-0 truncate text-xs underline-offset-4 hover:underline"
          >
            {finding.concept_slug}
          </Link>
        ) : null}
      </div>
      <p className="text-sm">{finding.message}</p>
    </li>
  )
}

/**
 * Which models did the work, and how much of it each did.
 *
 * `by_model` is a record the server builds from whatever the audit ledger holds,
 * so it can be empty on a quiet window — and an empty record is not "no
 * models", it is "no calls", which the numbers above already say. Nothing is
 * drawn rather than an empty row of badges.
 */
function Models({ by }: { by: Record<string, number> }) {
  const models = Object.entries(by)
  if (models.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1" data-testid="llm-models">
      {models.map(([model, calls]) => (
        <Badge key={model} tone="unknown">
          {model} · {count(calls)}
        </Badge>
      ))}
    </div>
  )
}

/** The window the numbers above describe, in the reader's words. */
function StatsWindow({ from, to, testId }: { from: string; to: string; testId: string }) {
  const when = windowLabel(from, to)
  if (!when) return null
  return (
    <p className="text-muted-foreground text-xs" data-testid={testId}>
      In {when}.
    </p>
  )
}

/** One number inside a card, where a second card would nest (CUI-LADDER-2). */
function Fact({ testId, label, value, hint }: { testId: string; label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
      {hint ? <dd className="text-muted-foreground truncate text-xs">{hint}</dd> : null}
    </div>
  )
}

function VersionSkeleton(): ReactNode {
  return (
    <div className="flex items-end gap-4" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-32" />
      </div>
      <Skeleton className="h-5 w-24" />
    </div>
  )
}

function ArtifactsSkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  )
}

/** Marker rows, shaped like a marker beside the badge that says where it came from. */
function MarkersSkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {[0, 1].map((index) => (
        <div key={index} className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-5 w-32" />
        </div>
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
