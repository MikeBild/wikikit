// The audit trail's merge, and the two refusals that make it a trail.
//
// The page itself is a table; the rule worth holding is what gets into it.
// WikiKit keeps no single audit record — the trail is assembled from four
// existing ones — so every question a reader could ask of it ("is this
// everything?", "who did that?", "in what order?") is answered by this file and
// nowhere else.
//
// Two of the assertions below are about what does NOT happen: no row is filed
// under an instant nobody wrote down, and no actor is filled in for a record
// that names none. Both are the difference between a log and a story.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KIND_LABELS,
  auditEntries,
  type AuditSources,
  type CharterRecord,
  type ConceptRecord,
  type IngestRecord,
  type ProposalRecord,
} from '../../../apps/cockpit/src/pages/audit.logic.ts'
import { CATALOGS, type TranslationKey } from '../../../apps/cockpit/src/lib/i18n.ts'

const at = (iso: string) => `${iso}.000Z`

function proposal(overrides: Partial<ProposalRecord> & { id: string }): ProposalRecord {
  return {
    status: 'approved',
    title: 'Rückgaberecht schärfen',
    reviewer: 'mike@mikebild.com',
    reviewed_at: at('2026-08-18T10:00:00'),
    changes_requested: false,
    ...overrides,
  }
}

function ingest(overrides: Partial<IngestRecord> & { ingest_id: string }): IngestRecord {
  return {
    status: 'done',
    title: 'Support-Handbuch 2026',
    created_at: at('2026-08-17T08:00:00'),
    started_at: at('2026-08-17T08:01:00'),
    finished_at: at('2026-08-17T08:05:00'),
    ...overrides,
  }
}

function sources(overrides: Partial<AuditSources> = {}): AuditSources {
  return { proposals: [], ingests: [], concepts: [], charter: [], ...overrides }
}

describe('only what is finished reaches the trail', () => {
  test('a proposal still waiting is the queue’s row, not the trail’s', () => {
    const entries = auditEntries(
      sources({
        proposals: [proposal({ id: 'a', status: 'pending', reviewed_at: null, reviewer: null })],
      }),
    )
    expect(entries).toEqual([])
  })

  test('every terminal review status is carried, with its own outcome', () => {
    const entries = auditEntries(
      sources({
        proposals: [
          proposal({ id: 'a', status: 'approved' }),
          proposal({ id: 'b', status: 'rejected' }),
          proposal({ id: 'c', status: 'split' }),
          proposal({ id: 'd', status: 'failed' }),
        ],
      }),
    )
    expect(entries.map((entry) => entry.outcome.key).sort()).toEqual([
      'audit.outcome.approved',
      'audit.outcome.failed',
      'audit.outcome.rejected',
      'audit.outcome.split',
    ])
  })

  test('“changes requested” outranks the status word, which the server leaves at pending', () => {
    // The trap this guards: a proposal sent back for rework stays `pending` and
    // carries a flag. Reading the status alone would file the one review a
    // reader most wants to find under nothing at all.
    const entries = auditEntries(
      sources({ proposals: [proposal({ id: 'a', status: 'pending', changes_requested: true })] }),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.outcome.key).toBe('audit.outcome.changesRequested')
  })

  test('a run that is still in flight or still waiting for a person stays out', () => {
    const entries = auditEntries(
      sources({
        ingests: (['queued', 'running', 'quota_blocked', 'captured'] as const).map((status, index) =>
          ingest({ ingest_id: `run-${index}`, status, finished_at: null }),
        ),
      }),
    )
    expect(entries).toEqual([])
  })

  test('a run that ended is carried, whichever way it ended', () => {
    const entries = auditEntries(
      sources({
        ingests: [
          ingest({ ingest_id: 'a', status: 'done' }),
          ingest({ ingest_id: 'b', status: 'failed' }),
          ingest({ ingest_id: 'c', status: 'discarded' }),
        ],
      }),
    )
    expect(entries.map((entry) => entry.outcome.key).sort()).toEqual([
      'audit.outcome.discarded',
      'audit.outcome.done',
      'audit.outcome.failed',
    ])
  })
})

describe('the instant a row is filed under is one somebody wrote down', () => {
  test('a decision is filed under its REVIEW, never under the day the change arrived', () => {
    const entries = auditEntries(
      sources({ proposals: [proposal({ id: 'a', reviewed_at: at('2026-08-19T09:30:00') })] }),
    )
    expect(entries[0]!.at).toBe(at('2026-08-19T09:30:00'))
  })

  test('a run falls back finished → started → submitted, and no further', () => {
    const finished = auditEntries(sources({ ingests: [ingest({ ingest_id: 'a' })] }))
    expect(finished[0]!.at).toBe(at('2026-08-17T08:05:00'))

    const started = auditEntries(sources({ ingests: [ingest({ ingest_id: 'a', finished_at: null })] }))
    expect(started[0]!.at).toBe(at('2026-08-17T08:01:00'))

    const submitted = auditEntries(
      sources({ ingests: [ingest({ ingest_id: 'a', finished_at: null, started_at: null })] }),
    )
    expect(submitted[0]!.at).toBe(at('2026-08-17T08:00:00'))
  })

  test('a record with no usable instant is DROPPED, never stamped with now', () => {
    // The alternative — filing it under the moment the page was opened — is
    // indistinguishable from a reading once it is on screen, and it puts the
    // row at the top of a list sorted by time.
    const entries = auditEntries(
      sources({
        proposals: [proposal({ id: 'a', reviewed_at: 'not a date' })],
        concepts: [{ slug: 'x', title: 'X', rev: 1, updated_at: '' } as ConceptRecord],
      }),
    )
    expect(entries).toEqual([])
  })

  test('newest first, and ties break on a stable key rather than on render order', () => {
    const same = at('2026-08-18T10:00:00')
    const entries = auditEntries(
      sources({
        concepts: [
          { slug: 'zebra', title: 'Zebra', rev: 2, updated_at: same },
          { slug: 'alpha', title: 'Alpha', rev: 2, updated_at: same },
        ],
        proposals: [proposal({ id: 'a', reviewed_at: at('2026-08-19T10:00:00') })],
      }),
    )
    expect(entries.map((entry) => entry.id)).toEqual(['decision:a', 'revision:alpha:2', 'revision:zebra:2'])
  })
})

describe('an actor is read, never inferred', () => {
  test('the two records that name one hand it over verbatim', () => {
    const charter: CharterRecord = {
      rev: 4,
      status: 'current',
      created_by: 'mike@mikebild.com',
      created_at: at('2026-08-16T12:00:00'),
    }
    const entries = auditEntries(sources({ proposals: [proposal({ id: 'a' })], charter: [charter] }))
    expect(entries.map((entry) => entry.actor)).toEqual(['mike@mikebild.com', 'mike@mikebild.com'])
  })

  test('the two records that name none answer null, not a plausible stand-in', () => {
    const entries = auditEntries(
      sources({
        ingests: [ingest({ ingest_id: 'a' })],
        concepts: [{ slug: 'x', title: 'X', rev: 3, updated_at: at('2026-08-15T12:00:00') }],
      }),
    )
    expect(entries.map((entry) => entry.actor)).toEqual([null, null])
  })

  test('a blank name is an unnamed actor, not a name made of spaces', () => {
    const entries = auditEntries(sources({ proposals: [proposal({ id: 'a', reviewer: '   ' })] }))
    expect(entries[0]!.actor).toBeNull()
  })
})

describe('the words it hands the table are catalog keys', () => {
  test('every kind and every outcome resolves in both catalogs', () => {
    const charter: CharterRecord = {
      rev: 2,
      status: 'superseded',
      created_by: null,
      created_at: at('2026-08-10T12:00:00'),
    }
    const entries = auditEntries(
      sources({
        proposals: [
          proposal({ id: 'a', status: 'approved' }),
          proposal({ id: 'b', status: 'rejected' }),
          proposal({ id: 'c', status: 'split' }),
          proposal({ id: 'd', status: 'failed' }),
          proposal({ id: 'e', status: 'pending', changes_requested: true }),
        ],
        ingests: [
          ingest({ ingest_id: 'a', status: 'done' }),
          ingest({ ingest_id: 'b', status: 'failed' }),
          ingest({ ingest_id: 'c', status: 'discarded' }),
        ],
        concepts: [{ slug: 'x', title: 'X', rev: 3, updated_at: at('2026-08-15T12:00:00') }],
        charter: [charter, { ...charter, rev: 3, status: 'current' }],
      }),
    )
    const keys: TranslationKey[] = [...entries.map((entry) => entry.outcome.key), ...Object.values(KIND_LABELS)]
    for (const key of keys) {
      expect(CATALOGS.en[key], `en ${key}`).toBeDefined()
      expect(CATALOGS.de[key], `de ${key}`).toBeDefined()
    }
  })

  test('a revision names its number, so the outcome is not the same word on every row', () => {
    const entries = auditEntries(
      sources({ concepts: [{ slug: 'x', title: 'X', rev: 7, updated_at: at('2026-08-15T12:00:00') }] }),
    )
    expect(entries[0]!.outcome.values).toEqual({ rev: 7 })
  })
})

describe('the page says what it is not', () => {
  /*
    The footnote is the reason a narrow record can be published at all, so it is
    held here rather than left to a reviewer's eye: a trail without it reads as
    complete, and "did that happen?" is then answered by silence.
  */
  const page = readFileSync(join(import.meta.dir, '../../../apps/cockpit/src/pages/audit.tsx'), 'utf8')

  test('the footnote is rendered, and it is the catalog’s', () => {
    expect(page).toContain('data-testid="audit-footnote"')
    expect(page).toContain("t('audit.footnote')")
    for (const locale of ['en', 'de'] as const) {
      expect(CATALOGS[locale]['audit.footnote'].length).toBeGreaterThan(80)
    }
  })

  test('the timestamp is absolute — no relative prose on this page', () => {
    // §5: every German relative span puts a preposition on the quantity, and a
    // trail exists to be cited rather than skimmed.
    expect(page).toContain('dateTime(entry.at)')
    // The name at all, in a file whose prose therefore avoids it: a page that
    // may not render a relative timestamp may not import one either, and the
    // narrower probe would pass on an unused import that a later edit uses.
    expect(page).not.toContain('RelativeTime')
    expect(page).not.toContain('relative-time')
  })
})
