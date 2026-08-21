import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DataState } from '@/components/data-state'
import { EmptyState } from '@/components/empty-state'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useI18n } from '@/lib/i18n-context'
import { readableTitle } from '@/lib/presentation'
import { useSpace } from '@/lib/space'
import type { TranslationKey } from '@/lib/i18n'
import { KIND_LABELS, auditEntries, type AuditEntry, type AuditKind, type AuditSources } from '@/pages/audit.logic'

/**
 * What happened, in the order it happened.
 *
 * WikiKit had no such page and no audit endpoint behind one, and this did not
 * build either. It reads four records the installation already keeps — reviewed
 * change proposals, finished ingest runs, page revisions and the guidelines'
 * version history — and lays them on one time axis. `audit.logic.ts` owns the
 * merge; this file owns the table.
 *
 * THE TIMESTAMP IS ABSOLUTE, and that is the one thing this page will not
 * trade. Everywhere else in this console an elapsed span is right: "waiting
 * 5 days" is the fact a queue is about. Here it is wrong twice over. A trail
 * exists so two events can be put in order and cited, and "vor 5 Tagen" cannot
 * be cited; and the German for a relative span puts a preposition on the
 * quantity — the exact defect §5 keeps finding elsewhere. So the cell prints
 * the instant, in a real `<time>` so a machine reading this page gets the same
 * precision a person does.
 *
 * THE FOOTNOTE IS NOT DECORATION. This trail is narrow: four records, no reads,
 * no sign-ins, no key or permission changes, and — for pages — only the current
 * revision of each. A narrow record read as a complete one is worse than no
 * record, because it answers "did that happen?" with silence and looks like it
 * answered. So the page says what it does not carry, immediately under the
 * table, and it names any source that could not be read at all (§12: a gap
 * appears as a gap, never as quiet).
 */

/** The ceiling on each read. A trail is not a sample, so it asks for the ceiling. */
const LIMIT = 200
const LIST_QUERY = { limit: LIMIT } as const

/** The four records, and what the footnote calls one that could not be read. */
type SourceName = 'proposals' | 'ingests' | 'concepts' | 'charter'

interface Trail {
  sources: AuditSources
  /** Sources the server refused or could not answer — named, never swallowed. */
  unreadable: SourceName[]
}

/**
 * All four reads, settled rather than raced.
 *
 * `Promise.all` would make one refusal — a wiki with no guidelines yet, a key
 * without a scope on one endpoint — into an empty page that says nothing about
 * why. Settling keeps the three that answered AND names the one that did not,
 * which is the honest shape for a record: partial and labelled beats complete
 * and imaginary.
 */
async function readTrail(space: string): Promise<Trail> {
  const [proposals, ingests, concepts, charter] = await Promise.allSettled([
    wk.proposals.list(space, LIST_QUERY),
    wk.ingest.list(space, LIST_QUERY),
    wk.concepts.list(space, LIST_QUERY),
    wk.charter.versions(space),
  ])
  const unreadable: SourceName[] = []
  const took = <T,>(name: SourceName, settled: PromiseSettledResult<{ items: T[] }>): T[] => {
    if (settled.status === 'fulfilled') return settled.value.items
    unreadable.push(name)
    return []
  }
  return {
    sources: {
      proposals: took('proposals', proposals),
      ingests: took('ingests', ingests),
      concepts: took('concepts', concepts),
      charter: took('charter', charter),
    },
    unreadable,
  }
}

export function AuditPage() {
  const space = useSpace()
  const { t } = useI18n()
  const query = useQuery({ queryKey: keys.audit(space), queryFn: () => readTrail(space) })

  return (
    <Page title="Audit" description={t('page.audit.description')}>
      <div className="flex min-w-0 flex-col gap-4">
        <DataState
          testId="audit"
          query={query}
          skeleton={<TrailSkeleton />}
          isEmpty={(trail) => auditEntries(trail.sources).length === 0}
          empty={
            <EmptyState
              icon={History}
              title={t('audit.empty.title')}
              description={t('audit.empty.description')}
              data-testid="audit-empty"
            />
          }
        >
          {(trail) => <TrailTable trail={trail} />}
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

function TrailTable({ trail }: { trail: Trail }) {
  const { t } = useI18n()
  const entries = auditEntries(trail.sources)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/*
        What could NOT be read, above the table rather than under it. A reader
        who has already read the rows has drawn their conclusion; the caveat has
        to arrive before them.
      */}
      {trail.unreadable.length ? (
        <Alert tone="warning" title={t('audit.unreadableTitle')} data-testid="audit-unreadable">
          {t('audit.unreadableDescription', {
            sources: trail.unreadable.map((name) => t(SOURCE_LABELS[name])).join(', '),
          })}
        </Alert>
      ) : null}
      <div className="overflow-hidden rounded-lg border" data-testid="audit-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-52 min-w-40">{t('audit.column.when')}</TableHead>
              <TableHead>{t('audit.column.subject')}</TableHead>
              <TableHead className="hidden w-40 md:table-cell">{t('audit.column.kind')}</TableHead>
              <TableHead className="w-44">{t('audit.column.outcome')}</TableHead>
              <TableHead className="hidden w-44 lg:table-cell">{t('audit.column.actor')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => (
              <TrailRow key={entry.id} entry={entry} position={index + 1} />
            ))}
          </TableBody>
        </Table>
      </div>
      {/*
        §12 — the report names its own scope, and then names what it left out.
        Both sentences, because either one alone reads as a complete record.
      */}
      <p className="text-xs text-muted-foreground" data-testid="audit-scope">
        {t('audit.scope', { count: entries.length, limit: LIMIT })}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="audit-footnote">
        {t('audit.footnote')}
      </p>
    </div>
  )
}

const SOURCE_LABELS: Record<SourceName, TranslationKey> = {
  proposals: 'audit.source.proposals',
  ingests: 'audit.source.ingests',
  concepts: 'audit.source.concepts',
  charter: 'audit.source.charter',
}

/**
 * What a row is called when its record carries no name of its own — a charter
 * revision never has one, an ingest job often does not.
 */
const SUBJECT_FALLBACKS: Record<AuditKind, TranslationKey> = {
  decision: 'audit.subject.decision',
  run: 'audit.subject.run',
  revision: 'audit.subject.revision',
  guideline: 'audit.subject.guideline',
}

function TrailRow({ entry, position }: { entry: AuditEntry; position: number }) {
  const { t, dateTime } = useI18n()
  // §5/§8.3 — a subject is a name, never the identifier a machine wrote. An
  // ingested coding session arrives titled "Codex session <uuid>"; the trail
  // keeps the words and drops the reference.
  const subject = readableTitle(entry.subject, t(SUBJECT_FALLBACKS[entry.kind]))
  return (
    <TableRow data-testid={`audit-row-${position}`} data-kind={entry.kind}>
      <TableCell className="align-top">
        {/*
          The instant, spelled out. `dateTime` formats in the console's locale
          and answers an em dash for anything it cannot parse — but nothing
          unparseable reaches here, because audit.logic.ts drops such a row
          rather than filing it under a guess.
        */}
        <time dateTime={entry.at} className="whitespace-nowrap tabular-nums" data-testid={`audit-row-${position}-when`}>
          {dateTime(entry.at)}
        </time>
      </TableCell>
      <TableCell className="min-w-0 align-top whitespace-normal">
        <span className="block font-medium">{subject.text}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">{t(KIND_LABELS[entry.kind])}</span>
      </TableCell>
      <TableCell className="hidden align-top md:table-cell">
        <Badge tone="neutral">{t(KIND_LABELS[entry.kind])}</Badge>
      </TableCell>
      <TableCell className="align-top">
        <Badge tone={entry.outcome.tone}>{t(entry.outcome.key, entry.outcome.values)}</Badge>
      </TableCell>
      <TableCell className="hidden align-top text-sm text-muted-foreground lg:table-cell">
        {/*
          A record that names nobody gets a dash, never a plausible name
          (CUI-SEV-2). Three of the four sources carry no actor at all; the
          footnote says so, and this cell must not paper over it.
        */}
        {entry.actor ?? '—'}
      </TableCell>
    </TableRow>
  )
}
