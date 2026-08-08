import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { CopyButton } from '@/components/copy-button'
import { DataState } from '@/components/data-state'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RelativeTime } from '@/components/ui/relative-time'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import type { DomainState } from '@/lib/tokens'
import { toast, toastFailure } from '@/lib/toast'
import {
  annotateClaims,
  approvalEffect,
  badgeTone,
  changeState,
  conceptDiff,
  findingsFor,
  groupFindings,
  isDeferable,
  isMarkdownUnchanged,
  proposedBy,
  reviewUrl,
  severityLabel,
  severityState,
  staleSlugs,
  type ConceptDiff,
} from '@/pages/change.logic'

/**
 * One change, read line by line, and then decided.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE PAGE THE PRODUCT EXISTS FOR.                                  │
 * │ Nothing becomes visible knowledge in a WikiKit wiki without a human       │
 * │ approving it here (or on the public review page, which this mirrors).     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Three decisions shape the whole file:
 *
 *  - **The diff and the lint are fetched independently**, and lint failing is
 *    not allowed to cost the reviewer the diff. `/lint` runs real queries over
 *    staged content and is the more fragile of the two; a page that renders
 *    nothing because its advisory check timed out would push the reviewer to the
 *    one surface with no lint at all. Two `useQuery` calls, never one combined
 *    read — the same rule `src/http/review-page.ts` states in its own loader.
 *  - **The decision sits at the bottom**, after everything it decides. That is
 *    deliberate friction and it is copied from the public review page: an
 *    Approve button above the diff is a button that gets pressed above the diff.
 *  - **Every action restates its exact effect** before it happens, through
 *    `Confirm`'s `details`. "Approve" does not mean "mark this row approved" —
 *    it publishes pages, it can dispute claims that are already visible on other
 *    pages, and it can deactivate relations this change never mentions. Those
 *    are the consequences a reviewer cannot read off the diff, so they are the
 *    ones the dialog spells out.
 */

type ChangeDetail = Awaited<ReturnType<typeof wk.changes.get>>
type StagedConcept = ChangeDetail['concepts'][number]
type LintReport = Awaited<ReturnType<typeof wk.changes.lint>>
type LintFinding = LintReport['findings'][number]

export function ChangePage() {
  // `from` rather than `strict: false`: the route tree declares `/changes/$id`,
  // so naming it here makes `id` a `string` instead of a union of every route's
  // params — and a page that reads the wrong param name stops compiling.
  const { id } = useParams({ from: '/changes/$id' })
  const space = useSpace()

  const detail = useQuery({ queryKey: keys.change(id), queryFn: () => wk.changes.get(id) })

  // A SECOND query, on purpose. Lint is additive review context; folding it into
  // the read above would make an advisory check able to blank the diff.
  const lint = useQuery({ queryKey: keys.changeLint(id), queryFn: () => wk.changes.lint(id) })

  return (
    <Page
      title={detail.data?.title ?? 'Change'}
      description="Every claim on these pages has to be backed by a quote from an archived source. Read what this would publish, then decide."
    >
      <DataState query={detail} skeleton={<ChangeSkeleton />}>
        {(loaded) => <ChangeBody detail={loaded} lint={lint} space={space} id={id} />}
      </DataState>
    </Page>
  )
}

function ChangeBody({
  detail,
  lint,
  space,
  id,
}: {
  detail: ChangeDetail
  lint: UseQueryResult<LintReport>
  space: string
  id: string
}) {
  const can = useCan()
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')

  /**
   * What a decision invalidates.
   *
   * `keys.change(id)` is `['changes', id]`, so it is also the prefix of
   * `keys.changeLint(id)` — one call refreshes the diff and the lint together.
   * The queue key ends in the FILTER, and invalidating it whole would refresh
   * only the unfiltered list while the reviewer is almost always looking at a
   * filtered one; dropping the last segment invalidates every filter of it.
   */
  function refresh() {
    void queryClient.invalidateQueries({ queryKey: keys.change(id) })
    void queryClient.invalidateQueries({ queryKey: keys.changes(space).slice(0, -1) })
  }

  const approve = useMutation({
    mutationFn: async () => (await wk.changes.approve(id)) as { concepts?: string[] } | null,
    onSuccess: (result) => {
      refresh()
      toast({
        tone: 'success',
        title: 'Published into the wiki',
        detail: `${result?.concepts?.length ?? detail.concepts.length} page(s) are now visible to every reader and every agent.`,
      })
    },
    // The server's own sentence and its next_best_actions survive: a stale_base
    // refusal tells the reviewer to re-ingest, and paraphrasing that would throw
    // away the only instruction that ends the loop.
    onError: (error) => toastFailure('Could not approve this change', error),
  })

  const reject = useMutation({
    mutationFn: () => wk.changes.reject(id),
    onSuccess: () => {
      refresh()
      toast({
        tone: 'info',
        title: 'Rejected',
        detail: 'Nothing was published. The staged text is kept for the audit.',
      })
    },
    onError: (error) => toastFailure('Could not reject this change', error),
  })

  const requestChanges = useMutation({
    mutationFn: (revision: string) => wk.changes.requestChanges(id, { note: revision }),
    onSuccess: () => {
      setNote('')
      refresh()
      toast({
        tone: 'info',
        title: 'Sent back with your note',
        detail: 'The author revises against it and submits a fresh change — this one is closed.',
      })
    },
    onError: (error) => toastFailure('Could not request changes', error),
  })

  const split = useMutation({
    mutationFn: async (slugs: string[] | null) =>
      (await wk.changes.split(id, slugs ? { concepts: slugs } : {})) as {
        children?: { proposal_id: string }[]
      } | null,
    onSuccess: (result, slugs) => {
      refresh()
      toast({
        tone: 'success',
        title: slugs ? `Deferred ${slugs.join(', ')}` : 'Split into one change per page',
        detail: `${result?.children?.length ?? 0} change(s) now sit in the queue.`,
      })
    },
    onError: (error) => toastFailure('Could not split this change', error),
  })

  const reading = changeState(detail.status, detail.changes_requested)
  const findings = groupFindings(lint.data?.findings ?? [])
  const stale = staleSlugs(detail.concepts)
  const pending = detail.status === 'pending'
  const deferable = isDeferable(detail.status, detail.concepts.length)

  const approveReason = can('knowledge:approve')
    ? null
    : 'Needs knowledge:approve — deciding is not the same right as reading.'
  // Reject is `knowledge:approve` on the server too (src/http/routes.ts), not
  // `knowledge:review`: saying no publishes nothing but it closes the change for
  // good, and the route table grades that as a decision. Gating it on review
  // here would render a button that can only ever answer 403.
  const rejectReason = approveReason
  const reviewReason = can('knowledge:review') ? null : 'Needs knowledge:review.'

  return (
    <div className="flex flex-col gap-5">
      <Card data-testid="change-identity">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Badge tone={badgeTone(reading.state)} data-testid="change-status">
              {reading.label}
            </Badge>
            {reading.flag ? (
              <Badge tone={badgeTone(reading.flag.state)} data-testid="change-flag">
                {reading.flag.label}
              </Badge>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {detail.summary ? <p data-testid="change-summary">{detail.summary}</p> : null}

          {/* A definition list rather than a table: these are facts about one
              object, and a table of one row is a table pretending to be a list. */}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Fact label="Wiki" testId="change-space">
              {detail.space}
            </Fact>
            <Fact label="Raised" testId="change-raised">
              <RelativeTime value={detail.created_at} />
            </Fact>
            <Fact label="Written by" testId="change-author">
              {proposedBy(detail.agent_meta)}
            </Fact>
            <Fact label="Decided by" testId="change-reviewer">
              {detail.reviewer ? (
                <span>
                  {detail.reviewer}
                  {detail.reviewed_at ? (
                    <>
                      {' · '}
                      <RelativeTime value={detail.reviewed_at} />
                    </>
                  ) : null}
                  {detail.review_channel ? (
                    <span className="text-muted-foreground"> · {detail.review_channel}</span>
                  ) : null}
                </span>
              ) : (
                <Absent />
              )}
            </Fact>
            {detail.parent_proposal_id ? (
              <Fact label="Split from" testId="change-parent">
                <Link
                  to="/changes/$id"
                  params={{ id: detail.parent_proposal_id }}
                  search={{ space }}
                  data-testid="change-parent-link"
                  className="font-mono text-xs underline-offset-4 hover:underline"
                >
                  {detail.parent_proposal_id}
                </Link>
              </Fact>
            ) : null}
          </dl>

          {detail.review_note ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="change-review-note">
              <div className="font-medium">Review note</div>
              <p className="whitespace-pre-wrap text-muted-foreground">{detail.review_note}</p>
            </div>
          ) : null}

          {reading.note ? (
            <p className="text-sm text-muted-foreground" data-testid="change-state-note">
              {reading.note}
            </p>
          ) : null}

          <ReviewAddress id={detail.id} />
        </CardContent>
      </Card>

      {/* The stale-base warning, and it is not decoration: approval against a
          moved base is refused by the server, so a reviewer who does not see
          this spends their attention on a decision that cannot land. */}
      {pending && stale.length > 0 ? (
        <Alert
          tone="warning"
          title="These pages have moved on since this change was written"
          data-testid="change-stale"
          actions={['Re-ingest the sources listed below so a fresh change is written against the current text.']}
        >
          <span>
            {stale.join(', ')} — approving now fails with <code className="font-mono">stale_base</code>, and the change
            becomes terminal.
          </span>
        </Alert>
      ) : null}

      <LintPanel query={lint} general={findings.general} />

      {detail.decisions.length > 0 ? (
        <Card data-testid="change-decisions">
          <CardHeader>
            <CardTitle>Decisions recorded by this change ({detail.decisions.length})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {detail.decisions.map((decision) => (
              <div key={decision.slug} className="flex flex-col gap-1" data-testid={`change-decision-${decision.slug}`}>
                <div className="font-medium">{decision.title}</div>
                <p className="text-sm text-muted-foreground">{decision.context}</p>
                <p className="text-sm">{decision.decision}</p>
                {decision.rationale ? <p className="text-sm text-muted-foreground">{decision.rationale}</p> : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {detail.concepts.length === 0 ? (
        <EmptyState
          data-testid="change-no-concepts"
          title="This change stages no pages"
          description="It only removes relations between pages that already exist. What it takes away is listed below."
        />
      ) : (
        detail.concepts.map((concept) => (
          <ConceptCard
            key={concept.slug}
            concept={concept}
            space={space}
            findings={findingsFor(findings, concept.slug)}
            defer={
              deferable ? (
                <DisabledReason reason={reviewReason}>
                  <Confirm
                    title={`Defer ${concept.slug}?`}
                    description="Move this one page into a change of its own, so the rest can be decided now."
                    confirmLabel="Defer this page"
                    ids={{
                      dialog: `defer-dialog-${concept.slug}`,
                      accept: `defer-confirm-${concept.slug}`,
                      cancel: `defer-cancel-${concept.slug}`,
                      error: `defer-error-${concept.slug}`,
                    }}
                    onConfirm={() => split.mutateAsync([concept.slug])}
                  >
                    {(open) => (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={reviewReason !== null || split.isPending}
                        data-testid={`defer-${concept.slug}`}
                        onClick={open}
                      >
                        Defer this page
                      </Button>
                    )}
                  </Confirm>
                </DisabledReason>
              ) : null
            }
          />
        ))
      )}

      {detail.relations_removed.length > 0 ? (
        <Card data-testid="change-relations-removed">
          <CardHeader>
            <CardTitle>Relations this change takes away ({detail.relations_removed.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {detail.relations_removed.map((edge) => (
                <li
                  key={`${edge.from_slug}-${edge.kind}-${edge.to_slug}`}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`relation-removed-${edge.from_slug}-${edge.to_slug}`}
                >
                  <Badge tone="danger">removed</Badge>
                  <span className="font-mono text-xs">
                    {edge.from_slug} —{edge.kind}→ {edge.to_slug}
                  </span>
                  <span className="text-muted-foreground">deactivated on approval</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card data-testid="change-sources">
        <CardHeader>
          <CardTitle>Sources behind this change ({detail.sources.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="change-sources-empty">
              No archived source is attached. Every claim above is therefore unciteable — that is what the
              missing-citations check reports.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {detail.sources.map((source) => (
                <li key={source.id} className="flex flex-col gap-0.5" data-testid={`change-source-${source.id}`}>
                  <Link
                    to="/sources/$id"
                    params={{ id: source.id }}
                    search={{ space }}
                    data-testid={`change-source-link-${source.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {source.title ?? source.id}
                  </Link>
                  <span className="text-xs break-words text-muted-foreground">
                    {source.kind}
                    {source.url ? ` · ${source.url}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {pending ? (
        <Card data-testid="change-decision">
          <CardHeader>
            <CardTitle>Your decision</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              This decision is yours, not an agent's. Approving publishes the pages above into {detail.space}; rejecting
              closes the change and publishes nothing.
            </p>
            <div className="flex flex-wrap gap-2">
              <DisabledReason reason={approveReason}>
                <Confirm
                  title="Approve and publish?"
                  description={`This is the moment the text above becomes knowledge in ${detail.space}.`}
                  details={
                    <ul className="flex list-disc flex-col gap-1 pl-4">
                      {approvalEffect(detail, detail.space).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  }
                  confirmLabel="Approve and publish"
                  ids={{
                    dialog: 'approve-dialog',
                    accept: 'approve-confirm',
                    cancel: 'approve-cancel',
                    error: 'approve-error',
                  }}
                  onConfirm={() => approve.mutateAsync()}
                >
                  {(open) => (
                    <Button disabled={approveReason !== null || approve.isPending} data-testid="approve" onClick={open}>
                      Approve
                    </Button>
                  )}
                </Confirm>
              </DisabledReason>

              <DisabledReason reason={reviewReason}>
                <Confirm
                  title="Send this back with a note?"
                  description="The note IS the requested change — the author revises against it and submits a fresh change."
                  details={
                    <div className="flex flex-col gap-2">
                      <p>
                        Nothing is published. This change is closed for good and marked as having changes requested;
                        WikiKit has no rebase, so acting on your note produces a NEW change rather than an edit to this
                        one.
                      </p>
                      <label className="flex flex-col gap-1 font-medium" htmlFor="request-changes-note">
                        What has to change (required)
                        <Textarea
                          id="request-changes-note"
                          data-testid="request-changes-note"
                          value={note}
                          required
                          aria-required="true"
                          maxLength={2000}
                          rows={4}
                          placeholder="Name the claim that is unsupported, or the source that has to be quoted."
                          onChange={(event) => setNote(event.target.value)}
                        />
                      </label>
                      <span className="text-xs text-muted-foreground">
                        Audited, and shown to whatever writes the next version. A bounce without guidance is just a
                        rejection.
                      </span>
                    </div>
                  }
                  confirmLabel="Request changes"
                  ids={{
                    dialog: 'request-changes-dialog',
                    accept: 'request-changes-confirm',
                    cancel: 'request-changes-cancel',
                    error: 'request-changes-error',
                  }}
                  // The emptiness check lives here rather than as a disabled
                  // Confirm button: `Confirm` reports a thrown reason in the
                  // dialog with role="alert", which is where the operator is
                  // looking, and it is the same 400 the server would answer.
                  onConfirm={() => {
                    const revision = note.trim()
                    if (!revision) throw new Error('A note is required — the note is the requested change.')
                    return requestChanges.mutateAsync(revision)
                  }}
                >
                  {(open) => (
                    <Button
                      variant="outline"
                      disabled={reviewReason !== null || requestChanges.isPending}
                      data-testid="request-changes"
                      onClick={open}
                    >
                      Request changes
                    </Button>
                  )}
                </Confirm>
              </DisabledReason>

              <DisabledReason reason={rejectReason}>
                <Confirm
                  title="Reject this change?"
                  description="Nothing is published and the change becomes terminal."
                  details={
                    <span>
                      The staged text is kept for the audit trail but never becomes visible. Use “Request changes”
                      instead when the author should try again — a bare rejection carries no instruction.
                    </span>
                  }
                  confirmLabel="Reject"
                  destructive
                  ids={{
                    dialog: 'reject-dialog',
                    accept: 'reject-confirm',
                    cancel: 'reject-cancel',
                    error: 'reject-error',
                  }}
                  onConfirm={() => reject.mutateAsync()}
                >
                  {(open) => (
                    <Button
                      variant="destructive"
                      disabled={rejectReason !== null || reject.isPending}
                      data-testid="reject"
                      onClick={open}
                    >
                      Reject
                    </Button>
                  )}
                </Confirm>
              </DisabledReason>

              {deferable ? (
                <DisabledReason reason={reviewReason}>
                  <Confirm
                    title="Split into one change per page?"
                    description="Nothing is decided and nothing is published — the pages are dealt out so they can be decided one at a time."
                    details={
                      <span>
                        {detail.concepts.length} pages become {detail.concepts.length} pending changes. THIS change
                        becomes terminal and can never move again.
                      </span>
                    }
                    confirmLabel="Split it up"
                    ids={{
                      dialog: 'split-dialog',
                      accept: 'split-confirm',
                      cancel: 'split-cancel',
                      error: 'split-error',
                    }}
                    onConfirm={() => split.mutateAsync(null)}
                  >
                    {(open) => (
                      <Button
                        variant="ghost"
                        disabled={reviewReason !== null || split.isPending}
                        data-testid="split"
                        onClick={open}
                      >
                        Split into one per page
                      </Button>
                    )}
                  </Confirm>
                </DisabledReason>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

/**
 * The public review address.
 *
 * A machine address, not a door (deliberately not a button): it is what an agent
 * hands a human when its client cannot render an approval form, and a reviewer
 * sometimes has to pass it on. Following it from an already-authenticated
 * console would land on a page asking for an API key nobody has in front of
 * them, so what is offered is the ability to COPY it.
 */
function ReviewAddress({ id }: { id: string }) {
  const absolute = new URL(reviewUrl(id), window.location.origin).toString()
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Public review address</span>
      <code data-testid="change-review-url" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
        {absolute}
      </code>
      <CopyButton value={absolute} label="Copy address" data-testid="change-review-url-copy" />
    </div>
  )
}

/** One page in the change: what it says now, what it would say, and why. */
function ConceptCard({
  concept,
  space,
  findings,
  defer,
}: {
  concept: StagedConcept
  space: string
  findings: LintFinding[]
  defer: ReactNode
}) {
  const diff = conceptDiff(concept)
  const claims = annotateClaims(concept)
  return (
    <Card data-testid={`concept-${concept.slug}`} data-stale={String(concept.stale)}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Link
            to="/pages/$slug"
            params={{ slug: concept.slug }}
            search={{ space }}
            data-testid={`concept-link-${concept.slug}`}
            className="font-mono text-sm underline-offset-4 hover:underline"
          >
            {concept.slug}
          </Link>
          <Badge tone={concept.is_new ? 'accent' : 'neutral'}>{concept.is_new ? 'new page' : 'update'}</Badge>
          {concept.stale ? <Badge tone="warning">base moved on</Badge> : null}
          {isMarkdownUnchanged(diff) ? <Badge tone="unknown">text unchanged</Badge> : null}
          {defer ? <span className="ml-auto">{defer}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {findings.length > 0 ? <FindingList findings={findings} testId={`concept-findings-${concept.slug}`} /> : null}

        <ConceptDiffView diff={diff} slug={concept.slug} />

        {claims.staged.length > 0 || claims.retired.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Claims ({claims.staged.length + claims.retired.length})</h3>
            {claims.staged.map(({ claim, change }, index) => (
              <ClaimRow
                key={`${claim.subject}-${claim.predicate}-${claim.object}-${index}`}
                slug={concept.slug}
                index={index}
                claim={claim}
                change={change}
              />
            ))}
            {claims.retired.map(({ triple, change }, index) => (
              <div
                key={`retired-${triple.subject}-${triple.predicate}-${index}`}
                data-testid={`claim-retired-${concept.slug}-${index}`}
                className="flex flex-col gap-1 rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={change === 'deprecated' ? 'unknown' : 'danger'}>{change}</Badge>
                  <span className="text-muted-foreground text-xs">already visible in the wiki</span>
                </div>
                <Triple triple={triple} />
              </div>
            ))}
          </section>
        ) : null}

        {concept.relations_added.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Relations this page adds ({concept.relations_added.length})</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {concept.relations_added.map((relation) => (
                <li
                  key={`${relation.kind}-${relation.to_slug}`}
                  data-testid={`relation-added-${concept.slug}-${relation.to_slug}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Badge tone="success">added</Badge>
                  <span className="font-mono text-xs">
                    {relation.kind} → {relation.to_slug}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  )
}

/**
 * The line diff.
 *
 * The op character is printed in a gutter, so the reading does not depend on
 * colour (CUI-A11Y-5) — the same page has to work for a reviewer with no colour
 * vision and for one reading a screenshot in a chat thread. `whitespace-pre-wrap`
 * rather than a horizontal scroller: a diff is prose here, and prose that has to
 * be dragged sideways at 390px does not get read.
 */
function ConceptDiffView({ diff, slug }: { diff: ConceptDiff; slug: string }) {
  if (diff.kind === 'too-large') {
    return (
      <div className="flex flex-col gap-2" data-testid={`diff-too-large-${slug}`}>
        <p className="text-sm text-muted-foreground">
          This document is too large to diff line by line without freezing the tab. Here is what it says now, then what
          it would say.
        </p>
        <pre className="max-h-96 overflow-y-auto rounded-lg border border-border p-3 text-xs whitespace-pre-wrap">
          {diff.before}
        </pre>
        <pre className="max-h-96 overflow-y-auto rounded-lg border border-border p-3 text-xs whitespace-pre-wrap">
          {diff.after}
        </pre>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span data-testid={`diff-stat-${slug}`}>
          +{diff.added} / −{diff.removed}
        </span>
        {diff.created ? <span>every line is new — this page does not exist yet</span> : null}
      </div>
      <div
        data-testid={`diff-${slug}`}
        className="rounded-lg border border-border font-mono text-xs"
        role="group"
        aria-label={`Line diff for ${slug}`}
      >
        {diff.lines.map((line, index) => (
          <div
            key={index}
            className={
              line.op === '+'
                ? 'flex gap-2 bg-success/10 px-2 py-0.5'
                : line.op === '-'
                  ? 'flex gap-2 bg-destructive/10 px-2 py-0.5'
                  : 'flex gap-2 px-2 py-0.5 text-muted-foreground'
            }
          >
            <span aria-hidden="true" className="select-none opacity-60">
              {line.op === ' ' ? ' ' : line.op}
            </span>
            <span className="min-w-0 break-words whitespace-pre-wrap">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One staged claim, with the verbatim quotes that are supposed to back it. */
function ClaimRow({
  slug,
  index,
  claim,
  change,
}: {
  slug: string
  index: number
  claim: StagedConcept['claims'][number]
  change: 'added' | 'disputed' | 'deprecated' | null
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-testid={`claim-${slug}-${index}`}
      data-change={change ?? 'unchanged'}
    >
      <div className="flex flex-wrap items-center gap-2">
        {change ? <Badge tone={change === 'added' ? 'success' : 'danger'}>{change}</Badge> : null}
        <Badge tone={badgeTone(claimStatusState(claim.status))}>{claim.status}</Badge>
        {claim.collides ? (
          <Badge tone="danger" data-testid={`claim-collides-${slug}-${index}`}>
            collides
          </Badge>
        ) : null}
      </div>
      <Triple triple={claim} />
      {claim.collides ? (
        <p className="text-xs text-destructive">
          Contradicts a claim already visible on the same frame — approval marks BOTH of them disputed.
        </p>
      ) : null}
      {claim.citations.length === 0 ? (
        // Uncited is the one state this product cannot shrug at: a claim with no
        // quote is an assertion the wiki cannot defend.
        <p className="text-xs text-destructive" data-testid={`claim-uncited-${slug}-${index}`}>
          No citation. Nothing in an archived source says this.
        </p>
      ) : (
        claim.citations.map((citation, citationIndex) => (
          <details key={`${citation.source_id}-${citationIndex}`} className="text-xs">
            <summary
              data-testid={`citation-${slug}-${index}-${citationIndex}`}
              className="cursor-pointer text-muted-foreground"
            >
              Quote from {citation.source_title ?? citation.source_id}
              {citation.locator ? ` · ${citation.locator}` : ''}
            </summary>
            <blockquote className="mt-1 border-l-2 border-border pl-3 whitespace-pre-wrap">{citation.quote}</blockquote>
          </details>
        ))
      )}
    </div>
  )
}

function Triple({ triple }: { triple: { subject: string; predicate: string; object: string } }) {
  return (
    <p className="text-sm break-words">
      {triple.subject} <strong className="font-medium">{triple.predicate}</strong> {triple.object}
    </p>
  )
}

/**
 * The staged-content checks.
 *
 * A lint that could not run is reported as a lint that could not run, never as a
 * clean bill of health: "no findings" and "nobody looked" are different facts,
 * and only one of them is a reason to approve.
 */
function LintPanel({ query, general }: { query: UseQueryResult<LintReport>; general: LintFinding[] }) {
  const report = query.data
  if (query.isError) {
    return (
      <Alert tone="warning" title="The staged-content checks did not run" data-testid="change-lint-failed">
        The diff above is unaffected — this check is advisory. Nothing here says the change is clean; it says nobody
        looked.
      </Alert>
    )
  }
  if (query.isPending) return <Skeleton className="h-16 w-full" data-testid="change-lint-skeleton" />
  if (!report) return null

  const total = report.counts.error + report.counts.warn + report.counts.info
  if (total === 0) {
    return (
      <Alert tone="info" title="The staged-content checks found nothing" data-testid="change-lint-clean">
        Every claim carries a citation, no claim collides with a visible one, and no relation points at a page that is
        not there.
      </Alert>
    )
  }

  return (
    <Card data-testid="change-lint">
      <CardHeader>
        <CardTitle>
          Checks — {report.counts.error} error(s), {report.counts.warn} warning(s), {report.counts.info} note(s)
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {general.length > 0 ? (
          <FindingList findings={general} testId="change-lint-general" />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="change-lint-per-concept">
            Every finding names a page, and each one is shown with that page's diff below.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function FindingList({ findings, testId }: { findings: LintFinding[]; testId: string }) {
  return (
    <ul className="flex flex-col gap-2 text-sm" data-testid={testId}>
      {findings.map((finding, index) => (
        <li key={`${finding.rule}-${index}`} className="flex flex-wrap items-start gap-2">
          <Badge tone={badgeTone(severityState(finding.severity))}>{severityLabel(finding.severity)}</Badge>
          <span className="font-mono text-xs text-muted-foreground">{finding.rule}</span>
          <span className="min-w-0 break-words">{finding.message}</span>
        </li>
      ))}
    </ul>
  )
}

/** A labelled fact in the header's definition list. */
function Fact({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-words">
        {children}
      </dd>
    </div>
  )
}

/** A value nobody sent, drawn as absence rather than as zero (CUI-SEV-2). */
function Absent() {
  return <span className="text-muted-foreground">—</span>
}

/**
 * A claim's own status, as a domain state.
 *
 * Deliberately NOT `severityState`: `verified`, `disputed`, `proposed` and
 * `deprecated` are lifecycle states, not severities, and folding the two tables
 * together is how `warning` ends up meaning "waiting for a human" in one place
 * and "something is wrong" in the next. `deprecated` and `draft` fall through to
 * `unknown` — withdrawn, not wrong.
 */
function claimStatusState(status: string): DomainState {
  return status === 'verified'
    ? 'succeeded'
    : status === 'disputed'
      ? 'failed'
      : status === 'proposed'
        ? 'blocked'
        : 'unknown'
}

/** A skeleton in the shape of the answer: an identity card, then two page cards. */
function ChangeSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading" data-testid="change-skeleton">
      <div className="flex flex-col gap-3 rounded-xl p-4 ring-1 ring-foreground/10">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-4 w-48" />
      </div>
      {[0, 1].map((card) => (
        <div key={card} className="flex flex-col gap-2 rounded-xl p-4 ring-1 ring-foreground/10">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
  )
}
