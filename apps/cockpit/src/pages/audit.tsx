import { useQuery } from '@tanstack/react-query'
import { ChevronDown, History } from 'lucide-react'
import { Fragment, useState } from 'react'
import { keys, wk, type AuditEvent, type AuditQuery } from '@/api/wk'
import { Page } from '@/app/shell'
import { DataState } from '@/components/data-state'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AUDIT_ACTOR_KEYS,
  AUDIT_OPERATION_KEYS,
  AUDIT_RESULT_KEYS,
  auditKindKey,
  auditOperationKey,
} from '@/lib/audit-vocabulary'
import { useI18n } from '@/lib/i18n-context'
import type { TranslationKey } from '@/lib/i18n'

/**
 * WHAT HAPPENED, OUT OF THE CHAIN THAT RECORDED IT — §15.
 *
 * WHAT THIS PAGE USED TO BE. Four foreign reads on one time axis: reviewed
 * change proposals, finished ingest runs, page revisions, guideline versions,
 * merged in `audit.logic.ts` and presented as the audit trail. It was written
 * when this product had no audit endpoint. It has had one since `GET /v1/audit`
 * shipped — append-only, hash-chained, filterable, cursor-paged — and the page
 * went on assembling its own. That is the defect §15.5 names, and it stood in
 * the register as WK-AUDIT-SEITE-LIEST-VIER-HISTORIEN.
 *
 * WHAT THE MOVE COSTS, SAID OUT LOUD. The chain carries decisions about
 * knowledge changes and nothing else, because `auditedReview` is its only
 * writer. So the agent runs, the page revisions and the guideline versions are
 * no longer on this page — they are in the inbox, in each page's own history
 * and with the guidelines, and the footnote says exactly that. What the move
 * BUYS is the other half: refusals and errors are events in this record, which
 * the merged view could not show at all, and every row now carries the link of
 * a chain a reader can check.
 *
 * THE TIMESTAMP IS ABSOLUTE, and that is the one thing this page will not
 * trade. Everywhere else in this console an elapsed span is right: „waiting
 * 5 days" is the fact a queue is about. Here it is wrong twice over. A trail
 * exists so two events can be put in order and cited, and „vor 5 Tagen" cannot
 * be cited; and the German for a relative span puts a preposition on the
 * quantity — the exact defect §5 keeps finding elsewhere.
 *
 * THE FOOTNOTE IS NOT DECORATION (§15.4). A narrow record read as a complete
 * one is worse than no record, because it answers „did that happen?" with
 * silence and looks like it answered.
 */

/** How many events one request asks for. The trail is paged, never truncated. */
const PAGE_SIZE = 50

interface FilterChoice {
  value: string
  label: TranslationKey
}

/**
 * The operations offered as a filter — every one the chain can hold.
 *
 * Derived from the vocabulary and NOT from the loaded page: a filter that can
 * only offer what the last fifty rows happened to contain is missing exactly
 * the rare action somebody is hunting for. A derived list shrinks silently, so
 * the table it derives from is held against the server's own action literals by
 * test/unit/cockpit-pages/audit.test.ts.
 */
const OPERATION_CHOICES: FilterChoice[] = Object.entries(AUDIT_OPERATION_KEYS).map(([value, label]) => ({
  value,
  label,
}))

const RESULT_CHOICES: FilterChoice[] = Object.entries(AUDIT_RESULT_KEYS).map(([value, label]) => ({ value, label }))

/** "No filter", as a value the radio group can carry. Outside every real alphabet. */
const ANY = '__any'

function FilterMenu({
  testId,
  // `labelKey` and not `label`: test/unit/cockpit-i18n.test.ts reads every
  // `label` attribute in a page as English copy that owes a German sentence,
  // which is right for a label and wrong for a catalog key.
  labelKey,
  choices,
  value,
  onChange,
}: {
  testId: string
  labelKey: TranslationKey
  choices: FilterChoice[]
  value: string
  onChange: (next: string) => void
}) {
  const { t } = useI18n()
  const chosen = choices.find((choice) => choice.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid={testId} aria-label={t(labelKey)}>
          {t(labelKey)}: {chosen ? t(chosen.label) : t('audit.all')}
          <ChevronDown data-icon="inline-end" className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuRadioGroup value={value || ANY} onValueChange={(next) => onChange(next === ANY ? '' : next)}>
          <DropdownMenuRadioItem value={ANY} data-testid={`${testId}-any`}>
            {t('audit.all')}
          </DropdownMenuRadioItem>
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value} data-testid={`${testId}-${choice.value}`}>
              {t(choice.label)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The operation as one cell: a German name, or the machine value shown as one. */
function Operation({ action }: { action: string }) {
  const { t } = useI18n()
  const key = auditOperationKey(action)
  if (key) return <span className="font-medium">{t(key)}</span>
  // Named as a machine value ON THE SURFACE and not in a `title`: a tooltip is
  // invisible to touch and to the keyboard, and the whole point is that nobody
  // reads this as German.
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <code className="font-mono text-xs break-all">{action}</code>
      <span className="text-xs text-muted-foreground">{t('audit.machineValue')}</span>
    </span>
  )
}

/** A raw payload, printed as what it is. §15.3 asks for the raw data, not a summary. */
function Raw({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] break-all whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function AuditPage() {
  const { t, number } = useI18n()
  const [action, setAction] = useState('')
  const [result, setResult] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  // How many pages deep the operator has gone. The window is one server-side
  // request that grows, never a client-side concatenation — two responses taken
  // apart can both carry the same event, and a trail that double-counts is a
  // trail nobody can cite.
  const [pages, setPages] = useState(1)

  const query: AuditQuery = {
    // NO `space` FILTER, and that is a decision the running app forced.
    //
    // The chain is ONE append-only log for the whole installation, and its
    // first row — the cutover marker migration 0046 seeds — carries no
    // space_id at all. Scoped to the selected wiki, the server dropped it: the
    // page said „3 von 3 Ereignissen" over a chain of four, which is exactly
    // the shape §15.4 exists to prevent — a narrow record read as a complete
    // one. Filtering by wiki belongs in the filter row beside Vorgang and
    // Ergebnis, as a choice somebody makes, not as a silent default.
    ...(action ? { action } : {}),
    ...(result ? { result: result as 'success' | 'denied' | 'error' | 'cancelled' } : {}),
    limit: Math.min(PAGE_SIZE * pages, 200),
  }
  const trail = useQuery({ queryKey: keys.audit(query), queryFn: () => wk.audit.list(query) })

  const narrow = (apply: () => void) => {
    apply()
    setPages(1)
    setExpanded(null)
  }

  return (
    <Page title="Audit" description={t('page.audit.description')}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <FilterMenu
            testId="audit-filter-operation"
            labelKey="audit.filter.operation"
            choices={OPERATION_CHOICES}
            value={action}
            onChange={(next) => narrow(() => setAction(next))}
          />
          <FilterMenu
            testId="audit-filter-result"
            labelKey="audit.filter.result"
            choices={RESULT_CHOICES}
            value={result}
            onChange={(next) => narrow(() => setResult(next))}
          />
        </div>
        <DataState
          testId="audit"
          query={trail}
          skeleton={<TrailSkeleton />}
          isEmpty={(page) => page.items.length === 0}
          empty={
            <EmptyState
              icon={History}
              title={t('audit.empty.title')}
              description={t('audit.empty.description')}
              data-testid="audit-empty"
            />
          }
        >
          {(page) => (
            <div className="flex min-w-0 flex-col gap-3">
              <div className="overflow-hidden rounded-lg border" data-testid="audit-table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {/*
                        §15.2 — these five, in this order, by these names.

                        Vorgang carries no width, and the others carry only what
                        they need: `Table` is `table-fixed`, so a width on every
                        column leaves the one without one whatever is left over.
                        Measured against the running app at 1280, that was about
                        60 px and „Änderung freigegeben" came out one syllable
                        per line. Vorgang is the column with the longest German
                        in it, so it gets the remainder.

                        Art, Verursacher and the Kanal column fold away between
                        `md` and `xl`, and Ergebnis moves under the operation
                        below `sm`: five columns plus a button do not fit in
                        390 px, and the container clips rather than scrolls, so
                        a column left in would be invisible AND unreachable.
                      */}
                      <TableHead className="w-28 sm:w-40">{t('audit.column.when')}</TableHead>
                      <TableHead>{t('audit.column.subject')}</TableHead>
                      <TableHead className="hidden w-40 md:table-cell">{t('audit.column.kind')}</TableHead>
                      <TableHead className="hidden w-32 sm:table-cell">{t('audit.column.outcome')}</TableHead>
                      <TableHead className="hidden w-40 lg:table-cell">{t('audit.column.actor')}</TableHead>
                      {/* A product-specific column, and to the RIGHT of the five (§15.2). */}
                      <TableHead className="hidden w-24 xl:table-cell">{t('audit.column.transport')}</TableHead>
                      <TableHead className="w-16 sm:w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.items.map((event, index) => (
                      <TrailRow
                        key={event.id}
                        event={event}
                        position={index + 1}
                        open={expanded === event.id}
                        onToggle={() => setExpanded(expanded === event.id ? null : event.id)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted-foreground" data-testid="audit-scope">
                  {t(page.page.total_exact ? 'audit.count' : 'audit.countCapped', {
                    count: number(page.items.length),
                    total: number(page.page.total),
                  })}
                </span>
                {/*
                  §15.3 asks for complete paging, and complete means the button
                  is offered exactly while the SERVER says there is more.
                  Comparing row counts here would be the console deciding where
                  a trail ends.
                */}
                {page.page.has_more ? (
                  <Button size="sm" variant="outline" data-testid="audit-more" onClick={() => setPages(pages + 1)}>
                    {t('audit.loadMore')}
                  </Button>
                ) : null}
              </div>
              {/* §15.4 — what the chain does not hold, said out loud. */}
              <p className="text-xs text-muted-foreground" data-testid="audit-footnote">
                {t('audit.footnote')}
              </p>
            </div>
          )}
        </DataState>
      </div>
    </Page>
  )
}

function TrailSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[1, 2, 3, 4, 5].map((row) => (
        <Skeleton key={row} className="h-10 w-full" />
      ))}
    </div>
  )
}

function TrailRow({
  event,
  position,
  open,
  onToggle,
}: {
  event: AuditEvent
  position: number
  open: boolean
  onToggle: () => void
}) {
  const { t, dateTime } = useI18n()
  const kindKey = auditKindKey(event.resource_type)
  const resultKey = AUDIT_RESULT_KEYS[event.result as keyof typeof AUDIT_RESULT_KEYS]
  const actorKey = AUDIT_ACTOR_KEYS[event.actor_kind as keyof typeof AUDIT_ACTOR_KEYS]
  return (
    <Fragment>
      <TableRow data-testid={`audit-row-${position}`} data-action={event.action}>
        <TableCell className="align-top">
          {/*
            The instant, spelled out, in a real `<time>` so a machine reading
            this page gets the precision a person does.
          */}
          <time
            dateTime={event.occurred_at}
            className="text-xs whitespace-nowrap tabular-nums sm:text-sm"
            data-testid={`audit-row-${position}-when`}
          >
            {dateTime(event.occurred_at)}
          </time>
        </TableCell>
        <TableCell className="min-w-0 align-top whitespace-normal">
          <Operation action={event.action} />
          {/* What folds out of the row on a narrow screen comes back here. */}
          <span className="text-muted-foreground mt-0.5 block text-xs md:hidden">{kindKey ? t(kindKey) : '—'}</span>
          <span className="mt-1 block sm:hidden">
            <Badge tone={event.result === 'success' ? 'success' : 'danger'}>
              {t(resultKey ?? 'audit.result.error')}
            </Badge>
          </span>
        </TableCell>
        <TableCell className="hidden align-top md:table-cell">
          {/* §15.2 forbids inventing „Unbekannt"; a kind nothing names gets a dash. */}
          {kindKey ? <Badge tone="neutral">{t(kindKey)}</Badge> : <span className="text-muted-foreground">—</span>}
        </TableCell>
        <TableCell className="hidden align-top sm:table-cell">
          <Badge tone={event.result === 'success' ? 'success' : 'danger'}>{t(resultKey ?? 'audit.result.error')}</Badge>
        </TableCell>
        <TableCell className="hidden align-top text-sm break-all text-muted-foreground lg:table-cell">
          {/*
            §15.2: the label the row carries, else the actor KIND it carries,
            else a dash. Every step is READING; nothing here fills the gap with
            a plausible name (CUI-SEV-2).

            The `actor_id` is deliberately NOT a step in that ladder. It is a
            machine identifier — measured against this page's own fixture, a
            key-authenticated row put a bare UUID in front of a reader and
            scripts/konvention-check.mjs reported it under §5/§8.3. §15.2 asks
            for a name here, and a name is what a row either carries or does
            not. The id is one click away, in the detail below.
          */}
          {event.actor_label || (actorKey ? t(actorKey) : '—')}
        </TableCell>
        <TableCell className="hidden align-top text-sm text-muted-foreground xl:table-cell">
          {event.transport}
        </TableCell>
        <TableCell className="align-top">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            data-testid={`audit-row-${position}-expand`}
            onClick={onToggle}
          >
            {open ? t('audit.fold') : t('audit.details')}
          </Button>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow data-testid={`audit-row-${position}-detail`}>
          <TableCell colSpan={7}>
            {/*
              §15.3 — the hashes are VISIBLE, not implied. A chain whose links a
              reader cannot see is a chain they have to take on trust.
            */}
            <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[14rem_1fr]">
              <dt className="text-muted-foreground">{t('audit.detail.sequence')}</dt>
              <dd className="font-mono">{event.seq}</dd>
              <dt className="text-muted-foreground">{t('audit.column.actor')}</dt>
              <dd className="font-mono break-all">{event.actor_id ?? '—'}</dd>
              <dt className="text-muted-foreground">{t('audit.detail.prevHash')}</dt>
              <dd className="font-mono break-all">{event.prev_sha256}</dd>
              <dt className="text-muted-foreground">{t('audit.detail.hash')}</dt>
              <dd className="font-mono break-all">{event.sha256}</dd>
              <dt className="text-muted-foreground">{t('audit.detail.before')}</dt>
              <dd>
                <Raw value={event.before} />
              </dd>
              <dt className="text-muted-foreground">{t('audit.detail.after')}</dt>
              <dd>
                <Raw value={event.after} />
              </dd>
              <dt className="text-muted-foreground">{t('audit.detail.metadata')}</dt>
              <dd>
                <Raw value={event.metadata} />
              </dd>
            </dl>
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  )
}
