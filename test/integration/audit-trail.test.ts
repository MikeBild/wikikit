// audit.v1 against a real Docker Postgres — the four properties of §15.5 that
// only a real database can prove: the chain, the lock, the append-only
// privilege, and the transactional coupling.
//
// Gated behind RUN_INTEGRATION=1; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import {
  actorFromPrincipal,
  appendAuditEvent,
  auditedTx,
  listAuditEvents,
  sanitizeAuditPayload,
  SYSTEM_ACTOR,
} from '../../src/domain/audit.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db
let url: string

async function seedSpace(slug: string): Promise<string> {
  const [row] = await db.insert<{ id: string }>('wk_spaces', { slug, name: `Space ${slug}`, settings: {} })
  return row!.id
}

describe('audit trail (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    url = await provisionIntegrationDatabase('wikikit_test_audit')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('opens with a chained legacy_partial genesis row', async () => {
    const { items } = await listAuditEvents(db, { limit: 200 })
    const genesis = items.at(-1)!
    expect(genesis.seq).toBe(1)
    expect(genesis.action).toBe('audit.trail.opened')
    expect(genesis.prev_sha256).toBe('0'.repeat(64))
    expect(genesis.metadata.legacy_partial).toBe(true)
    expect(genesis.schema_version).toBe('audit.v1')
  })

  it('assigns monotone seq and a prev_sha256 chain, and the digest matches the preimage', async () => {
    const spaceId = await seedSpace('audit-chain')
    const first = await appendAuditEvent(db, {
      action: 'concept.updated',
      resourceType: 'concept',
      resourceId: 'alpha',
      result: 'success',
      transport: 'http',
      actor: SYSTEM_ACTOR,
      spaceId,
      after: { rev: 2 },
    })
    const second = await appendAuditEvent(db, {
      action: 'concept.deleted',
      resourceType: 'concept',
      resourceId: 'alpha',
      result: 'denied',
      transport: 'mcp',
      actor: SYSTEM_ACTOR,
      spaceId,
    })
    expect(second.seq).toBe(first.seq + 1)
    expect(second.prev_sha256).toBe(first.sha256)

    // Recompute the digest exactly as the SQL does: jsonb key order, then sha256.
    const row = (await db.query<Record<string, unknown>>('SELECT * FROM wk_audit_events WHERE seq = $1', [second.seq]))
      .rows[0]!
    const preimageRows = await db.query<{ preimage: string }>(
      `SELECT jsonb_build_object(
         'action', $1::text, 'actor_id', null::text, 'actor_kind', 'system', 'actor_label', null::text,
         'after', 'null'::jsonb, 'before', 'null'::jsonb, 'metadata', '{}'::jsonb,
         'occurred_at', to_char(($2::timestamptz) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         'prev_sha256', $3::text, 'request_id', null::text, 'resource_id', $4::text,
         'resource_revision', null::text, 'resource_type', $5::text, 'result', $6::text,
         'schema_version', 'audit.v1', 'seq', $7::bigint, 'space_id', $8::text,
         'trace_id', null::text, 'transport', $9::text
       )::text AS preimage`,
      [
        row.action,
        row.occurred_at,
        second.prev_sha256,
        row.resource_id,
        row.resource_type,
        row.result,
        second.seq,
        spaceId,
        row.transport,
      ],
    )
    const recomputed = createHash('sha256').update(preimageRows.rows[0]!.preimage).digest('hex')
    expect(recomputed).toBe(second.sha256)
  })

  // GEGENPROBE 1 — the runtime user must not be able to rewrite the past.
  it('refuses UPDATE, DELETE and TRUNCATE on wk_audit_events', async () => {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      for (const sql of [
        `UPDATE public.wk_audit_events SET action = 'tampered' WHERE seq = 1`,
        `DELETE FROM public.wk_audit_events WHERE seq = 1`,
        `TRUNCATE public.wk_audit_events`,
      ]) {
        const attempt = await client.query(sql).then(
          () => null,
          (error: { code?: string; message: string }) => error,
        )
        expect(attempt, `${sql} was NOT refused`).not.toBeNull()
        expect(attempt!.code).toBe('42501')
      }
    } finally {
      await client.end()
    }
    // The builder path is refused for the same reason, one layer up.
    await expect(db.update('wk_audit_events', { seq: 'eq.1' }, { action: 'tampered' })).rejects.toThrow()
  })

  // The privilege half of the same rule, provable only with a role that is not
  // a superuser: the local container runs as `postgres`, which bypasses every
  // ACL, so above it is the trigger that bites. A deployment whose runtime role
  // is not the owner gets the refusal from the grant itself.
  it('refuses UPDATE by ACL for a non-superuser runtime role, with the triggers gone', async () => {
    const role = `wk_audit_runtime_${randomUUID().slice(0, 8)}`
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'probe'`)
      await client.query(`GRANT CONNECT ON DATABASE "wikikit_test_audit" TO "${role}"`)
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
      await client.query(`GRANT SELECT, INSERT ON public.wk_audit_events TO "${role}"`)
      // Drop the triggers so ONLY the privilege can refuse; restored below.
      await client.query('DROP TRIGGER wk_audit_events_no_update ON public.wk_audit_events')

      const runtimeUrl = url.replace('postgres:wikikit-local@', `${role}:probe@`)
      const runtime = new pg.Client({ connectionString: runtimeUrl })
      await runtime.connect()
      try {
        const refused = await runtime.query(`UPDATE public.wk_audit_events SET action = 'x' WHERE seq = 1`).then(
          () => null,
          (error: { code?: string; message: string }) => error,
        )
        expect(refused, 'ACL did not refuse the UPDATE').not.toBeNull()
        expect(refused!.code).toBe('42501')
        expect(refused!.message).toMatch(/permission denied/i)
        // The same role may still read and append — append-only, not read-only.
        await runtime.query('SELECT count(*) FROM public.wk_audit_events')
      } finally {
        await runtime.end()
      }
    } finally {
      await client.query(`
        CREATE TRIGGER wk_audit_events_no_update
          BEFORE UPDATE ON public.wk_audit_events
          FOR EACH ROW EXECUTE FUNCTION public.wk_audit_events_append_only()
      `)
      await client.query(`REVOKE ALL ON public.wk_audit_events FROM "${role}"`).catch(() => {})
      await client.query(`REVOKE ALL ON SCHEMA public FROM "${role}"`).catch(() => {})
      await client.query(`REVOKE ALL ON DATABASE "wikikit_test_audit" FROM "${role}"`).catch(() => {})
      await client.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {})
      await client.end()
    }
  })

  // GEGENPROBE 2 — a successful change whose audit entry fails must roll back
  // the change. The chain head is removed so wk_append_audit_event raises;
  // the write inside the same transaction must not survive.
  it('rolls the business change back when its audit entry cannot be written', async () => {
    const spaceId = await seedSpace('audit-coupling')
    const [proposal] = await db.insert<{ id: string }>('wk_change_proposals', {
      space_id: spaceId,
      title: 'coupled write',
      input_hash: randomUUID(),
      agent_meta: {},
    })

    const head = new pg.Client({ connectionString: url })
    await head.connect()
    await head.query(`DELETE FROM public.wk_audit_chain_head WHERE stream = 'global'`)
    const beforeCount = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM wk_audit_events')

    const failed = await auditedTx(db, async (tx) => {
      await tx.update('wk_change_proposals', { id: `eq.${proposal!.id}` }, { title: 'MUST NOT SURVIVE' })
      return {
        value: 'unreachable',
        event: {
          action: 'proposal.approved',
          resourceType: 'change_proposal',
          resourceId: proposal!.id,
          result: 'success' as const,
          transport: 'http' as const,
          actor: SYSTEM_ACTOR,
          spaceId,
        },
      }
    }).then(
      () => null,
      (error: Error) => error,
    )
    expect(failed, 'the append did not fail — the counter-proof proves nothing').not.toBeNull()
    expect(failed!.message).toMatch(/audit chain head missing/)

    const [after] = await db.select<{ title: string }>('wk_change_proposals', { id: `eq.${proposal!.id}` })
    expect(after!.title).toBe('coupled write')
    const afterCount = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM wk_audit_events')
    expect(afterCount.rows[0]!.n).toBe(beforeCount.rows[0]!.n)

    // Restore the head from the trail itself — it is a pointer, the rows are
    // the evidence.
    await head.query(`
      INSERT INTO public.wk_audit_chain_head (stream, seq, sha256)
      SELECT 'global', seq, sha256 FROM public.wk_audit_events ORDER BY seq DESC LIMIT 1
    `)
    await head.end()

    // And the coupling works in the other direction: a successful change lands
    // together with exactly one entry.
    const receipt = await auditedTx(db, async (tx) => {
      await tx.update('wk_change_proposals', { id: `eq.${proposal!.id}` }, { title: 'committed together' })
      return {
        value: 'ok',
        event: {
          action: 'proposal.approved',
          resourceType: 'change_proposal',
          resourceId: proposal!.id,
          result: 'success' as const,
          transport: 'http' as const,
          actor: SYSTEM_ACTOR,
          spaceId,
        },
      }
    })
    expect(receipt).toBe('ok')
    const [committed] = await db.select<{ title: string }>('wk_change_proposals', { id: `eq.${proposal!.id}` })
    expect(committed!.title).toBe('committed together')
    const { items } = await listAuditEvents(db, { resourceId: proposal!.id })
    expect(items).toHaveLength(1)
  })

  it('filters, pages by seq and reports an exact total', async () => {
    const spaceId = await seedSpace('audit-paging')
    for (let index = 0; index < 5; index++) {
      await appendAuditEvent(db, {
        action: 'page.read',
        resourceType: 'concept',
        resourceId: `paged-${index}`,
        result: 'success',
        transport: 'mcp',
        actor: SYSTEM_ACTOR,
        spaceId,
      })
    }
    const first = await listAuditEvents(db, { spaceId, action: 'page.read', limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.page.has_more).toBe(true)
    expect(first.page.total).toBe(5)
    expect(first.page.total_exact).toBe(true)
    expect(first.items[0]!.seq).toBeGreaterThan(first.items[1]!.seq)

    const second = await listAuditEvents(db, {
      spaceId,
      action: 'page.read',
      limit: 10,
      cursor: first.page.next_cursor!,
    })
    expect(second.items).toHaveLength(3)
    expect(second.page.has_more).toBe(false)
    expect(second.page.next_cursor).toBeNull()
    // total is the size of the filtered set, not of the remainder.
    expect(second.page.total).toBe(5)

    // A space-scoped reader still sees deployment-wide rows (space_id IS NULL).
    const scoped = await listAuditEvents(db, { visibleSpaceIds: [spaceId], action: 'audit.trail.opened' })
    expect(scoped.items).toHaveLength(1)
    const blind = await listAuditEvents(db, { visibleSpaceIds: [] })
    expect(blind.items).toHaveLength(0)
  })

  it('redacts credential-shaped keys before they reach a row that never expires', async () => {
    const spaceId = await seedSpace('audit-redaction')
    await appendAuditEvent(db, {
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: 'k1',
      result: 'success',
      transport: 'http',
      actor: SYSTEM_ACTOR,
      spaceId,
      after: { name: 'ci', api_key: 'wk_live_secret', nested: { authorization: 'Bearer x', keep: 'visible' } },
    })
    const { items } = await listAuditEvents(db, { spaceId, action: 'api_key.created' })
    const after = items[0]!.after as Record<string, unknown>
    expect(after.api_key).toBe('[redacted]')
    expect((after.nested as Record<string, unknown>).authorization).toBe('[redacted]')
    expect((after.nested as Record<string, unknown>).keep).toBe('visible')
    expect(after.name).toBe('ci')
    // Pure function, same rule.
    expect(sanitizeAuditPayload({ token: 'x' })).toEqual({ token: '[redacted]' })
  })

  it('derives the actor from the credential class, never from a caller-supplied name', () => {
    expect(actorFromPrincipal({ keyId: 'session:op-1', name: 'Mike', scopes: [], spaceId: null })).toEqual({
      kind: 'operator_session',
      id: 'op-1',
      label: 'Mike',
    })
    expect(actorFromPrincipal({ keyId: 'oauth:id-1', name: 'mike@example.com', scopes: [], spaceId: null })).toEqual({
      kind: 'identity',
      id: 'id-1',
      label: 'mike@example.com',
    })
    expect(actorFromPrincipal({ keyId: 'bootstrap', name: 'bootstrap', scopes: [], spaceId: null })).toEqual({
      kind: 'api_key',
      id: 'bootstrap',
      label: 'bootstrap',
    })
    expect(actorFromPrincipal(null)).toEqual({ kind: 'anonymous', id: null, label: null })
  })
})
