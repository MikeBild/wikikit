import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleCheck, Clock } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { SectionHeading } from '@/components/context-help'
import { DataState, RowSkeleton } from '@/components/data-state'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { I18nText } from '@/components/i18n-text'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/lib/i18n-context'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { toast } from '@/lib/toast'
import { count, durationHours, staleShare, windowLabel } from '@/pages/home.logic'
import { groupFindings, type LintFinding } from '@/pages/system.logic'
import {
  backlogStanding,
  draftsFrom,
  findingTarget,
  scheduleBody,
  scheduleProblem,
  waitedDays,
  waitedHours,
  WEEKDAYS,
  type ScheduleDraft,
  type ScheduleWire,
  type Waited,
} from '@/pages/care.logic'

/**
 * Pflege — what this wiki needs somebody to do about it.
 *
 * Everything on this page existed before it did, as endpoints nobody thought to
 * call: `lintSpace` finds the contradictions and the uncited claims,
 * `coverageStats` finds the thin patches, and the two queues have always been
 * countable. What was missing was a PLACE, and the cost of that was measured in
 * production: a wiki carrying hundreds of pending proposals, the oldest three
 * weeks untouched, with a perfectly healthy installation reporting nothing.
 *
 * So the page leads with the two numbers that were invisible — how many changes
 * are waiting, and how OLD the oldest one is — because a count on its own reads
 * as "some work waiting" when the truth is "this queue was abandoned".
 *
 * And there is no verdict anywhere on it. No traffic light, no score, no
 * "healthy". Every threshold that would produce one is policy — how many
 * pending changes is too many, for whose team? — and `src/domain/health.ts`
 * refuses to invent one for exactly that reason. A console that invented one
 * anyway would be hiding a decision from the operator who owns it.
 *
 * One read for the whole page, unlike Home's five. Here that is right: the
 * numbers are one composed answer from one endpoint, and a page that showed the
 * lint findings while the queue counts were still blank would invite the reader
 * to act on half a picture. The schedule form below is the exception and is its
 * own read, because it is admin-only and a reader must still get the report.
 */

/**
 * How many findings of one severity the page lists before it stops listing and
 * starts counting.
 *
 * A wiki with four hundred missing citations has four hundred findings, and a
 * page that prints all of them is a scroll nobody finishes. The counts strip
 * never truncates; the list is a sample you work from, and the work happens on
 * the page each row links to.
 */
const FINDINGS_SHOWN = 8

export function CarePage() {
  const space = useSpace()
  const can = useCan()
  const { text } = useI18n()
  const admin = can('admin')

  const health = useQuery({ queryKey: keys.health(space), queryFn: () => wk.health.space(space) })

  return (
    <Page
      title="Care"
      description="What this wiki needs: what is waiting for a decision, what the linter found, and where its knowledge is thin."
      actions={
        <Button asChild variant="outline">
          <Link to="/changes" search={(prev) => prev} data-testid="care-open-changes">
            The review queue
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        <DataState testId="care-health" query={health} skeleton={<QueueSkeleton />}>
          {(data) => {
            const backlog = backlogStanding(data.review_queue.pending)
            const when = windowLabel(data.window.from, data.window.to)
            return (
              <div className="flex flex-col gap-8">
                <section className="flex flex-col gap-3" aria-labelledby="care-queues-heading">
                  <h2 id="care-queues-heading" className="text-sm font-semibold">
                    <I18nText>What is waiting</I18nText>
                  </h2>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <Card data-testid="care-review-queue">
                      <CardHeader>
                        <CardTitle>Changes waiting for a person</CardTitle>
                        <CardDescription>
                          Nothing in this wiki becomes visible knowledge until somebody decides it.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="flex flex-col gap-3">
                          <dl className="grid grid-cols-2 gap-3">
                            <Fact
                              testId="care-pending"
                              label="Waiting"
                              value={count(data.review_queue.pending)}
                              hint={backlog.label}
                            />
                            {/*
                              The number this page exists for. `oldest_days` is
                              null exactly when the queue is empty, and null is
                              the em dash — "the oldest change has waited zero
                              days" is a sentence about nothing (CUI-SEV-2).
                            */}
                            <Fact
                              testId="care-oldest"
                              label="The oldest has waited"
                              value={phrase(text, waitedDays(data.review_queue.oldest_days))}
                            />
                          </dl>
                          <Badge tone={backlog.tone} data-testid="care-backlog">
                            {backlog.label}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>

                    <Card data-testid="care-ingest-queue">
                      <CardHeader>
                        <CardTitle>Documents still being read</CardTitle>
                        <CardDescription>
                          Work the pipeline has not finished. A parked job is counted beside the queue, not inside it.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <dl className="grid grid-cols-3 gap-3">
                          <Fact testId="care-queue-depth" label="In the queue" value={count(data.ingest_queue.depth)} />
                          <Fact
                            testId="care-queue-parked"
                            label="Paused on a quota"
                            value={count(data.ingest_queue.quota_blocked)}
                          />
                          <Fact
                            testId="care-queue-oldest"
                            label="Longest wait"
                            value={phrase(text, waitedHours(data.ingest_queue.oldest_queued_hours))}
                          />
                        </dl>
                      </CardContent>
                    </Card>
                  </div>
                </section>

                <section className="flex flex-col gap-3" aria-labelledby="care-findings-heading">
                  <SectionHeading
                    id="care-findings-heading"
                    helpTitle="About these findings"
                    help={
                      <p>
                        Found by reading this wiki, without a model: claims with no quote behind them, pages that
                        contradict each other, pages nothing links to, changes nobody has reviewed.
                      </p>
                    }
                    testId="care-findings-help"
                  >
                    What the linter found
                  </SectionHeading>
                  <Card data-testid="care-findings-card">
                    <CardContent>
                      {data.lint.findings.length === 0 ? (
                        // A clean report is GOOD NEWS and must not read like a
                        // failure (CUI-LOAD-4).
                        <EmptyState
                          icon={CircleCheck}
                          framed={false}
                          title="Nothing to fix"
                          description="The linter found no errors, warnings or notes in this wiki."
                          data-testid="care-findings-empty"
                        />
                      ) : (
                        <div className="flex flex-col gap-4">
                          <dl className="grid grid-cols-3 gap-3">
                            <Fact testId="care-errors" label="Errors" value={count(data.lint.counts.error)} />
                            <Fact testId="care-warnings" label="Warnings" value={count(data.lint.counts.warn)} />
                            <Fact testId="care-notes" label="Notes" value={count(data.lint.counts.info)} />
                          </dl>
                          {groupFindings(data.lint.findings).map((group) => (
                            <section key={group.severity} className="flex flex-col gap-2" aria-label={group.many}>
                              <div className="flex items-center gap-2">
                                <Badge tone={group.tone}>{group.many}</Badge>
                                <span className="text-muted-foreground text-xs">{count(group.items.length)}</span>
                              </div>
                              <ul className="flex flex-col gap-1.5">
                                {group.items.slice(0, FINDINGS_SHOWN).map((finding, index) => (
                                  <Finding
                                    key={`${finding.rule}-${finding.concept_slug ?? index}`}
                                    finding={finding}
                                    testId={`care-${group.severity}-${index + 1}`}
                                  />
                                ))}
                              </ul>
                              {group.items.length > FINDINGS_SHOWN ? (
                                <p
                                  className="text-muted-foreground text-xs"
                                  data-testid={`care-more-${group.severity}`}
                                >
                                  And {count(group.items.length - FINDINGS_SHOWN)} more.
                                </p>
                              ) : null}
                            </section>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </section>

                <section className="flex flex-col gap-3" aria-labelledby="care-thin-heading">
                  <h2 id="care-thin-heading" className="text-sm font-semibold">
                    <I18nText>Where the knowledge is thin</I18nText>
                  </h2>
                  <Card data-testid="care-coverage">
                    <CardContent>
                      <div className="flex flex-col gap-4">
                        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                          <Fact
                            testId="care-disputed"
                            label="Disputed claims"
                            value={count(data.coverage.disputed.open)}
                            hint={
                              data.coverage.disputed.oldest_days === null
                                ? 'none open'
                                : `oldest ${count(Math.round(data.coverage.disputed.oldest_days))} days`
                            }
                          />
                          <Fact
                            testId="care-stale"
                            label="Untouched 90 days"
                            value={staleShare(data.coverage.freshness.concepts, data.coverage.freshness.stale_over_90d)}
                            hint={`${count(data.coverage.freshness.stale_over_90d)} of ${count(data.coverage.freshness.concepts)} pages`}
                          />
                          <Fact
                            testId="care-latency"
                            label="Median time to decide"
                            value={durationHours(data.coverage.review_latency.median_hours)}
                            hint={`${count(data.coverage.review_latency.decided)} decided`}
                          />
                        </dl>
                        <GapTopics gaps={data.coverage.gap_topics} />
                        {when ? (
                          <p className="text-muted-foreground text-xs" data-testid="care-window">
                            {text(`In ${when}.`)}
                          </p>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                </section>
              </div>
            )
          }}
        </DataState>

        <section className="flex flex-col gap-3" aria-labelledby="care-schedule-heading">
          <SectionHeading
            id="care-schedule-heading"
            helpTitle="About scheduled reports"
            help={
              <p>
                WikiKit runs these itself, in its own process. Each one writes an entry under Answers; nothing is
                emailed, and a briefing costs no model tokens because it is an assembly of counts and titles.
              </p>
            }
            testId="care-schedule-help"
          >
            Reports that run by themselves
          </SectionHeading>
          {admin ? (
            <Schedules space={space} />
          ) : (
            // Not a card that quietly disappears: a reader should be able to
            // see that a timetable exists and is not theirs, which is a
            // different fact from "this wiki has no reports".
            <I18nText>
              <p className="text-muted-foreground text-sm" data-testid="care-schedule-forbidden">
                Reading and changing the timetable is an admin's right, not a reader's.
              </p>
            </I18nText>
          )}
        </section>
      </div>
    </Page>
  )
}

/**
 * One finding, as a row that goes somewhere.
 *
 * The link is the reason this page is worth opening twice. A finding that names
 * nothing renders as plain text rather than as a dead link — see
 * `findingTarget`, which answers `null` rather than sending the reader to a
 * list to hunt.
 */
function Finding({
  finding,
  testId,
}: {
  finding: LintFinding & { details?: Record<string, unknown> }
  testId: string
}) {
  const target = findingTarget(finding)
  const body = (
    <>
      <span className="font-mono text-[11px] tracking-tight">{finding.rule}</span>
      <span className="min-w-0">{finding.message}</span>
    </>
  )
  const shell = 'flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-xs sm:flex-row sm:items-baseline sm:gap-3'
  const linked = `hover:bg-muted focus-visible:ring-ring/50 transition-colors focus-visible:ring-3 focus-visible:outline-none ${shell}`

  if (target?.kind === 'page')
    return (
      <li>
        <Link
          to="/pages/$slug"
          params={{ slug: target.slug }}
          search={(prev) => prev}
          data-testid={testId}
          className={linked}
        >
          {body}
        </Link>
      </li>
    )
  if (target?.kind === 'change')
    return (
      <li>
        <Link
          to="/changes/$id"
          params={{ id: target.id }}
          search={(prev) => prev}
          data-testid={testId}
          className={linked}
        >
          {body}
        </Link>
      </li>
    )
  if (target?.kind === 'source')
    return (
      <li>
        <Link
          to="/sources/$id"
          params={{ id: target.id }}
          search={(prev) => prev}
          data-testid={testId}
          className={linked}
        >
          {body}
        </Link>
      </li>
    )
  return (
    <li className={shell} data-testid={testId}>
      {body}
    </li>
  )
}

/**
 * The questions readers asked that this wiki could not answer.
 *
 * `enabled: false` is not emptiness and is not a failure — it is a capability
 * the deployment never switched on, and reporting "no gaps" there would be the
 * console giving a clean result for a measurement nobody took.
 */
function GapTopics({ gaps }: { gaps: { enabled: boolean; items: readonly { lexeme: string; count: number }[] } }) {
  if (!gaps.enabled)
    return (
      <I18nText>
        <p className="text-muted-foreground text-xs" data-testid="care-gaps-off">
          Unanswered-question tracking is switched off in this deployment.
        </p>
      </I18nText>
    )
  if (gaps.items.length === 0)
    return (
      <I18nText>
        <p className="text-muted-foreground text-xs" data-testid="care-gaps-none">
          Every question readers asked found an answer.
        </p>
      </I18nText>
    )
  return (
    <I18nText>
      <div className="flex flex-col gap-1.5" data-testid="care-gaps">
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

/**
 * The timetable, for an admin.
 *
 * A REPLACE rather than a row of switches that each save themselves: the route
 * takes the complete set, which makes it idempotent and makes "here is what I
 * want running" one sentence an operator can hold in their head. Both kinds
 * always travel, including the switched-off ones — leaving one out deletes its
 * row and with it `last_run_at`, the only record that the report ever went out.
 */
function Schedules({ space }: { space: string }) {
  const schedules = useQuery({ queryKey: keys.schedules(space), queryFn: () => wk.schedules.get(space) })
  return (
    <DataState testId="care-schedules" query={schedules} skeleton={<RowSkeleton rows={2} columns={3} />}>
      {(data) => <ScheduleForm space={space} saved={data.schedules} />}
    </DataState>
  )
}

/**
 * The form itself, whose edits are DERIVED from the server's rows rather than
 * copied into state beside them.
 *
 * `edited === null` means "showing what the server holds", and the first
 * keystroke replaces it with the whole set. An effect that seeded state from
 * the query would render twice on arrival and — worse — would need a guard to
 * stop a background refetch overwriting a half-typed time; there is nothing
 * external to synchronise with here, and the answer is a function of the props
 * this component already has.
 */
function ScheduleForm({ space, saved }: { space: string; saved: readonly ScheduleWire[] }) {
  const client = useQueryClient()
  const { text } = useI18n()
  const [edited, setEdited] = useState<ScheduleDraft[] | null>(null)
  // The browser's zone as the default for a kind the server has no row for:
  // "every morning" has to mean the morning of whoever set it up.
  const drafts = edited ?? draftsFrom(saved, Intl.DateTimeFormat().resolvedOptions().timeZone)

  const save = useMutation({
    mutationFn: (next: readonly ScheduleDraft[]) => wk.schedules.put(space, scheduleBody(next)),
    onSuccess: async () => {
      setEdited(null)
      toast({ tone: 'success', title: 'Timetable saved' })
      await client.invalidateQueries({ queryKey: keys.schedules(space) })
    },
  })

  const problem = scheduleProblem(drafts)

  return (
    <>
      <div className="flex flex-col gap-4">
        {drafts.map((draft, index) => (
          <ScheduleRow
            key={draft.kind}
            draft={draft}
            busy={save.isPending}
            onChange={(next) => setEdited(drafts.map((row, position) => (position === index ? next : row)))}
          />
        ))}
        <Confirm
          title="Save this timetable?"
          description="WikiKit runs these reports itself, from its own process."
          details={
            <div className="flex flex-col gap-2">
              <p>
                Each run writes an entry under Answers. A briefing costs nothing — it is an assembly of counts and
                titles — and a care report is the page above, kept.
              </p>
              <p>
                A report switched off here stops running and keeps its record of when it last did. Nothing is emailed: a
                care report also raises an event, which is where a mail would be hung.
              </p>
            </div>
          }
          confirmLabel="Save timetable"
          ids={{
            dialog: 'care-schedule-dialog',
            accept: 'care-schedule-confirm',
            cancel: 'care-schedule-cancel',
            error: 'care-schedule-error',
          }}
          onConfirm={() => save.mutateAsync(drafts)}
        >
          {(open) => (
            <DisabledReason reason={problem ? text(problem) : null} data-testid="care-schedule-reason">
              <Button
                className="w-fit"
                data-testid="care-schedule-save"
                disabled={problem !== null || save.isPending}
                onClick={open}
              >
                <Clock data-icon="inline-start" />
                Save timetable
              </Button>
            </DisabledReason>
          )}
        </Confirm>
      </div>
    </>
  )
}

const KIND_TITLE: Record<string, string> = {
  briefing: 'Morning briefing',
  health: 'Care report',
}

const KIND_DETAIL: Record<string, string> = {
  briefing: 'What was approved since the last one, what is waiting, and how long the oldest has waited.',
  health: 'The report on this page, kept — and an event other systems can listen for.',
}

function ScheduleRow({
  draft,
  busy,
  onChange,
}: {
  draft: ScheduleDraft
  busy: boolean
  onChange: (next: ScheduleDraft) => void
}) {
  const kind = draft.kind
  return (
    <I18nText>
      <div className="border-border flex flex-col gap-3 rounded-lg border p-4" data-testid={`care-schedule-${kind}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{KIND_TITLE[kind] ?? kind}</span>
            <span className="text-muted-foreground text-xs">{KIND_DETAIL[kind] ?? ''}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor={`care-schedule-${kind}-enabled`} className="text-xs">
              Run it
            </Label>
            <Switch
              id={`care-schedule-${kind}-enabled`}
              data-testid={`care-schedule-${kind}-enabled`}
              checked={draft.enabled}
              disabled={busy}
              onCheckedChange={(checked) => onChange({ ...draft, enabled: checked })}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`care-schedule-${kind}-frequency`} className="text-xs">
              How often
            </Label>
            <Select
              value={draft.frequency}
              onValueChange={(value) => onChange({ ...draft, frequency: value === 'weekly' ? 'weekly' : 'daily' })}
            >
              <SelectTrigger
                id={`care-schedule-${kind}-frequency`}
                size="sm"
                className="w-32"
                data-testid={`care-schedule-${kind}-frequency`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="daily" data-testid={`care-schedule-${kind}-daily`}>
                    Every day
                  </SelectItem>
                  <SelectItem value="weekly" data-testid={`care-schedule-${kind}-weekly`}>
                    Once a week
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {draft.frequency === 'weekly' ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`care-schedule-${kind}-weekday`} className="text-xs">
                On
              </Label>
              <Select
                value={String(draft.weekday)}
                onValueChange={(value) => onChange({ ...draft, weekday: Number(value) })}
              >
                <SelectTrigger
                  id={`care-schedule-${kind}-weekday`}
                  size="sm"
                  className="w-36"
                  data-testid={`care-schedule-${kind}-weekday`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {WEEKDAYS.map((day) => (
                      <SelectItem
                        key={day.value}
                        value={String(day.value)}
                        data-testid={`care-schedule-${kind}-day-${day.value}`}
                      >
                        {day.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`care-schedule-${kind}-time`} className="text-xs">
              At
            </Label>
            <Input
              id={`care-schedule-${kind}-time`}
              data-testid={`care-schedule-${kind}-time`}
              type="time"
              className="h-8 w-28 text-xs"
              value={draft.atTime}
              disabled={busy}
              onChange={(event) => onChange({ ...draft, atTime: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/*
              The zone is the operator's, not the server's: "every morning" has
              to mean the morning of whoever reads the report, and a wiki run
              from Berlin on a machine in UTC would otherwise be briefed at two
              in the morning without anything saying so.
            */}
            <Label htmlFor={`care-schedule-${kind}-zone`} className="text-xs">
              Time zone
            </Label>
            <Input
              id={`care-schedule-${kind}-zone`}
              data-testid={`care-schedule-${kind}-zone`}
              className="h-8 min-w-0 text-xs"
              value={draft.timezone}
              disabled={busy}
              onChange={(event) => onChange({ ...draft, timezone: event.target.value })}
            />
          </div>
        </div>
      </div>
    </I18nText>
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

/** A `Waited` as a string: the em dash when there is nothing to say (CUI-SEV-2). */
function phrase(
  text: (source: string, values?: Readonly<Record<string, string | number>>) => string,
  waited: Waited,
): string {
  return waited.phrase === null ? '—' : text(waited.phrase, waited.values)
}

function QueueSkeleton(): ReactNode {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading">
      {[0, 1].map((index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="mt-1 h-3 w-64" />
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Skeleton className="h-10 w-24" />
              <Skeleton className="h-10 w-24" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
