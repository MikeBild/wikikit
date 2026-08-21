/**
 * The audit trail, assembled — with no DOM and no API client under it.
 *
 * WikiKit has no `/v1/audit` and this page did not invent one. The installation
 * already keeps four append-only records, each of them the authority for its own
 * kind of event, and none of them was ever readable in one place:
 *
 *  - **decisions** — a change proposal that somebody reviewed (`reviewed_at`,
 *    `reviewer`, `status`);
 *  - **agent runs** — an ingest job that reached a terminal state;
 *  - **page revisions** — the current revision of every page, with its number;
 *  - **guideline revisions** — the charter's version history, the one record in
 *    this product that carries an author by name.
 *
 * They are MERGED here rather than in the page, because the merge is the rule
 * worth testing: what counts as finished, which instant a row is filed under,
 * and what happens to a record that names no actor. A rule that needs a browser
 * to prove it is a rule nobody proves.
 *
 * TWO THINGS THIS FILE REFUSES TO DO, and both are the point of an audit trail:
 *
 * 1. **It files nothing under an instant it invented.** A row whose source
 *    carries no usable timestamp is dropped, not stamped with "now" — a trail
 *    that guesses at the order of two events is worse than one that admits the
 *    event is missing, because the guess is indistinguishable from a reading.
 * 2. **It never fills in an actor.** `actor: null` means the record does not
 *    name one, and it renders as a dash with the footnote beside it. The
 *    plausible-looking alternatives — "system", "WikiKit", the pipeline — are
 *    all attributions nobody wrote down.
 *
 * The present is deliberately absent. A proposal still waiting, an ingest job
 * still running, a capture still to be sorted: those are the decisions queue and
 * the inbox, and a trail that carried them would be a second, worse copy of two
 * live surfaces.
 */

import type { TranslationKey } from '@/lib/i18n'

/** The four records, and the word each one gets in the table's `Art` column. */
export type AuditKind = 'decision' | 'run' | 'revision' | 'guideline'

export type AuditTone = 'success' | 'danger' | 'warning' | 'neutral' | 'unknown'

/** What became of the thing — a catalog key, never a word, so this stays pure. */
export interface AuditOutcome {
  key: TranslationKey
  tone: AuditTone
  values?: Readonly<Record<string, string | number>>
}

export interface AuditEntry {
  /** Stable across renders and unique across the four sources. */
  id: string
  /** The instant the row is filed under, as the record wrote it. */
  at: string
  /** What it was about, verbatim from the record — the page redacts it. */
  subject: string | null
  kind: AuditKind
  outcome: AuditOutcome
  /** The record's own actor, or null where it names none. Never inferred. */
  actor: string | null
}

/* The four source shapes, restated free of the generated client — the same
   split `decisions.logic.ts` keeps, so a test can exercise this with plain
   objects instead of a fetch. */

export interface ProposalRecord {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'failed' | 'split'
  title: string
  reviewer: string | null
  reviewed_at: string | null
  changes_requested: boolean
}

export interface IngestRecord {
  ingest_id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'quota_blocked' | 'captured' | 'discarded'
  title?: string | null
  created_at: string
  started_at?: string | null
  finished_at?: string | null
}

export interface ConceptRecord {
  slug: string
  title: string
  rev: number
  updated_at: string
}

export interface CharterRecord {
  rev: number
  status: 'current' | 'superseded'
  created_by: string | null
  created_at: string
}

export interface AuditSources {
  proposals: readonly ProposalRecord[]
  ingests: readonly IngestRecord[]
  concepts: readonly ConceptRecord[]
  charter: readonly CharterRecord[]
}

/** A usable instant, or null — an unparseable date is a row this trail drops. */
function instant(value: string | null | undefined): string | null {
  if (!value) return null
  return Number.isFinite(new Date(value).getTime()) ? value : null
}

/**
 * How a reviewed proposal ended.
 *
 * `changes_requested` outranks the status word on purpose: the server leaves
 * such a proposal `pending` and marks the flag, so reading the status alone
 * would file "sent back for rework" under nothing at all.
 */
function decisionOutcome(record: ProposalRecord): AuditOutcome | null {
  if (record.changes_requested) return { key: 'audit.outcome.changesRequested', tone: 'warning' }
  switch (record.status) {
    case 'approved':
      return { key: 'audit.outcome.approved', tone: 'success' }
    case 'rejected':
      return { key: 'audit.outcome.rejected', tone: 'danger' }
    case 'split':
      return { key: 'audit.outcome.split', tone: 'neutral' }
    case 'failed':
      return { key: 'audit.outcome.failed', tone: 'danger' }
    // Still waiting for a person — that is the queue's row, not the trail's.
    case 'pending':
      return null
  }
}

/** Only the states an ingest job does not come back from. */
function runOutcome(record: IngestRecord): AuditOutcome | null {
  switch (record.status) {
    case 'done':
      return { key: 'audit.outcome.done', tone: 'success' }
    case 'failed':
      return { key: 'audit.outcome.failed', tone: 'danger' }
    case 'discarded':
      return { key: 'audit.outcome.discarded', tone: 'neutral' }
    // queued, running, quota_blocked, captured: all still in flight or still
    // waiting for a person. The inbox and the queue show them live.
    default:
      return null
  }
}

/**
 * Every finished event these four records know about, newest first.
 *
 * Ties are broken by id so the order is total: two revisions written by one
 * approval carry the same instant, and a table that reshuffled them between two
 * renders would be a trail nobody could cite.
 */
export function auditEntries(sources: AuditSources): AuditEntry[] {
  const entries: AuditEntry[] = []

  for (const record of sources.proposals) {
    const outcome = decisionOutcome(record)
    // The review's own instant, never the proposal's creation: filing a
    // decision under the day the change arrived puts it in the wrong week.
    const at = instant(record.reviewed_at)
    if (!outcome || !at) continue
    entries.push({
      id: `decision:${record.id}`,
      at,
      subject: record.title,
      kind: 'decision',
      outcome,
      actor: record.reviewer?.trim() || null,
    })
  }

  for (const record of sources.ingests) {
    const outcome = runOutcome(record)
    // Finished, else started, else submitted — the sharpest instant the record
    // actually carries for the state it is in.
    const at = instant(record.finished_at) ?? instant(record.started_at) ?? instant(record.created_at)
    if (!outcome || !at) continue
    entries.push({
      id: `run:${record.ingest_id}`,
      at,
      subject: record.title ?? null,
      kind: 'run',
      outcome,
      actor: null,
    })
  }

  for (const record of sources.concepts) {
    const at = instant(record.updated_at)
    if (!at) continue
    entries.push({
      id: `revision:${record.slug}:${record.rev}`,
      at,
      subject: record.title,
      kind: 'revision',
      outcome: { key: 'audit.outcome.revision', tone: 'neutral', values: { rev: record.rev } },
      actor: null,
    })
  }

  for (const record of sources.charter) {
    const at = instant(record.created_at)
    if (!at) continue
    entries.push({
      id: `guideline:${record.rev}`,
      at,
      subject: null,
      kind: 'guideline',
      outcome: {
        key: record.status === 'current' ? 'audit.outcome.guidelineCurrent' : 'audit.outcome.guideline',
        tone: record.status === 'current' ? 'success' : 'neutral',
        values: { rev: record.rev },
      },
      actor: record.created_by?.trim() || null,
    })
  }

  return entries.sort((left, right) => {
    const difference = new Date(right.at).getTime() - new Date(left.at).getTime()
    return difference !== 0 ? difference : left.id.localeCompare(right.id)
  })
}

/** The catalog key for a kind's word — one place, so the table and a test agree. */
export const KIND_LABELS: Record<AuditKind, TranslationKey> = {
  decision: 'audit.kind.decision',
  run: 'audit.kind.run',
  revision: 'audit.kind.revision',
  guideline: 'audit.kind.guideline',
}
