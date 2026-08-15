// Session capture: distil a coding-agent transcript, stage only what a human
// actually taught. The load-bearing behavior is the FILTER — a routine session
// must cost one cheap call and write nothing — so that is what these pin.
import { describe, expect, test } from 'bun:test'
import {
  captureSession,
  capTranscript,
  renderLearnings,
  sessionStreamKey,
  zCaptureSessionArgs,
} from '../../src/agent/sessions.ts'
import type { Db } from '../../src/db/postgres.ts'
import { ConflictError, LlmNotConfiguredError } from '../../src/domain/errors.ts'
import type { IngestPipeline } from '../../src/ingest/pipeline.ts'
import { createFakeProvider } from '../../src/llm/fake.ts'
import type { DistillOutput } from '../../src/llm/schemas.ts'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const INGEST_ID = '22222222-2222-4222-8222-222222222222'

/** Records agent-run inserts; everything else is unused by captureSession. */
function fakeDb(): Db & { runs: Record<string, unknown>[] } {
  const runs: Record<string, unknown>[] = []
  return {
    runs,
    async insert(table: string, rows: unknown) {
      expect(table).toBe('wk_agent_runs')
      runs.push(rows as Record<string, unknown>)
      return [{ id: RUN_ID }]
    },
  } as unknown as Db & { runs: Record<string, unknown>[] }
}

/**
 * Records enqueues; `fail` makes it throw like a content-hash hit, `result`
 * replaces the queued ack (the sync fast-path answers `unchanged` instead).
 */
function fakeIngest(fail?: Error, result?: unknown): IngestPipeline & { enqueued: unknown[] } {
  const enqueued: unknown[] = []
  return {
    enqueued,
    async enqueue(_db: Db, _spaceId: string, args: unknown) {
      if (fail) throw fail
      enqueued.push(args)
      return result ?? { ingest_id: INGEST_ID }
    },
  } as unknown as IngestPipeline & { enqueued: unknown[] }
}

const LEARNING = {
  learnings: [
    {
      title: 'Deploys go through CI',
      rule: 'Never deploy by hand; push and let CI deploy.',
      quote: 'no — always let CI deploy',
    },
  ],
} satisfies DistillOutput

describe('captureSession', () => {
  test('a routine session stages nothing — no source, no proposal', async () => {
    const db = fakeDb()
    const ingest = fakeIngest()
    // FakeProvider's default distill returns no learnings, which IS the
    // routine-session case.
    const llm = createFakeProvider()

    const result = await captureSession(
      db,
      'space-1',
      { llm, ingest },
      { transcript: 'human: fix typo\nassistant: done' },
    )

    expect(result.status).toBe('no_learnings')
    expect(result.learnings).toBe(0)
    expect(result.ingest_id).toBeNull()
    expect(ingest.enqueued).toEqual([])
    // ...but the call is still audited: the ledger must account for every
    // model call, including the ones that found nothing.
    expect(db.runs).toHaveLength(1)
    expect(db.runs[0]).toMatchObject({ kind: 'distill', space_id: 'space-1', prompt_version: 'distill.v1' })
    expect(result.agent_run_id).toBe(RUN_ID)
  })

  test('a taught rule is staged as a note through the normal ingest path', async () => {
    const db = fakeDb()
    const ingest = fakeIngest()
    const llm = createFakeProvider({ distill: () => LEARNING })

    const result = await captureSession(
      db,
      'space-1',
      { llm, ingest },
      { transcript: 'human: no — always let CI deploy' },
    )

    expect(result).toMatchObject({ status: 'queued', ingest_id: INGEST_ID, learnings: 1 })
    expect(ingest.enqueued).toHaveLength(1)
    const args = ingest.enqueued[0] as { markdown: string; source_kind: string; title: string }
    // 'note', never 'meeting': meeting sources get mined for decision records,
    // and a convention is not a decision (no context, no alternatives).
    expect(args.source_kind).toBe('note')
    expect(args.markdown).toContain('Never deploy by hand')
    // The quote rides along verbatim so the pipeline's grounding guard has
    // something to match a synthesized claim against.
    expect(args.markdown).toContain('no — always let CI deploy')
  })

  test('re-teaching the same rule is already_captured, not a duplicate or an error', async () => {
    const db = fakeDb()
    const ingest = fakeIngest(new ConflictError('already_ingested', 'seen before'))
    const llm = createFakeProvider({ distill: () => LEARNING })

    const result = await captureSession(
      db,
      'space-1',
      { llm, ingest },
      { transcript: 'human: no — always let CI deploy' },
    )

    expect(result).toMatchObject({ status: 'already_captured', ingest_id: null, learnings: 1 })
  })

  test('a session_id turns the capture into a versioned source stream', async () => {
    const db = fakeDb()
    const ingest = fakeIngest()
    const llm = createFakeProvider({ distill: () => LEARNING })

    await captureSession(
      db,
      'space-1',
      { llm, ingest },
      { transcript: 'human: no — always let CI deploy', session_id: 'sess-42' },
    )

    const args = ingest.enqueued[0] as { external_source_id?: string; source_version?: string }
    expect(args.external_source_id).toBe('agent-session:sess-42')
    // Deliberately versionless: a hook has no upstream revision marker, and a
    // transcript-derived one would 409 the moment the distiller worded the
    // same rules differently.
    expect(args.source_version).toBeUndefined()
  })

  test('without a session_id nothing about the enqueue changes (older hooks keep working)', async () => {
    const db = fakeDb()
    const ingest = fakeIngest()
    const llm = createFakeProvider({ distill: () => LEARNING })

    await captureSession(db, 'space-1', { llm, ingest }, { transcript: 'human: no — always let CI deploy' })

    expect(ingest.enqueued[0]).not.toHaveProperty('external_source_id')
  })

  test('the sync fast-path reports already_captured, not a second queued ingest', async () => {
    const db = fakeDb()
    // What enqueue answers when the stream already holds these exact bytes.
    const ingest = fakeIngest(undefined, { status: 'unchanged', source_id: 'src-1', stream_id: 'stream-1' })
    const llm = createFakeProvider({ distill: () => LEARNING })

    const result = await captureSession(
      db,
      'space-1',
      { llm, ingest },
      { transcript: 'human: no — always let CI deploy', session_id: 'sess-42' },
    )

    // Byte-identical to the streamless dedup answer: the hook needs no branch.
    expect(result).toMatchObject({ status: 'already_captured', ingest_id: null, learnings: 1 })
  })

  test('a non-dedup ingest failure propagates instead of being reported as captured', async () => {
    const db = fakeDb()
    const ingest = fakeIngest(new Error('database on fire'))
    const llm = createFakeProvider({ distill: () => LEARNING })

    await expect(captureSession(db, 'space-1', { llm, ingest }, { transcript: 'x' })).rejects.toThrow(
      'database on fire',
    )
  })

  test('without an LLM key it is a 503 naming the provider key, before any write', async () => {
    const db = fakeDb()
    const ingest = fakeIngest()
    const llm = { ...createFakeProvider(), configured: false, apiKeyEnv: 'OPENAI_API_KEY' }

    const error = (await captureSession(db, 'space-1', { llm, ingest }, { transcript: 'x' }).catch(
      (e: unknown) => e,
    )) as LlmNotConfiguredError
    expect(error).toBeInstanceOf(LlmNotConfiguredError)
    expect(error.message).toContain('OPENAI_API_KEY')
    expect(db.runs).toEqual([])
  })
})

describe('zCaptureSessionArgs', () => {
  test('session_id is optional — the pre-stream wire body still parses', () => {
    expect(zCaptureSessionArgs.parse({ transcript: 'x' }).session_id).toBeUndefined()
  })

  test('an over-long session id is refused rather than truncated into a wrong stream', () => {
    expect(zCaptureSessionArgs.safeParse({ transcript: 'x', session_id: 'a'.repeat(201) }).success).toBe(false)
    expect(zCaptureSessionArgs.safeParse({ transcript: 'x', session_id: 'a'.repeat(200) }).success).toBe(true)
    expect(zCaptureSessionArgs.safeParse({ transcript: 'x', session_id: '' }).success).toBe(false)
  })
})

describe('sessionStreamKey', () => {
  test('namespaces the client id — a host session id must not collide with a connector document id', () => {
    expect(sessionStreamKey('019fe665')).toBe('agent-session:019fe665')
  })

  test('is stable: the same session always addresses the same stream', () => {
    expect(sessionStreamKey('abc')).toBe(sessionStreamKey('abc'))
    expect(sessionStreamKey('abc')).not.toBe(sessionStreamKey('abd'))
  })

  test('stays inside the 500-char external_source_id ceiling at the id cap', () => {
    expect(sessionStreamKey('a'.repeat(200)).length).toBeLessThanOrEqual(500)
  })
})

describe('capTranscript', () => {
  test('keeps a short transcript verbatim', () => {
    expect(capTranscript('hello')).toBe('hello')
  })

  test('over the cap it keeps the TAIL — late corrections are the point', () => {
    const long = `${'x'.repeat(200_000)}human: no, always use bun`
    const capped = capTranscript(long)
    expect(capped.length).toBe(200_000)
    expect(capped.endsWith('human: no, always use bun')).toBe(true)
  })
})

describe('renderLearnings', () => {
  test('is deterministic — the same rules render identically, so dedup can bite', () => {
    expect(renderLearnings(LEARNING.learnings)).toBe(renderLearnings(LEARNING.learnings))
  })

  test('carries title, rule and the verbatim quote', () => {
    const markdown = renderLearnings(LEARNING.learnings)
    expect(markdown).toContain('## Deploys go through CI')
    expect(markdown).toContain('Never deploy by hand; push and let CI deploy.')
    expect(markdown).toContain('> no — always let CI deploy')
  })

  test('a multi-line quote stays inside the blockquote', () => {
    const markdown = renderLearnings([{ title: 'T', rule: 'R', quote: 'line one\nline two' }])
    expect(markdown).toContain('> line one\n> line two')
  })
})
