// The output loop's wire shapes, held to their promises (CONTRACTS §5.2/§5.3).
//
// The neighbouring response-schemas suite proves that the handlers PRODUCE
// something each schema accepts. This file asserts the opposite direction: what
// each schema REFUSES, and which of its fields a consumer may rely on being
// present. Those two are different failures — a handler that quietly stopped
// sending `output_id` is caught over there, whereas a schema that was loosened
// so a null could stand in for a missing answer, or a verdict could be bolted
// onto the health report, is only caught here.
//
// No app, no database: these are the shapes themselves, which is the whole
// point — a generated client is built from them, not from a running server.
import { describe, expect, test } from 'bun:test'
import {
  zOutputListResponse,
  zOutputPromotedResponse,
  zOutputResponse,
  zQueryResponse,
  zScheduleListResponse,
  zSpaceHealthResponse,
} from '../../src/http/schemas.ts'

const OUTPUT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const RUN_ID = '99999999-9999-4999-8999-999999999999'
const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const JOB_ID = '77777777-7777-4777-8777-777777777777'
const SOURCE_ID = '55555555-5555-4555-8555-555555555555'
const CHUNK_ID = '44444444-4444-4444-8444-444444444444'

/** A pre-0.35 answer, field for field. Nothing here may become optional. */
const ANSWER_BEFORE = {
  answer_markdown: '# WikiKit\n\nA headless knowledge system.',
  citations: [{ slug: 'wikikit', title: 'WikiKit' }],
  not_in_knowledge_base: false,
  agent_run_id: RUN_ID,
  source_citations: [{ source_id: SOURCE_ID, chunk_id: CHUNK_ID, title: 'A note' }],
}

describe('zQueryResponse carries output_id (additive)', () => {
  test('output_id is the handle promotion needs, and it is always present', () => {
    const parsed = zQueryResponse.parse({ ...ANSWER_BEFORE, output_id: OUTPUT_ID })
    expect(parsed.output_id).toBe(OUTPUT_ID)
  })

  test('null is a legal value — the answer was produced but not persisted', () => {
    // The answer is synthesized and paid for before the row is written, so a
    // failed insert must not throw the response away. Null means "there is
    // nothing to promote", never "the answer is bad".
    expect(zQueryResponse.parse({ ...ANSWER_BEFORE, output_id: null }).output_id).toBeNull()
  })

  test('the field is nullable, NOT optional — omitting it is a break', () => {
    // A client reading `response.output_id` must be able to distinguish "no
    // output" from "this server predates outputs" without probing. If the field
    // were optional both would arrive as undefined.
    expect(zQueryResponse.safeParse(ANSWER_BEFORE).success).toBe(false)
  })

  test('every field the answer had before is still required', () => {
    for (const field of Object.keys(ANSWER_BEFORE)) {
      const without = { ...ANSWER_BEFORE, output_id: OUTPUT_ID } as Record<string, unknown>
      delete without[field]
      expect(zQueryResponse.safeParse(without).success, `${field} became optional`).toBe(false)
    }
  })
})

describe('zOutputResponse: one shape for three kinds', () => {
  const answer = {
    id: OUTPUT_ID,
    space_id: SPACE_ID,
    kind: 'answer' as const,
    title: 'What is WikiKit?',
    question: 'What is WikiKit?',
    summary: 'A concise explanation of WikiKit.',
    markdown: '# What is WikiKit?\n',
    citations: [{ slug: 'wikikit', title: 'WikiKit' }],
    not_in_knowledge_base: false,
    agent_run_id: RUN_ID,
    promoted_ingest_id: null,
    promoted_at: null,
    created_at: '2026-07-15T12:00:00.000Z',
  }

  test('an answer parses whole', () => {
    expect(zOutputResponse.parse(answer).kind).toBe('answer')
  })

  test('a briefing has no question and no coverage verdict, and both are null', () => {
    // Not false, and not an empty string: nobody asked a briefing anything, so
    // "the wiki did not cover it" is a statement about nothing. The nullability
    // of these two fields is what lets one list hold all three kinds.
    const briefing = {
      ...answer,
      kind: 'briefing' as const,
      title: 'Briefing 2026-07-15',
      question: null,
      not_in_knowledge_base: null,
      agent_run_id: null,
      citations: [],
    }
    const parsed = zOutputResponse.parse(briefing)
    expect(parsed.question).toBeNull()
    expect(parsed.not_in_knowledge_base).toBeNull()
  })

  test('kind is a closed set — the database CHECK, restated on the wire', () => {
    expect(zOutputResponse.safeParse({ ...answer, kind: 'summary' }).success).toBe(false)
  })

  test('space_id rides on the row because /v1/outputs/{id} is global-by-id', () => {
    // The id came from /query or from the list and carries no space, so the
    // transport enforces the key/space match against this field. Dropping it
    // would make the by-id route unauthorizable.
    const { space_id: _dropped, ...withoutSpace } = answer
    expect(zOutputResponse.safeParse(withoutSpace).success).toBe(false)
  })

  test('a promoted row names the job it opened, and the list serves full rows', () => {
    const promoted = { ...answer, promoted_ingest_id: JOB_ID, promoted_at: '2026-07-16T09:00:00.000Z' }
    const page = zOutputListResponse.parse({ items: [answer, promoted], next_before: null })
    // Full markdown in the LIST, not only in the detail: a page of questions
    // nobody can read without a request per row is a page nobody reads.
    expect(page.items[1]!.markdown).toBe(answer.markdown)
    expect(page.items[1]!.promoted_ingest_id).toBe(JOB_ID)
  })

  test('promote answers a job id and nothing else', () => {
    // Deliberately not the queued-ack shape: a second promote returns the FIRST
    // job, which may long since be done, so claiming `status: queued` about it
    // would be a lie told to make two schemas look alike.
    expect(zOutputPromotedResponse.parse({ ingest_id: JOB_ID })).toEqual({ ingest_id: JOB_ID })
  })
})

describe('zSpaceHealthResponse: a census, never a verdict', () => {
  const health = {
    schema_version: 'wikikit.space-health.v1' as const,
    checked_at: '2026-07-15T12:00:00.000Z',
    guidelines: { revision: 3, updated_at: '2026-07-14T09:30:00.000Z' },
    window: { from: '2026-06-15T12:00:00.000Z', to: '2026-07-15T12:00:00.000Z' },
    lint: {
      findings: [
        {
          rule: 'self-derived-only' as const,
          severity: 'warn' as const,
          message: {
            key: 'self-derived-only' as const,
            args: { concept_slug: 'wikikit', derived_sources: 2 },
            default_text: 'concept "wikikit" rests only on the wiki\'s own answers',
          },
          concept_slug: 'wikikit',
          details: { derived_sources: 2 },
        },
      ],
      counts: { error: 0, warn: 1, info: 0 },
    },
    coverage: {
      disputed: { open: 1, oldest_days: 3 },
      review_latency: { decided: 2, approved: 1, rejected: 1, median_hours: 5.5 },
      freshness: { concepts: 3, stale_over_90d: 1 },
      top_read_concepts: [{ slug: 'wikikit', title: 'WikiKit', reads: 12 }],
      top_linked_concepts: [{ slug: 'wikikit', title: 'WikiKit', inbound_relations: 4 }],
      gap_topics: { enabled: true, items: [{ lexeme: 'sofa', count: 2 }] },
    },
    review_queue: { pending: 436, oldest_days: 21 },
    ingest_queue: {
      depth: 3,
      queued: 2,
      running: 1,
      quota_blocked: 0,
      oldest_queued_hours: 4.5,
      captured: 2,
      oldest_captured_days: 31,
    },
    // The archive against the retrieval index, announced whether or not a
    // window is set. sources = indexed + unindexed.
    archive: { sources: 40, indexed: 31, unindexed: 9, index_days: 90 },
  }

  test('the whole composed shape parses', () => {
    expect(zSpaceHealthResponse.parse(health).review_queue.oldest_days).toBe(21)
  })

  test('no status, no score, no traffic light — strict, so one cannot be added quietly', () => {
    // Every threshold that would produce a verdict is policy (how many pending
    // changes is too many, for whose team?), and a server that invented one
    // would be hiding a decision from the operator who owns it.
    expect(zSpaceHealthResponse.safeParse({ ...health, status: 'degraded' }).success).toBe(false)
  })

  test('the lint rule set includes self-derived-only — the loop ships with its own guard', () => {
    const rules = health.lint.findings.map((finding) => ({ ...finding, rule: 'no-such-rule' }))
    expect(zSpaceHealthResponse.safeParse({ ...health, lint: { ...health.lint, findings: rules } }).success).toBe(false)
    expect(zSpaceHealthResponse.safeParse(health).success).toBe(true)
  })

  test('an empty queue has a null age, and a null share is expressible', () => {
    const quiet = {
      ...health,
      review_queue: { pending: 0, oldest_days: null },
      // captured follows the same null discipline: no parked thought, no age.
      ingest_queue: {
        depth: 0,
        queued: 0,
        running: 0,
        quota_blocked: 0,
        oldest_queued_hours: null,
        captured: 0,
        oldest_captured_days: null,
      },
      coverage: { ...health.coverage, review_latency: { ...health.coverage.review_latency, median_hours: null } },
      // index_days follows the same discipline: a window nobody set is null,
      // never the 0 the loader holds.
      archive: { sources: 0, indexed: 0, unindexed: 0, index_days: null },
    }
    expect(zSpaceHealthResponse.safeParse(quiet).success).toBe(true)
    // …but never a NEGATIVE count, which is the one thing a census cannot be.
    expect(zSpaceHealthResponse.safeParse({ ...quiet, review_queue: { pending: -1, oldest_days: null } }).success).toBe(
      false,
    )
  })

  test('gap_topics keeps its enabled flag, so an empty list cannot read as "no gaps"', () => {
    const { enabled: _dropped, ...items } = health.coverage.gap_topics
    expect(
      zSpaceHealthResponse.safeParse({ ...health, coverage: { ...health.coverage, gap_topics: items } }).success,
    ).toBe(false)
  })
})

describe('zScheduleListResponse', () => {
  test('a null weekday IS daily — the wire has no separate frequency field', () => {
    const parsed = zScheduleListResponse.parse({
      schedules: [
        {
          kind: 'briefing',
          at_time: '07:00',
          weekday: null,
          timezone: 'Europe/Berlin',
          enabled: true,
          last_run_at: '2026-07-15T05:00:00.000Z',
          next_run_at: '2026-07-16T05:00:00.000Z',
        },
        {
          kind: 'health',
          at_time: '08:30',
          weekday: 1,
          timezone: 'Pacific/Auckland',
          enabled: false,
          last_run_at: null,
          // A disabled schedule is DISARMED, not armed-and-skipped: null keeps
          // it out of the claim query entirely.
          next_run_at: null,
        },
      ],
    })
    expect(parsed.schedules[0]!.weekday).toBeNull()
    expect(parsed.schedules[1]!.next_run_at).toBeNull()
  })

  test('the kinds are the two the worker can run, and a weekday is 0..6', () => {
    const row = {
      kind: 'digest',
      at_time: '07:00',
      weekday: null,
      timezone: 'UTC',
      enabled: true,
      last_run_at: null,
      next_run_at: null,
    }
    expect(zScheduleListResponse.safeParse({ schedules: [row] }).success).toBe(false)
    expect(zScheduleListResponse.safeParse({ schedules: [{ ...row, kind: 'briefing', weekday: 7 }] }).success).toBe(
      false,
    )
  })
})
