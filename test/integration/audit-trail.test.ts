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
import { readFileSync } from 'node:fs'
import { LOCAL_DATABASE_URL, provisionIntegrationDatabase } from '../../scripts/start-local.ts'
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

// ---------------------------------------------------------------------------
// The ACL leg needs a shape the local container does not have: an owner that
// is NOT a superuser. `postgres` bypasses every ACL, so against it the trigger
// is the only thing that can bite and the REVOKE lines are unmeasured — which
// is how the first version of this test came to pass identically with those
// lines deleted. Every helper below exists to build the PROD shape instead: a
// database whose owner is an ordinary role, with 0046 applied AS that role, so
// `revoke ... from current_user` names it.

const AUDIT_MIGRATION = readFileSync(
  new URL('../../src/db/migrations/0046_wk_audit_trail.sql', import.meta.url),
  'utf8',
)

/**
 * The same migration with its two REVOKE statements deleted — the build the
 * counter-proof runs. If the wording ever changes this throws instead of
 * silently removing nothing and "proving" the same thing twice.
 */
function withoutTheRevokes(sql: string): string {
  const lines = sql.split('\n')
  const kept = lines.filter((line) => !/^revoke\s+update,\s*delete,\s*truncate\b/i.test(line))
  const removed = lines.length - kept.length
  if (removed !== 2) throw new Error(`expected 2 REVOKE lines in 0046, removed ${removed}`)
  return kept.join('\n')
}

interface OwnedDatabase {
  /** Connection string for the non-superuser owner. */
  ownerUrl: string
  role: string
  drop(): Promise<void>
}

/** A throwaway database owned by a fresh non-superuser role, with `sql` applied AS that role. */
async function provisionOwnedDatabase(sql: string): Promise<OwnedDatabase> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
  const role = `wk_audit_owner_${suffix}`
  const name = `wikikit_test_audit_owner_${suffix}`
  const admin = new pg.Client({ connectionString: LOCAL_DATABASE_URL })
  await admin.connect()
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'probe' NOSUPERUSER NOCREATEDB NOCREATEROLE`)
    await admin.query(`CREATE DATABASE "${name}" OWNER "${role}"`)
  } finally {
    await admin.end()
  }
  const adminUrl = LOCAL_DATABASE_URL.replace(/\/wikikit$/, `/${name}`)
  // pgcrypto and the schema hand-over are the DEPLOYMENT's job, not the
  // migration's: 0046 needs digest(), and since PostgreSQL 15 an ordinary role
  // cannot create in `public` unless it owns it. Doing both here as the
  // superuser keeps the migration itself running with ordinary privileges.
  const seed = new pg.Client({ connectionString: adminUrl })
  await seed.connect()
  try {
    await seed.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await seed.query(`ALTER SCHEMA public OWNER TO "${role}"`)
  } finally {
    await seed.end()
  }
  const ownerUrl = adminUrl.replace('postgres:wikikit-local@', `${role}:probe@`)
  const owner = new pg.Client({ connectionString: ownerUrl })
  await owner.connect()
  try {
    await owner.query(sql)
  } finally {
    await owner.end()
  }
  return {
    ownerUrl,
    role,
    async drop() {
      const cleanup = new pg.Client({ connectionString: LOCAL_DATABASE_URL })
      await cleanup.connect()
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        await cleanup.query(`DROP ROLE IF EXISTS "${role}"`)
      } finally {
        await cleanup.end()
      }
    },
  }
}

/**
 * Take the triggers off, as the owner is entitled to, so that ONLY the
 * privilege can answer. This is the step that separates the two mechanisms
 * §15.5 insists on measuring separately.
 */
async function dropImmutabilityTriggers(client: pg.Client): Promise<void> {
  for (const trigger of ['no_update', 'no_delete', 'no_truncate']) {
    await client.query(`DROP TRIGGER wk_audit_events_${trigger} ON public.wk_audit_events`)
  }
}

const MUTATIONS = [
  `UPDATE public.wk_audit_events SET action = 'tampered' WHERE seq = 1`,
  `DELETE FROM public.wk_audit_events WHERE seq = 1`,
  `TRUNCATE public.wk_audit_events`,
]

async function attempt(client: pg.Client, sql: string): Promise<{ code?: string; message: string } | null> {
  return await client.query(sql).then(
    () => null,
    (error: { code?: string; message: string }) => error,
  )
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

  // The privilege half of the same rule (Nachweis A3), against the shape that
  // can actually measure it.
  //
  // The previous version of this test granted a fresh role SELECT, INSERT and
  // then showed it could not UPDATE. That is a property of PostgreSQL, not of
  // this migration: a role never granted UPDATE cannot UPDATE whether or not
  // 0046 revokes anything, and the test passed unchanged with both REVOKE
  // lines deleted. It stood on a check that did not measure it.
  //
  // What 0046 actually revokes is the OWNER's own implicit rights
  // (`revoke ... from current_user`), and that only bites where the owner is
  // not a superuser — which is every real deployment and not the local
  // container. So the database below is owned by an ordinary role and the
  // migration is applied AS that role.
  it('A3 · a non-superuser OWNER is refused UPDATE, DELETE and TRUNCATE by the migration alone', async () => {
    const owned = await provisionOwnedDatabase(AUDIT_MIGRATION)
    try {
      const client = new pg.Client({ connectionString: owned.ownerUrl })
      await client.connect()
      try {
        await dropImmutabilityTriggers(client)
        for (const sql of MUTATIONS) {
          const refused = await attempt(client, sql)
          expect(refused, `${sql} was NOT refused`).not.toBeNull()
          expect(refused!.code, sql).toBe('42501')
          expect(refused!.message, sql).toMatch(/permission denied/i)
        }
        // Append-only, not read-only: the same owner still reads and appends,
        // and the genesis row it wrote during the migration is untouched.
        const { rows } = await client.query<{ n: number; action: string }>(
          `SELECT count(*)::int AS n, min(action) AS action FROM public.wk_audit_events`,
        )
        expect(rows[0]!.n).toBe(1)
        expect(rows[0]!.action).toBe('audit.trail.opened')
      } finally {
        await client.end()
      }
    } finally {
      await owned.drop()
    }
  })

  // GEGENPROBE to the test above — the check the old one could not pass.
  // Identical setup, identical statements, with only the two REVOKE lines
  // removed from the migration text. If those lines were decoration, this
  // would still be refused; it is not.
  it('A3 · counter-proof: delete the two REVOKE lines and the same owner rewrites the genesis row', async () => {
    const owned = await provisionOwnedDatabase(withoutTheRevokes(AUDIT_MIGRATION))
    try {
      const client = new pg.Client({ connectionString: owned.ownerUrl })
      await client.connect()
      try {
        await dropImmutabilityTriggers(client)
        const updated = await client.query(`UPDATE public.wk_audit_events SET action = 'tampered' WHERE seq = 1`)
        expect(updated.rowCount, 'the REVOKE lines are what refuse — remove them and the UPDATE lands').toBe(1)
        const { rows } = await client.query<{ action: string }>(
          `SELECT action FROM public.wk_audit_events WHERE seq = 1`,
        )
        expect(rows[0]!.action).toBe('tampered')
      } finally {
        await client.end()
      }
    } finally {
      await owned.drop()
    }
  })

  // The NAMED LIMIT, measured rather than claimed. 0046 says an owner "can
  // grant them back, which is why the triggers above exist" — so the ACL and
  // the triggers cover each other, and nothing covers an owner that removes
  // both. This test pins that: it is the boundary of the guarantee, and if it
  // ever starts failing the sentence in the migration needs rewriting, not the
  // test.
  it('A3 · named limit: an owner that re-grants to itself AND drops the triggers can still rewrite the past', async () => {
    const owned = await provisionOwnedDatabase(AUDIT_MIGRATION)
    try {
      const client = new pg.Client({ connectionString: owned.ownerUrl })
      await client.connect()
      try {
        await dropImmutabilityTriggers(client)
        await client.query(`GRANT UPDATE, DELETE, TRUNCATE ON public.wk_audit_events TO CURRENT_USER`)
        const updated = await client.query(`UPDATE public.wk_audit_events SET action = 'tampered' WHERE seq = 1`)
        expect(updated.rowCount).toBe(1)
      } finally {
        await client.end()
      }
    } finally {
      await owned.drop()
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

    // A space-scoped reader still sees the wiki-less rows that RECORD the
    // installation (the trail opening is one).
    const scoped = await listAuditEvents(db, { visibleSpaceIds: [spaceId], action: 'audit.trail.opened' })
    expect(scoped.items).toHaveLength(1)
    const blind = await listAuditEvents(db, { visibleSpaceIds: [] })
    expect(blind.items).toHaveLength(0)
  })

  it('keeps a wiki-less REFUSAL out of every narrowed reader (WK-AUDIT-VERWEIGERUNG-DEPLOYMENTWEIT-LESBAR)', async () => {
    // The two tenants of the measured leak. A refusal is recorded before the
    // wiki is known, so it carries space_id NULL and a resource_id that is the
    // caller's raw path parameter. Under the old rule ("wiki-less belongs to
    // whoever may read the trail at all") tenant B read it.
    const tenantA = await seedSpace('audit-tenant-a')
    const tenantB = await seedSpace('audit-tenant-b')
    const fabricated = randomUUID()
    await appendAuditEvent(db, {
      action: 'proposal.approved',
      resourceType: 'change_proposal',
      resourceId: fabricated,
      result: 'denied',
      transport: 'http',
      actor: { kind: 'api_key', id: 'key-a', label: 'tenant-a-reader' },
      spaceId: null,
      metadata: { error: 'this key lacks the knowledge:approve scope' },
    })

    const seesRefusal = async (visibleSpaceIds: readonly string[] | null) =>
      (await listAuditEvents(db, { visibleSpaceIds, resourceId: fabricated, limit: 200 })).items.length

    // Tenant B is the leak. Tenant A is not a loophole either: the row names
    // no wiki, so no narrowed reader gets it — only an un-narrowed one.
    expect(await seesRefusal([tenantB])).toBe(0)
    expect(await seesRefusal([tenantA])).toBe(0)
    expect(await seesRefusal([tenantA, tenantB])).toBe(0)
    expect(await seesRefusal(null)).toBe(1)

    // The half that must NOT change: a refusal that names a wiki stays
    // readable by that wiki, and only by it.
    const named = randomUUID()
    await appendAuditEvent(db, {
      action: 'proposal.approved',
      resourceType: 'change_proposal',
      resourceId: named,
      result: 'denied',
      transport: 'http',
      actor: { kind: 'api_key', id: 'key-b', label: 'tenant-b-approver' },
      spaceId: tenantA,
      metadata: { error: 'this key is not scoped to that wiki' },
    })
    const seesNamed = async (visibleSpaceIds: readonly string[] | null) =>
      (await listAuditEvents(db, { visibleSpaceIds, resourceId: named, limit: 200 })).items.length
    expect(await seesNamed([tenantA])).toBe(1)
    expect(await seesNamed([tenantB])).toBe(0)
    expect(await seesNamed(null)).toBe(1)

    // `total` is computed from the same filter, so the count cannot leak what
    // the page withholds.
    const page = await listAuditEvents(db, { visibleSpaceIds: [tenantB], result: 'denied', limit: 200 })
    expect(page.items).toHaveLength(0)
    expect(page.page.total).toBe(0)
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

  it('redacts prompt surface too, and keeps the provenance that identifies it (E10)', async () => {
    // Nachweis 10 measured at the READ surface, not at the schema. Before this
    // rule, `prompt`, `system_prompt`, `prompt_text`, `messages` and
    // `instructions` all went through verbatim up to 2000 characters. No
    // review handler carries prompt surface today, so the hole was latent —
    // ingest and MCP are the next writers, and they carry nothing else.
    const spaceId = await seedSpace('audit-prompt-redaction')
    const SECRET = 'SYSTEM-PROMPT-MUST-NOT-BE-RETAINED'
    await appendAuditEvent(db, {
      action: 'ingest.synthesized',
      resourceType: 'ingest_job',
      resourceId: 'j1',
      result: 'success',
      transport: 'mcp',
      actor: SYSTEM_ACTOR,
      spaceId,
      after: {
        prompt: SECRET,
        system_prompt: SECRET,
        prompt_text: SECRET,
        promptText: SECRET,
        messages: [SECRET],
        instructions: SECRET,
        // Provenance, and the whole point of keeping it: §1.14 identifies the
        // template so a synthesis stays reproducible.
        agent_meta: { model: 'claude-sonnet-5', prompt_version: 'synthesize.v4' },
      },
    })
    const { items } = await listAuditEvents(db, { spaceId, action: 'ingest.synthesized' })
    const row = items[0]!
    expect(JSON.stringify(row)).not.toContain(SECRET)
    const after = row.after as Record<string, unknown>
    for (const key of ['prompt', 'system_prompt', 'prompt_text', 'promptText', 'messages', 'instructions']) {
      expect(after[key]).toBe('[redacted]')
    }
    const meta = after.agent_meta as Record<string, unknown>
    expect(meta.prompt_version).toBe('synthesize.v4')
    expect(meta.model).toBe('claude-sonnet-5')
    // The exemption is EXACT, never a substring: the next `prompt_version_key`
    // does not inherit the door cut for provenance.
    expect(sanitizeAuditPayload({ prompt_version_secret: 'x' })).toEqual({ prompt_version_secret: '[redacted]' })
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
