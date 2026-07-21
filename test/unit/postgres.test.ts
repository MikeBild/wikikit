// Query-builder unit tests against a recording fake pool — no network, no
// Postgres. These pin the exact SQL shapes the safe layer emits, because the
// SQL shape IS the security contract (allowlist, parameterization, whitelist).
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, TABLES, type Db, type PoolLike } from '../../src/db/postgres.ts'

const config = { databaseUrl: 'postgresql://stub' } as Config

interface Call {
  sql: string
  values: unknown[]
}

function makeFixture(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = []
  const query = async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values: values ?? [] })
    return { rows, rowCount: rows.length }
  }
  const pool: PoolLike = {
    query,
    connect: async () => ({ query, release() {} }),
    end: async () => {},
  }
  const { db } = createPostgres(config, { pool })
  return { db, calls }
}

describe('table allowlist', () => {
  test('select from unknown table throws before any SQL runs', async () => {
    const { db, calls } = makeFixture()
    await expect(db.select('ck_sites')).rejects.toThrow('unknown WikiKit table: ck_sites')
    await expect(db.select('wk_bogus')).rejects.toThrow('unknown WikiKit table: wk_bogus')
    expect(calls.length).toBe(0)
  })

  test('all wk_ domain tables are registered', () => {
    for (const table of [
      'wk_spaces',
      'wk_sources',
      'wk_concepts',
      'wk_concept_revisions',
      'wk_claims',
      'wk_citations',
      'wk_relations',
      'wk_decisions',
      'wk_change_proposals',
      'wk_api_keys',
      'wk_outbox_events',
      'wk_webhook_endpoints',
      'wk_webhook_deliveries',
      'wk_ingest_jobs',
      'wk_agent_runs',
    ]) {
      expect(TABLES.has(table)).toBe(true)
    }
  })
})

describe('raw query() guard', () => {
  test('passes known tables through parameterized', async () => {
    const { db, calls } = makeFixture()
    await db.query('SELECT c.slug FROM wk_concepts c JOIN wk_concept_revisions r ON r.id = c.current_revision_id', [])
    expect(calls.length).toBe(1)
  })

  test('rejects unknown wk_ identifiers', async () => {
    const { db, calls } = makeFixture()
    await expect(db.query('SELECT * FROM wk_secrets')).rejects.toThrow('unknown WikiKit table in query: wk_secrets')
    expect(calls.length).toBe(0)
  })

  test('rejects direct SQL-function invocation — call() is the only RPC path', async () => {
    const { db } = makeFixture()
    await expect(db.query('SELECT wk_apply_proposal($1, $2)', ['id', 'me'])).rejects.toThrow(
      'unknown WikiKit table in query: wk_apply_proposal',
    )
    await expect(db.query('SELECT * FROM wk_search($1, $2)', ['id', 'q'])).rejects.toThrow(
      'unknown WikiKit table in query: wk_search',
    )
  })
})

describe('filter encoding', () => {
  test('eq/lte/in/is.null/not.is.null with order and limit', async () => {
    const { db, calls } = makeFixture()
    await db.select('wk_claims', {
      space_id: 'eq.s1',
      confidence: 'lte.0.9',
      status: 'in.(verified,disputed)',
      valid_until: 'is.null',
      proposal_id: 'not.is.null',
      order: 'created_at.desc',
      limit: 5,
    })
    expect(calls[0]!.sql).toBe(
      'SELECT * FROM "public"."wk_claims"' +
        ' WHERE "space_id" = $1 AND "confidence" <= $2 AND "status" IN ($3, $4)' +
        ' AND "valid_until" IS NULL AND "proposal_id" IS NOT NULL' +
        ' ORDER BY "created_at" DESC LIMIT $5',
    )
    expect(calls[0]!.values).toEqual(['s1', '0.9', 'verified', 'disputed', 5])
  })

  test('empty in-list yields FALSE (matches nothing) instead of invalid SQL', async () => {
    const { db, calls } = makeFixture()
    await db.select('wk_spaces', { id: 'in.()' })
    expect(calls[0]!.sql).toContain('WHERE FALSE')
  })

  test('unsupported operator and invalid sort direction throw', async () => {
    const { db } = makeFixture()
    await expect(db.select('wk_spaces', { slug: 'like.%x%' })).rejects.toThrow('unsupported database filter for slug')
    await expect(db.select('wk_spaces', { order: 'slug.random' })).rejects.toThrow('invalid database sort direction')
    await expect(db.select('wk_spaces', { limit: 10_001 })).rejects.toThrow('invalid database limit')
  })

  test('column names are validated as identifiers (no injection via keys)', async () => {
    const { db } = makeFixture()
    await expect(db.select('wk_spaces', { 'slug"; DROP TABLE wk_spaces; --': 'eq.x' })).rejects.toThrow(
      'invalid SQL identifier',
    )
  })
})

describe('insert', () => {
  test('single row insert with RETURNING', async () => {
    const { db, calls } = makeFixture([{ id: '1' }])
    const rows = await db.insert('wk_spaces', { slug: 'dev', name: 'Dev' })
    expect(calls[0]!.sql).toBe('INSERT INTO "public"."wk_spaces" ("slug", "name") VALUES ($1, $2) RETURNING *')
    expect(calls[0]!.values).toEqual(['dev', 'Dev'])
    expect(rows).toEqual([{ id: '1' }])
  })

  test('batch insert requires homogeneous row shapes', async () => {
    const { db } = makeFixture()
    await expect(
      db.insert('wk_spaces', [{ slug: 'a', name: 'A' }, { slug: 'b' } as Record<string, unknown>]),
    ).rejects.toThrow('database insert rows must have the same non-empty shape')
  })

  test('upsert pins ON CONFLICT to explicit target columns', async () => {
    const { db, calls } = makeFixture()
    await db.insert(
      'wk_sources',
      { space_id: 's', content_hash: 'h', kind: 'markdown', raw_content: 'x', markdown: 'x' },
      { upsert: true, onConflict: 'space_id,content_hash' },
    )
    expect(calls[0]!.sql).toContain('ON CONFLICT ("space_id", "content_hash") DO UPDATE SET "kind" = EXCLUDED."kind"')
  })

  test('upsert without onConflict throws', async () => {
    const { db } = makeFixture()
    await expect(db.insert('wk_spaces', { slug: 'x', name: 'X' }, { upsert: true })).rejects.toThrow(
      'upsert requires onConflict',
    )
  })
})

describe('update / remove safety', () => {
  test('unfiltered update refused', async () => {
    const { db } = makeFixture()
    await expect(db.update('wk_spaces', {}, { name: 'X' })).rejects.toThrow('refusing unfiltered database update')
  })

  test('unfiltered delete refused', async () => {
    const { db } = makeFixture()
    await expect(db.remove('wk_spaces', {})).rejects.toThrow('refusing unfiltered database delete')
  })

  test('filtered update parameterizes SET before WHERE', async () => {
    const { db, calls } = makeFixture()
    await db.update('wk_ingest_jobs', { id: 'eq.j1' }, { status: 'running' }, { returning: false })
    expect(calls[0]!.sql).toBe('UPDATE "public"."wk_ingest_jobs" SET "status" = $1 WHERE "id" = $2')
    expect(calls[0]!.values).toEqual(['running', 'j1'])
  })
})

describe('call() — whitelisted SQL functions', () => {
  test('unknown function throws', async () => {
    const { db, calls } = makeFixture()
    await expect(db.call('wk_drop_everything' as never, [])).rejects.toThrow(
      'unknown WikiKit function: wk_drop_everything',
    )
    expect(calls.length).toBe(0)
  })

  test('wk_apply_proposal pins statement, pads note, unwraps jsonb result', async () => {
    const { db, calls } = makeFixture([{ result: { proposal_id: 'p1', status: 'approved' } }])
    const rows = await db.call('wk_apply_proposal', ['p1', 'mike'])
    expect(calls[0]!.sql).toBe('SELECT public.wk_apply_proposal($1, $2, $3, $4) AS result')
    expect(calls[0]!.values).toEqual(['p1', 'mike', null, 'rest'])
    expect(rows).toEqual([{ proposal_id: 'p1', status: 'approved' }])
  })

  test('wk_reject_proposal passes the note through', async () => {
    const { db, calls } = makeFixture([{ result: { proposal_id: 'p1', status: 'rejected' } }])
    await db.call('wk_reject_proposal', ['p1', 'mike', 'stale source'])
    expect(calls[0]!.sql).toBe('SELECT public.wk_reject_proposal($1, $2, $3, $4) AS result')
    expect(calls[0]!.values).toEqual(['p1', 'mike', 'stale source', 'rest'])
  })

  test('wk_search fills kind=null and limit=20 defaults (never LIMIT NULL)', async () => {
    const { db, calls } = makeFixture()
    await db.call('wk_search', ['space-1', 'okf'])
    expect(calls[0]!.sql).toBe('SELECT * FROM public.wk_search($1, $2, $3, $4)')
    expect(calls[0]!.values).toEqual(['space-1', 'okf', null, 20])
  })

  test('arity is validated', async () => {
    const { db } = makeFixture()
    await expect(db.call('wk_apply_proposal', ['only-one'])).rejects.toThrow('wk_apply_proposal expects')
    await expect(db.call('wk_search', ['s', 'q', null, 10, 'extra'])).rejects.toThrow('wk_search expects')
  })
})

describe('emitEvent — transactional outbox insert', () => {
  test('inserts into wk_outbox_events with serialized payload', async () => {
    const { db, calls } = makeFixture()
    await db.emitEvent('space-1', 'wikikit.proposal.created', { proposal_id: 'p1' })
    expect(calls[0]!.sql).toBe(
      'INSERT INTO "public"."wk_outbox_events" (space_id, event_type, payload) VALUES ($1, $2, $3)',
    )
    expect(calls[0]!.values).toEqual(['space-1', 'wikikit.proposal.created', '{"proposal_id":"p1"}'])
  })

  test('unknown event type is refused at the write, not at the subscriber', async () => {
    const { db, calls } = makeFixture()
    await expect(db.emitEvent('space-1', 'wikikit.oops' as never, {})).rejects.toThrow(
      'unknown webhook event type: wikikit.oops',
    )
    expect(calls.length).toBe(0)
  })
})

describe('tx', () => {
  function txFixture(failOn?: string) {
    const calls: Call[] = []
    const query = async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] })
      if (failOn && sql.includes(failOn)) throw new Error(`boom: ${failOn}`)
      return { rows: [], rowCount: 0 }
    }
    let released = 0
    const pool: PoolLike = {
      query,
      connect: async () => ({ query, release: () => released++ }),
      end: async () => {},
    }
    const { db } = createPostgres(config, { pool })
    return { db, calls, releasedCount: () => released }
  }

  test('wraps work in BEGIN/COMMIT and releases the client', async () => {
    const { db, calls, releasedCount } = txFixture()
    await db.tx(async (tx) => {
      await tx.insert('wk_spaces', { slug: 'a', name: 'A' }, { returning: false })
      await tx.emitEvent('s1', 'wikikit.concept.updated', { slug: 'a' })
    })
    expect(calls.map((call) => call.sql.split(' ')[0])).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT'])
    expect(releasedCount()).toBe(1)
  })

  test('rolls back on error and rethrows', async () => {
    const { db, calls, releasedCount } = txFixture('wk_outbox_events')
    await expect(
      db.tx(async (tx) => {
        await tx.insert('wk_spaces', { slug: 'a', name: 'A' }, { returning: false })
        await tx.emitEvent('s1', 'wikikit.concept.updated', { slug: 'a' })
      }),
    ).rejects.toThrow('boom: wk_outbox_events')
    expect(calls.at(-1)!.sql).toBe('ROLLBACK')
    expect(releasedCount()).toBe(1)
  })

  test('nested tx throws (documented choice: no savepoints)', async () => {
    const { db } = txFixture()
    await expect(
      db.tx(async (tx: Db) => {
        await tx.tx(async () => {})
      }),
    ).rejects.toThrow('nested transactions are not supported')
  })
})
