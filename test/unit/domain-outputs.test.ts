// outputs domain — the two invariants src/domain/outputs.ts exists to protect,
// against a routing fake pool (no Postgres, no pipeline).
//
//  1. THE RENDERING IS DETERMINISTIC. The promote path leans on it entirely:
//     identical bytes → identical sha256 → the ingest pipeline answers
//     `already_ingested` instead of staging a second proposal for a human to
//     reject. So the assertion here is not "the same string twice" but the same
//     HASH twice, computed the way the pipeline computes it, because the hash is
//     what the dedup actually compares. A "generated at" line or a row id in the
//     rendering would pass a shape test and break the loop.
//  2. RETENTION COLLECTS ONLY WHAT IS REGENERABLE. A promoted output's markdown
//     already lives on as an archived source; deleting the row would cut the
//     provenance link from that source back to the answer it came from while
//     freeing nothing.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { NotFoundError } from '../../src/domain/errors.ts'
import {
  cleanupOutputs,
  getOutput,
  listOutputs,
  promoteOutput,
  recordOutput,
  renderOutputSource,
  type Output,
} from '../../src/domain/outputs.ts'
import { sha256Hex } from '../../src/domain/sources.ts'

interface Call {
  sql: string
  values: unknown[]
}
type Rows = Record<string, unknown>[]

function fakeDb(routes: { match: RegExp; rows: Rows }[]) {
  const calls: Call[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => entry.match.test(sql))
    return { rows: route?.rows ?? [], rowCount: route?.rows.length ?? 0 }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const OUTPUT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const JOB_ID = '77777777-7777-4777-8777-777777777777'

function output(overrides: Partial<Output> = {}): Output {
  return {
    id: OUTPUT_ID,
    space_id: SPACE_ID,
    kind: 'answer',
    title: 'What is WikiKit?',
    summary: 'A headless knowledge system.',
    question: 'What is WikiKit?',
    markdown: '# WikiKit\n\nA headless knowledge system.',
    citations: [
      { slug: 'wikikit', title: 'WikiKit' },
      { slug: 'open-knowledge-format', title: 'Open Knowledge Format' },
    ],
    not_in_knowledge_base: false,
    agent_run_id: null,
    promoted_ingest_id: null,
    promoted_at: null,
    created_at: '2026-07-15T12:00:00.000Z',
    ...overrides,
  }
}

/** The row shape a SELECT hands back, matching the fixture above. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const wire = output()
  return {
    ...wire,
    citations: JSON.stringify(wire.citations), // a stubbed pool returns the inserted string
    created_at: new Date(wire.created_at),
    ...overrides,
  }
}

describe('renderOutputSource is deterministic (the promote path depends on it)', () => {
  test('the same output twice renders identical bytes AND an identical sha256', () => {
    const answer = output()
    const first = renderOutputSource(answer)
    const second = renderOutputSource(answer)
    expect(second).toBe(first)
    // The hash is the assertion that matters: this is exactly what the ingest
    // pipeline computes over the markdown to decide `already_ingested`, so an
    // equal hash IS the promise that re-promoting stages nothing new.
    expect(sha256Hex(second)).toBe(sha256Hex(first))
  })

  test('a distinct row still renders distinct bytes — determinism is not collapsing', () => {
    // The guard against "fix determinism by rendering a constant": two answers
    // that differ in what they SAID must not share a content hash, or promoting
    // the second would silently resolve to the first one's source.
    const one = renderOutputSource(output())
    const two = renderOutputSource(output({ markdown: '# WikiKit\n\nSomething else entirely.' }))
    expect(sha256Hex(two)).not.toBe(sha256Hex(one))
  })

  test('nothing time-shaped and no id reaches the text', () => {
    // The failure mode this rules out is a "generated at" line or an id header
    // added later for readability: both pass every shape assertion and break
    // dedup on the second promote, which shows up as duplicate review work
    // rather than as a test failure.
    const text = renderOutputSource(output())
    expect(text).not.toContain(OUTPUT_ID)
    expect(text).not.toContain(SPACE_ID)
    expect(text).not.toContain('2026-07-15')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })

  test('the rendering is self-describing: the question, the answer, the cited pages', () => {
    // Read on its own months later, the archived source has to say what was
    // asked and what the answer leaned on — and the answer text rides along
    // VERBATIM, because the grounding guard checks each synthesized claim's
    // quote against this exact string.
    const text = renderOutputSource(output())
    expect(text).toContain('# What is WikiKit?')
    expect(text).toContain('What is WikiKit?')
    expect(text).toContain('A headless knowledge system.')
    expect(text).toContain('- WikiKit (wikikit)')
    expect(text).toContain('- Open Knowledge Format (open-knowledge-format)')
  })

  test('citation ORDER is the answer’s, not sorted — and it is stable', () => {
    // Sorting would be a second opinion about what the answer said. Insertion
    // order already gives the only stability determinism needs: the same row
    // renders the same way.
    const reversed = output({
      citations: [
        { slug: 'open-knowledge-format', title: 'Open Knowledge Format' },
        { slug: 'wikikit', title: 'WikiKit' },
      ],
    })
    const text = renderOutputSource(reversed)
    expect(text.indexOf('open-knowledge-format')).toBeLessThan(text.indexOf('(wikikit)'))
    expect(sha256Hex(renderOutputSource(reversed))).not.toBe(sha256Hex(renderOutputSource(output())))
  })

  test('a briefing with no question and no citations renders without empty sections', () => {
    const text = renderOutputSource(
      output({ kind: 'briefing', title: 'Briefing 2026-07-15', question: null, citations: [] }),
    )
    expect(text).toBe('# Briefing 2026-07-15\n\n# WikiKit\n\nA headless knowledge system.\n')
    expect(text).not.toContain('cited these knowledge pages')
  })
})

describe('promoteOutput', () => {
  test('hands the pipeline the rendered markdown, marked derived, as a note', async () => {
    const { db, calls } = fakeDb([
      { match: /FROM "public"\."wk_outputs"/, rows: [row()] },
      { match: /UPDATE "public"\."wk_outputs"/, rows: [] },
    ])
    const seen: Record<string, unknown>[] = []
    const result = await promoteOutput(
      db,
      {
        ingest: {
          async enqueue(_db, _spaceId, args) {
            seen.push(args)
            return { ingest_id: JOB_ID }
          },
        },
      },
      OUTPUT_ID,
    )
    expect(result).toEqual({ ingest_id: JOB_ID })
    expect(seen[0]).toEqual({
      markdown: renderOutputSource(output()),
      title: 'What is WikiKit?',
      // Not a meeting (decision mining would read an answer's prose as
      // decisions nobody took) and not an article (this is house-produced).
      source_kind: 'note',
      // A real input field, not loose metadata: the worker re-parses the stored
      // job input with the same schema, so an unknown key would be dropped
      // before it could reach wk_sources.metadata — where the self-derived lint
      // rule reads it.
      derived_from_output_id: OUTPUT_ID,
    })
    expect(calls.some((call) => call.sql.includes('UPDATE "public"."wk_outputs"'))).toBe(true)
  })

  test('a second promote returns the FIRST job without touching the pipeline', async () => {
    // Re-enqueueing would also be correct — the deterministic rendering makes
    // the pipeline answer already_ingested — but it would cost a round trip and
    // turn a duplicate click into a 409 the caller has to interpret. The stored
    // job id is the same answer with a better shape.
    const { db } = fakeDb([{ match: /FROM "public"\."wk_outputs"/, rows: [row({ promoted_ingest_id: JOB_ID })] }])
    let called = 0
    const result = await promoteOutput(
      db,
      {
        ingest: {
          async enqueue() {
            called += 1
            return { ingest_id: 'a-second-job' }
          },
        },
      },
      OUTPUT_ID,
    )
    expect(result).toEqual({ ingest_id: JOB_ID })
    expect(called).toBe(0)
  })
})

describe('getOutput / listOutputs / recordOutput boundaries', () => {
  test('a non-uuid id is a 400 at the boundary, not a 500 from Postgres', async () => {
    const { db, calls } = fakeDb([])
    await expect(getOutput(db, 'latest')).rejects.toThrow(/uuid/)
    expect(calls.length).toBe(0)
  })

  test('a missing row is a NotFoundError', async () => {
    const { db } = fakeDb([])
    await expect(getOutput(db, OUTPUT_ID)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('every list statement is space-scoped, newest first', async () => {
    const { db, calls } = fakeDb([{ match: /FROM wk_outputs/, rows: [row()] }])
    const page = await listOutputs(db, SPACE_ID, { kind: 'answer', limit: 10 })
    expect(page.items[0]!.citations).toEqual([
      { slug: 'wikikit', title: 'WikiKit' },
      { slug: 'open-knowledge-format', title: 'Open Knowledge Format' },
    ])
    expect(page.next_before).toBeNull()
    expect(calls[0]!.sql).toContain('space_id = $1')
    expect(calls[0]!.sql).toContain('ORDER BY created_at DESC, id DESC')
    expect(calls[0]!.values[0]).toBe(SPACE_ID)
  })

  test('not_in_knowledge_base is refused on a kind that cannot have one', async () => {
    // The column's tri-state is only meaningful for answers: a briefing is not
    // "in" or "out" of the knowledge base, so a caller passing the flag on one
    // has misunderstood the field. Refusing beats storing a value no reader can
    // interpret.
    const { db } = fakeDb([])
    await expect(
      recordOutput(db, SPACE_ID, {
        kind: 'briefing',
        title: 'Briefing',
        markdown: '# b',
        not_in_knowledge_base: false,
      }),
    ).rejects.toThrow()
  })
})

describe('cleanupOutputs', () => {
  test('collects unpromoted rows only, and outside the window only', async () => {
    const { db, calls } = fakeDb([{ match: /DELETE FROM wk_outputs/, rows: [{ deleted: 4 }] }])
    expect(await cleanupOutputs(db, 365)).toBe(4)
    const sql = calls[0]!.sql
    // A promoted output's markdown already lives on as an archived source, so
    // deleting the row frees nothing and cuts the link from that source back to
    // the answer it came from.
    expect(sql).toContain('promoted_at IS NULL')
    expect(sql).toContain("created_at < now() - ($1::int * interval '1 day')")
    expect(calls[0]!.values).toEqual([365])
  })

  test('retentionDays <= 0 keeps everything and issues no statement at all', async () => {
    // The operator's opt-out. Computing a zero-day window instead would delete
    // every unpromoted output — the exact opposite of what 0 means.
    for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { db, calls } = fakeDb([{ match: /DELETE FROM wk_outputs/, rows: [{ deleted: 99 }] }])
      expect(await cleanupOutputs(db, days)).toBe(0)
      expect(calls.length, `retentionDays=${days} issued SQL`).toBe(0)
    }
  })

  test('a fractional window is floored, never passed through as a float', async () => {
    const { db, calls } = fakeDb([{ match: /DELETE FROM wk_outputs/, rows: [{ deleted: 0 }] }])
    await cleanupOutputs(db, 30.9)
    expect(calls[0]!.values).toEqual([30])
  })
})
