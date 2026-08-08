import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Radio, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ApiError } from '@/api/client'
import type { components } from '@/api/schema'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { SegmentedControl } from '@/components/controls'
import { CopyButton } from '@/components/copy-button'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RelativeTime } from '@/components/ui/relative-time'
import { useNow } from '@/hooks/use-now'
import { useTableView } from '@/hooks/use-table-view'
import { firstPage, type CursorPage } from '@/lib/cursor'
import { describeFailure } from '@/lib/failure'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { compareText, compareTime } from '@/lib/table-view'
import { STATUS_STATE, type DomainState } from '@/lib/tokens'
import { DELIVERY_CAP_NOTE, DELIVERY_CEILING, deliverySubject } from '@/pages/webhooks.logic'

/**
 * Where this wiki tells other systems what happened.
 *
 * An endpoint is a URL WikiKit posts signed events to; a delivery is one
 * attempt at one event. The page is two lists because the two questions an
 * operator arrives with are different questions: "is this endpoint being
 * talked to at all" is answered by the endpoint row, and "why did last night's
 * approval never reach us" is answered by a delivery.
 *
 * The fact that makes this page worth having is the circuit breaker. WikiKit
 * does not merely retry a failing endpoint — after enough consecutive failures
 * it stops calling it for a while and keeps queueing the events for when the
 * window closes. From outside, an endpoint inside that window looks exactly
 * like a healthy one that nothing has happened for, and an operator debugging
 * "our webhooks stopped" will spend the evening on their own firewall. So the
 * breaker is a status word on the row, with the moment it reopens beside it.
 */

/** Derived from the facade so a field the server stops sending stops compiling. */
type Endpoint = Awaited<ReturnType<typeof wk.webhooks.list>>['items'][number]
type Delivery = Awaited<ReturnType<typeof wk.webhooks.deliveries>>['items'][number]

/**
 * The event types an endpoint may subscribe to.
 *
 * The array is written out — a page cannot iterate a TypeScript union — but it
 * is checked against the generated request type, so an event the server renames
 * or drops is a compile error here rather than a 400 an operator meets at
 * runtime. (A NEW event type the server adds is not caught by this; it only
 * fails to be offered, which is the safe direction.)
 */
type WebhookEvent = NonNullable<components['schemas']['zCreateWebhookRequest']['events']>[number]

const EVENT_TYPES = [
  { id: 'wikikit.proposal.created', label: 'A change was raised' },
  { id: 'wikikit.proposal.approved', label: 'A change was approved' },
  { id: 'wikikit.proposal.rejected', label: 'A change was rejected' },
  { id: 'wikikit.proposal.changes_requested', label: 'A change was sent back' },
  { id: 'wikikit.proposal.split', label: 'A change was split' },
  { id: 'wikikit.concept.updated', label: 'A page changed' },
  { id: 'wikikit.ingest.failed', label: 'A document could not be added' },
  { id: 'wikikit.source.tombstoned', label: 'A source was forgotten' },
] as const satisfies readonly { id: WebhookEvent; label: string }[]

/** The five domain states as badge tones. See `sources.tsx` for the same table. */
const BADGE_TONE = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
} as const satisfies Record<DomainState, string>

/**
 * A delivery's status, in the reader's words.
 *
 * The stored vocabulary is `pending | delivered | failed | dead`, and two of
 * those mislead if printed raw. `failed` is ONE attempt that did not land — the
 * delivery is still scheduled and will be tried again — while `dead` is the one
 * that has run out of attempts and will never be tried again. An operator who
 * reads "failed" as final chases an event that is about to arrive; one who
 * reads "dead" as another retry waits for something that is never coming.
 */
const DELIVERY_WORDS: Record<string, string> = {
  pending: 'Waiting',
  delivered: 'Delivered',
  failed: 'Retrying',
  dead: 'Given up',
}

/**
 * Which state a delivery status is.
 *
 * `STATUS_STATE` answers three of the four — `delivered`, `failed` and
 * `pending` are all in the shared table — and has no entry for `dead`, which is
 * the terminal give-up. Falling through to `unknown` there would paint the one
 * status that means "this event never arrived and never will" in the muted tone
 * reserved for things nobody has measured, so it is named here rather than left
 * to the fallback.
 */
function deliveryState(status: string): DomainState {
  if (status === 'dead') return 'failed'
  return STATUS_STATE[status] ?? 'unknown'
}

/**
 * What an endpoint is doing, as a word and a state.
 *
 * Three conditions, and the middle one is the whole reason this function
 * exists. `disabled_until` in the future is the circuit breaker holding the
 * endpoint off — `STATUS_STATE` already carries `circuit_open` for exactly
 * this, which is a console-derived condition rather than a column: the server
 * stores a timestamp, and the word for the timestamp being in the future is
 * ours to say.
 */
function endpointCondition(endpoint: Endpoint, now: number): { status: string; word: string; state: DomainState } {
  if (!endpoint.active) return { status: 'removed', word: 'Switched off', state: STATUS_STATE.removed ?? 'unknown' }
  const until = endpoint.disabled_until ? Date.parse(endpoint.disabled_until) : Number.NaN
  if (!Number.isNaN(until) && until > now)
    return { status: 'circuit_open', word: 'Circuit open', state: STATUS_STATE.circuit_open ?? 'failed' }
  return { status: 'active', word: 'Delivering', state: STATUS_STATE.active ?? 'succeeded' }
}

/**
 * The secret out of a create response.
 *
 * `wk.webhooks.create` is typed `unknown` in the facade, so this narrows rather
 * than asserting: the value is read once, at the only moment it will ever
 * exist, and a server that stopped sending it must produce a visible "no secret
 * came back" rather than the string "undefined" in a box telling the operator to
 * store it forever.
 */
function readSecret(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const secret = (value as { secret?: unknown }).secret
  return typeof secret === 'string' ? secret : null
}

export function WebhooksPage() {
  const space = useSpace()
  const can = useCan()
  const now = useNow()

  const [endpointPage, setEndpointPage] = useState<CursorPage>(firstPage)
  const [deliveryPage, setDeliveryPage] = useState<CursorPage>(firstPage)
  const [registering, setRegistering] = useState(false)
  /**
   * Which endpoint's deliveries are on screen.
   *
   * In component state rather than in the URL, which is the deliberate
   * exception to "a view is an address" and not a lapse: the id addresses a row
   * that only exists in this wiki's admin surface, and the thing worth sending
   * somebody — "our webhooks stopped" — is the page, not the row somebody
   * happened to be standing on. `null` means "whichever is first", so the panel
   * below is never empty for a reason the operator has to work out.
   */
  const [chosen, setChosen] = useState<string | null>(null)

  const endpointsQuery = useQuery({
    queryKey: keys.webhooks(space),
    queryFn: () => wk.webhooks.list(space),
  })

  const endpoints = useMemo(() => endpointsQuery.data?.items ?? [], [endpointsQuery.data])
  // Derived, not synchronised: an effect that picked the first endpoint on load
  // would render twice and then argue with an operator who chose a different
  // one before the response landed.
  const selected = endpoints.find((endpoint) => endpoint.id === chosen) ?? endpoints[0] ?? null

  const deliveriesQuery = useQuery({
    // The key stays `(space, id)` and does not carry the limit, unlike the
    // stream read on the sources page. There the limit is half of a key a
    // mutation has to invalidate by hand, so the two must agree; here nothing
    // mutates deliveries and `DELIVERY_CEILING` is a module constant that
    // cannot vary between two renders — putting it in the key would only add a
    // second place for it to be wrong.
    queryKey: keys.webhookDeliveries(space, selected?.id ?? 'none'),
    // The ceiling, asked for explicitly. Naming no limit is not "everything",
    // it is fifty (`clampLimit(args.limit, 50, 200)`) — and silently, which is
    // the failure this page's whole delivery panel exists to avoid.
    queryFn: () => wk.webhooks.deliveries(space, selected!.id, { limit: DELIVERY_CEILING }),
    enabled: selected !== null,
  })

  // Held once rather than read twice: the sentence above the table and the
  // table's own ceiling are two statements about the same answer, and reading
  // the cache separately for each is how they end up disagreeing mid-refetch.
  const deliveries = deliveriesQuery.data?.items ?? []

  const mayAdmin = can('admin')

  const endpointColumns = useMemo<readonly DataColumn<Endpoint>[]>(
    () => [
      {
        id: 'url',
        label: 'Endpoint',
        required: true,
        compare: (left, right) => compareText(left.url, right.url),
        cell: (row) => (
          // Text, not an anchor. A webhook target is a machine's address, and
          // making it a link invites an operator to open a POST-only URL in a
          // tab and read a 405 as evidence the endpoint is broken.
          <span className="block max-w-[42ch] truncate font-mono text-xs" data-testid={`webhook-url-${row.id}`}>
            {row.url}
          </span>
        ),
      },
      {
        id: 'condition',
        label: 'Condition',
        cell: (row) => {
          const condition = endpointCondition(row, now)
          return (
            <div className="flex flex-col gap-1">
              {/* The word as well as the colour (CUI-A11Y-5). */}
              <Badge tone={BADGE_TONE[condition.state]} data-testid={`webhook-condition-${row.id}`}>
                {condition.word}
              </Badge>
              {condition.status === 'circuit_open' && row.disabled_until ? (
                <span className="text-muted-foreground text-xs">
                  Paused until <RelativeTime value={row.disabled_until} data-testid={`webhook-until-${row.id}`} />
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: 'events',
        label: 'Subscribed to',
        cell: (row) =>
          // An empty array is not an absence: the API reads "no events named" as
          // "every event", so it must never render as an em dash.
          row.events.length === 0 ? (
            <span className="text-xs">Every event</span>
          ) : (
            <div className="flex flex-wrap gap-1" data-testid={`webhook-events-${row.id}`}>
              {row.events.map((event) => (
                <Badge key={event} tone="neutral" className="font-mono text-[10px]">
                  {event.replace('wikikit.', '')}
                </Badge>
              ))}
            </div>
          ),
      },
      {
        id: 'failures',
        label: 'Failures in a row',
        cell: (row) => (
          // A measured zero, printed as zero. The em-dash rule is for a value
          // nobody sent; this endpoint has been counted and the count is none.
          <span className="tabular-nums" data-testid={`webhook-failures-${row.id}`}>
            {row.failure_count}
          </span>
        ),
      },
      {
        id: 'created',
        label: 'Registered',
        descFirst: true,
        hiddenByDefault: true,
        compare: (left, right) => compareTime(left.created_at, right.created_at),
        cell: (row) => <RelativeTime value={row.created_at} />,
      },
      {
        id: 'actions',
        label: 'Actions',
        headerHidden: true,
        required: true,
        className: 'text-right',
        cell: (row) => (
          <Button
            variant={selected?.id === row.id ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={selected?.id === row.id}
            data-testid={`webhook-inspect-${row.id}`}
            onClick={() => {
              setChosen(row.id)
              // A new endpoint is a new result: the delivery walk starts again
              // rather than opening in the middle of a list nobody has seen the
              // start of.
              setDeliveryPage(firstPage)
            }}
          >
            <Send data-icon="inline-start" />
            Deliveries
          </Button>
        ),
      },
    ],
    [now, selected?.id],
  )

  const deliveryColumns = useMemo<readonly DataColumn<Delivery>[]>(
    () => [
      {
        id: 'event',
        label: 'Event',
        required: true,
        compare: (left, right) => compareText(left.event_type, right.event_type),
        cell: (row) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-xs">{row.event_type.replace('wikikit.', '')}</span>
            <code className="text-muted-foreground font-mono text-[11px]" data-testid={`delivery-event-${row.id}`}>
              {row.event_id}
            </code>
          </div>
        ),
      },
      {
        id: 'status',
        label: 'Status',
        compare: (left, right) => compareText(left.status, right.status),
        cell: (row) => (
          <Badge tone={BADGE_TONE[deliveryState(row.status)]} data-testid={`delivery-status-${row.id}`}>
            {DELIVERY_WORDS[row.status] ?? row.status}
          </Badge>
        ),
      },
      {
        id: 'attempt',
        label: 'Attempts',
        cell: (row) => (
          <span className="tabular-nums" data-testid={`delivery-attempt-${row.id}`}>
            {row.attempt}
          </span>
        ),
      },
      {
        id: 'response',
        label: 'Answered',
        // Genuinely absent: a delivery that never reached the endpoint has no
        // response status, and `0` would read as a status code (CUI-SEV-2).
        cell: (row) => (
          <span className="tabular-nums" data-testid={`delivery-response-${row.id}`}>
            {row.response_status ?? '—'}
          </span>
        ),
      },
      {
        id: 'next',
        label: 'Next attempt',
        compare: (left, right) => compareTime(left.next_attempt_at, right.next_attempt_at),
        cell: (row) =>
          row.next_attempt_at ? (
            <RelativeTime value={row.next_attempt_at} data-testid={`delivery-next-${row.id}`} />
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          ),
      },
      {
        id: 'error',
        label: 'What went wrong',
        cell: (row) =>
          row.last_error ? (
            // The endpoint's own words, never rewritten (CUI-LOAD-2). Truncated
            // on screen, whole in the title of nothing: the full text is the
            // cell's own content, so a screen reader and a copy both get it.
            <span className="block max-w-[36ch] truncate text-xs" data-testid={`delivery-error-${row.id}`}>
              {row.last_error}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          ),
      },
      {
        id: 'created',
        label: 'Queued',
        descFirst: true,
        compare: (left, right) => compareTime(left.created_at, right.created_at),
        cell: (row) => <RelativeTime value={row.created_at} />,
      },
    ],
    [],
  )

  const endpointView = useTableView('webhooks', endpointColumns)
  const deliveryView = useTableView('deliveries', deliveryColumns)

  return (
    <Page
      title="Webhooks"
      description="Where this wiki tells other systems what happened — and, when something stopped arriving, which attempt failed and why."
      actions={
        <DisabledReason reason={mayAdmin ? null : 'Needs admin'} data-testid="register-endpoint-reason">
          <Button data-testid="register-endpoint" disabled={!mayAdmin} onClick={() => setRegistering(true)}>
            <Plus data-icon="inline-start" />
            Register an endpoint
          </Button>
        </DisabledReason>
      }
    >
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-3" aria-labelledby="endpoints-heading">
          <h2 id="endpoints-heading" className="text-sm font-semibold">
            Endpoints
          </h2>
          <DataTable
            testId="webhooks"
            columns={endpointColumns}
            rows={endpoints}
            rowKey={(row) => row.id}
            rowTestId={(row) => `webhook-row-${row.id}`}
            rowAttributes={(row) => ({ 'data-condition': endpointCondition(row, now).status })}
            query={endpointsQuery}
            view={endpointView.view}
            onViewChange={endpointView.setView}
            page={endpointPage}
            onPageChange={setEndpointPage}
            unit="endpoints"
            // No `cap`, checked rather than assumed: `listWebhookEndpoints`
            // selects with an order and no limit, and `db.select` emits a LIMIT
            // clause only when it is given one — so this read really is every
            // endpoint in the wiki and the footer's "of N" is a total. The
            // deliveries table below is the one with a ceiling.
            empty={
              <EmptyState
                icon={Radio}
                framed={false}
                title="No endpoints registered"
                description="Nothing outside WikiKit is being told about this wiki. Register a URL and WikiKit posts a signed event to it whenever a change is raised, approved or rejected."
                data-testid="webhooks-empty-state"
                action={
                  <DisabledReason reason={mayAdmin ? null : 'Needs admin'}>
                    <Button
                      data-testid="register-endpoint-empty"
                      disabled={!mayAdmin}
                      onClick={() => setRegistering(true)}
                    >
                      <Plus data-icon="inline-start" />
                      Register an endpoint
                    </Button>
                  </DisabledReason>
                }
              />
            }
          />
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="deliveries-heading">
          <div className="flex flex-col gap-1">
            <h2 id="deliveries-heading" className="text-sm font-semibold">
              Deliveries
            </h2>
            <p className="text-muted-foreground text-sm" data-testid="deliveries-subject">
              {selected
                ? // `data`, not `deliveries.length`: a read still in the air and
                  // a read that answered nothing are the same empty array, and
                  // only one of them may be described as every attempt there is.
                  deliverySubject(selected.url, deliveriesQuery.data ? deliveries.length : null)
                : 'One attempt at one event. Register an endpoint and its attempts appear here.'}
            </p>
          </div>
          {selected ? (
            <DataTable
              testId="deliveries"
              columns={deliveryColumns}
              rows={deliveries}
              rowKey={(row) => row.id}
              rowTestId={(row) => `delivery-row-${row.id}`}
              rowAttributes={(row) => ({ 'data-status': row.status })}
              query={deliveriesQuery}
              view={deliveryView.view}
              onViewChange={deliveryView.setView}
              page={deliveryPage}
              onPageChange={setDeliveryPage}
              unit="deliveries"
              // The ceiling stated unconditionally: `isCapped` only speaks once
              // the rows reach it, and nothing on this page narrows the answer
              // before it gets here, so the row count IS the response count and
              // the two-step `atCeiling ? rows.length : null` the filtered lists
              // need would say the same thing with more moving parts.
              cap={DELIVERY_CEILING}
              capNote={DELIVERY_CAP_NOTE}
              empty={
                <EmptyState
                  icon={Send}
                  framed={false}
                  title="Nothing has been sent yet"
                  description="This endpoint is registered and no event it subscribes to has happened since. That is good news, not a fault — raise or approve a change and the first delivery appears here."
                  data-testid="deliveries-empty-state"
                />
              }
            />
          ) : null}
        </section>
      </div>

      <RegisterEndpoint space={space} open={registering} onOpenChange={setRegistering} />
    </Page>
  )
}

/**
 * Registering an endpoint, and then handing over its signing secret.
 *
 * Two states in one dialog, for the same reason the API key dialog has two: the
 * response carries a `whsec_` secret that WikiKit encrypts and never shows
 * again, and it is the only thing the receiving system can verify a delivery's
 * signature with. A dialog that closed on success would report a success that
 * had thrown away the one value making the endpoint usable — so the outcome
 * replaces the form, and only an explicit acknowledgement closes it.
 */
function RegisterEndpoint({
  space,
  open,
  onOpenChange,
}: {
  space: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()

  const [url, setUrl] = useState('')
  const [scope, setScope] = useState<'all' | 'some'>('all')
  const [events, setEvents] = useState<readonly WebhookEvent[]>([])
  /** The signing secret, held only until this dialog closes. Never in the query cache. */
  const [secret, setSecret] = useState<string | null>(null)
  /** True once the endpoint exists, whether or not a secret came back with it. */
  const [registered, setRegistered] = useState(false)

  const register = useMutation({
    mutationFn: () =>
      wk.webhooks.create(space, {
        url: url.trim(),
        // Omitted entirely rather than sent empty: the API reads "no events
        // named" as "every event", and spelling out all eight would freeze this
        // endpoint's subscription at the eight that existed today.
        ...(scope === 'some' ? { events } : {}),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: keys.webhooks(space) })
      setRegistered(true)
      setSecret(readSecret(result))
    },
  })

  function reset() {
    setUrl('')
    setScope('all')
    setEvents([])
    setSecret(null)
    setRegistered(false)
    register.reset()
  }

  const problem =
    url.trim().length === 0
      ? 'Give the endpoint an address'
      : !/^https:\/\/\S+$/i.test(url.trim())
        ? 'The address has to be an https:// URL'
        : scope === 'some' && events.length === 0
          ? 'Choose at least one event'
          : null

  const refusal = register.error
    ? describeFailure({
        status: register.error instanceof ApiError ? register.error.status : null,
        message: register.error instanceof Error ? register.error.message : String(register.error),
        actions: register.error instanceof ApiError ? register.error.nextBestActions : [],
      })
    : null

  const locked = register.isPending || registered

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A request in the air, or a secret on screen that exists exactly once:
        // neither is dismissed by a stray click.
        if (locked) return
        reset()
        onOpenChange(next)
      }}
    >
      <DialogContent data-testid="register-endpoint-dialog" closeDisabled={locked} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{registered ? 'Copy this signing secret now' : 'Register an endpoint'}</DialogTitle>
          <DialogDescription>
            {registered
              ? 'WikiKit signs every delivery with this secret and stores it encrypted. This screen is the one and only place it will ever appear.'
              : 'WikiKit posts a signed event to this URL whenever something it subscribes to happens in this wiki. An endpoint that keeps refusing is paused for a while and the events queue up until it comes back.'}
          </DialogDescription>
        </DialogHeader>

        {registered ? (
          <div className="flex flex-col gap-3 overflow-y-auto">
            {secret ? (
              <>
                <Alert
                  tone="warning"
                  title="This secret will never be shown again"
                  data-testid="webhook-secret-warning"
                  actions={[
                    'Put it in the receiving system before you close this.',
                    'If you lose it, register the endpoint again and delete this one — it cannot be recovered.',
                  ]}
                >
                  The receiving system verifies every delivery's signature with it. Without it, it cannot tell a WikiKit
                  event from anything else that can reach the URL.
                </Alert>
                <div className="border-border bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
                  <code
                    data-testid="webhook-secret-value"
                    className="font-mono text-xs break-all select-all"
                    aria-label="The webhook signing secret"
                  >
                    {secret}
                  </code>
                  <CopyButton value={secret} label="Copy secret" data-testid="webhook-secret-copy" />
                </div>
              </>
            ) : (
              <Alert tone="danger" title="The endpoint was registered without a secret" data-testid="webhook-no-secret">
                WikiKit created the endpoint but sent no signing secret back, so there is nothing to give the receiving
                system. Delete this endpoint and register it again; if it happens twice, this deployment's webhook
                surface needs looking at before anything is wired to it.
              </Alert>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 overflow-y-auto">
            <div className="flex flex-col gap-2">
              <Label htmlFor="endpoint-url">Address</Label>
              <Input
                id="endpoint-url"
                data-testid="endpoint-url"
                type="url"
                inputMode="url"
                value={url}
                placeholder="https://example.com/hooks/wikikit"
                onChange={(event) => setUrl(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                An https:// address WikiKit can reach. Deliveries are POSTs, so this URL never needs to answer a
                browser.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              {/* Not a <Label>: a group of controls, not one labelable field. */}
              <span className="text-sm leading-none font-medium">What should it hear about?</span>
              <SegmentedControl
                label="Which events"
                data-testid="endpoint-scope"
                value={scope}
                options={[
                  { id: 'all' as const, label: 'Everything' },
                  { id: 'some' as const, label: 'Only these' },
                ]}
                onChange={setScope}
              />
              {scope === 'all' ? (
                <p className="text-muted-foreground text-xs">
                  Including event types added in later releases — an endpoint that subscribes to everything keeps
                  subscribing to everything.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5" role="group" aria-label="Event types">
                  {EVENT_TYPES.map((event) => {
                    const chosen = events.includes(event.id)
                    return (
                      <button
                        key={event.id}
                        type="button"
                        aria-pressed={chosen}
                        data-testid={`endpoint-event-${event.id}`}
                        onClick={() =>
                          setEvents(chosen ? events.filter((entry) => entry !== event.id) : [...events, event.id])
                        }
                        className={`flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left ${
                          chosen ? 'border-accent bg-accent/10' : 'border-border hover:bg-muted'
                        }`}
                      >
                        <span className="text-sm">{event.label}</span>
                        <span className="text-muted-foreground font-mono text-[11px]">{event.id}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {refusal ? (
              <Alert
                tone={refusal.tone}
                title={refusal.title}
                actions={refusal.actions}
                data-testid="register-endpoint-refusal"
              >
                {refusal.message}
              </Alert>
            ) : null}
          </div>
        )}

        <DialogFooter data-testid="register-endpoint-footer">
          {registered ? (
            <Button
              data-testid="webhook-secret-done"
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
            >
              I have stored it — close
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                data-testid="register-endpoint-cancel"
                disabled={register.isPending}
                onClick={() => {
                  reset()
                  onOpenChange(false)
                }}
              >
                Cancel
              </Button>
              <DisabledReason reason={problem}>
                {/* The label stays the promise it made while the request is in
                    the air (CUI-ACT-5); the spinner is what says it is working. */}
                <Button
                  data-testid="register-endpoint-submit"
                  disabled={problem !== null || register.isPending}
                  aria-busy={register.isPending}
                  onClick={() => register.mutate()}
                >
                  {register.isPending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                  Register endpoint
                </Button>
              </DisabledReason>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
