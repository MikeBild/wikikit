// Full HTTP surface against a real Docker Postgres — the Karpathy loop over
// the wire: ingest → poll → diff → approve → read → search → lint → export →
// import, plus ETag, 409 dedup and webhook admin. FakeProvider keeps every
// LLM stage deterministic and offline.
// Gated behind RUN_INTEGRATION=1; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../../src/config.ts'
import { createApp, type App } from '../../src/app.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createLogger } from '../../src/logger.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BOOTSTRAP = 'wk_itest-http-bootstrap'

function integrationConfig(databaseUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl,
    keyPepper: 'itest-http-pepper',
    bootstrapApiKey: BOOTSTRAP,
    llmProvider: 'anthropic' as const,
    llmApiKey: '',
    llmApiKeyEnv: 'ANTHROPIC_API_KEY',
    anthropicBaseUrl: '',
    modelSynthesis: 'claude-sonnet-5',
    modelClassify: 'claude-haiku-4-5',
    modelAnswer: 'claude-sonnet-5',
    maxBodyBytes: 10 * 1024 * 1024,
    maxIngestTokens: 100_000,
    ingestConcurrency: 1,
    ingestLeaseMs: 15 * 60 * 1000,
    ingestHeartbeatMs: 30_000,
    webhookPollMs: 60_000,
    webhookTimeoutMs: 1000,
    webhookMaxAttempts: 1,
    webhookCircuitThreshold: 5,
    webhookAllowPrivateTargets: true,
    trustProxy: false,
    mcpSessionTtlMs: 60_000,
    mcpMaxSessions: 10,
    usageTelemetryEnabled: true,
    usageHmacSecret: 'itest-http-usage-secret',
    usageRetentionDays: 90,
    logLevel: 'error',
    version: '0.0.0-itest',
    llmConfigured: false,
  }
}

let app: App
let base: string
let readerKey = ''
let writerKey = ''
let approverKey = ''
let proposalId = ''
let ingestId = ''
let sourceId = ''

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
const json = (key: string) => ({ ...bearer(key), 'content-type': 'application/json' })

const NOTE_MD = '# OKF is a draft\n\nThe Open Knowledge Format is currently a v0.1 draft.\n'

describe('http surface (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_http')
    const config = integrationConfig(url)
    await runMigrations(config)
    app = createApp(config, {
      llm: createFakeProvider(),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  })

  afterAll(async () => {
    if (!integration) return
    await app.close()
  })

  it('creates a space (admin) and mints scoped keys', async () => {
    const created = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'demo', name: 'Demo Space' }),
    })
    expect(created.status).toBe(201)
    const space = (await created.json()) as { slug: string; epoch: number }
    expect(space.slug).toBe('demo')
    expect(space.epoch).toBe(0)

    // Duplicate slug → 400 (caller mistake, §8.2 table has no space 409 code).
    const dup = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'demo', name: 'Again' }),
    })
    expect(dup.status).toBe(400)

    for (const [name, scopes, assign] of [
      ['reader', ['knowledge:read'], (k: string) => (readerKey = k)],
      ['writer', ['knowledge:read', 'knowledge:propose'], (k: string) => (writerKey = k)],
      ['approver', ['knowledge:read', 'knowledge:approve'], (k: string) => (approverKey = k)],
    ] as const) {
      const res = await fetch(`${base}/v1/api-keys`, {
        method: 'POST',
        headers: json(BOOTSTRAP),
        body: JSON.stringify({ name, scopes }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { key: string }
      expect(body.key).toMatch(/^wk_/)
      assign(body.key)
    }
  })

  it('ingest: 202 + Location, job transitions to done with a proposal', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/ingest`, {
      method: 'POST',
      headers: json(writerKey),
      body: JSON.stringify({ markdown: NOTE_MD, title: 'OKF Notes' }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { ingest_id: string; status: string }
    expect(body.status).toBe('queued')
    ingestId = body.ingest_id
    expect(res.headers.get('location')).toBe(`/v1/ingests/${ingestId}`)

    const queued = await fetch(`${base}/v1/ingests/${ingestId}`, { headers: bearer(writerKey) })
    expect(((await queued.json()) as { status: string }).status).toBe('queued')

    // Drive the worker deterministically instead of starting timer loops.
    expect(await app.ingest.runOnce()).toBe(true)

    const done = await fetch(`${base}/v1/ingests/${ingestId}`, { headers: bearer(writerKey) })
    const status = (await done.json()) as { status: string; proposal_id: string; source_id: string; error: unknown }
    expect(status.status).toBe('done')
    expect(status.error).toBeNull()
    proposalId = status.proposal_id
    sourceId = status.source_id
    expect(proposalId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('re-ingesting identical content → synchronous 409 already_ingested with source_id', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/ingest`, {
      method: 'POST',
      headers: json(writerKey),
      body: JSON.stringify({ markdown: NOTE_MD }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; source_id: string }
    expect(body.code).toBe('already_ingested')
    expect(body.source_id).toBe(sourceId)
  })

  it('review page: public content-free HTML shell for one proposal', async () => {
    const page = await fetch(`${base}/review/${proposalId}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
    const html = await page.text()
    expect(html).toContain(proposalId)
    // Content-free shell: nothing from the proposal itself is embedded.
    expect(html).not.toContain('Open Knowledge Format')
    const invalid = await fetch(`${base}/review/not-a-uuid`)
    expect(invalid.status).toBe(400)
  })

  it('proposal diff: JSON structure and text/markdown via Accept', async () => {
    const list = await fetch(`${base}/v1/spaces/demo/proposals?status=pending`, { headers: bearer(readerKey) })
    const { items } = (await list.json()) as { items: { id: string }[] }
    expect(items.map((p) => p.id)).toContain(proposalId)

    const res = await fetch(`${base}/v1/proposals/${proposalId}`, { headers: bearer(readerKey) })
    expect(res.status).toBe(200)
    const detail = (await res.json()) as {
      space: string
      status: string
      space_id?: unknown
      concepts: { slug: string; is_new: boolean; old_markdown: string | null; claims_added: unknown[] }[]
      decisions: {
        slug: string
        title: string
        context: string
        decision: string
        rationale: string
        alternatives: unknown[]
      }[]
      source_ids: string[]
    }
    expect(detail.space).toBe('demo')
    expect(detail.space_id).toBeUndefined() // scoping handle never on the wire
    expect(detail.status).toBe('pending')
    expect(detail.source_ids).toContain(sourceId)
    expect(detail.concepts).toHaveLength(1)
    expect(detail.concepts[0]!.is_new).toBe(true)
    expect(detail.concepts[0]!.claims_added.length).toBeGreaterThan(0)
    expect(detail.decisions).toEqual([])

    const md = await fetch(`${base}/v1/proposals/${proposalId}`, {
      headers: { ...bearer(readerKey), accept: 'text/markdown' },
    })
    expect(md.headers.get('content-type')).toContain('text/markdown')
    const text = await md.text()
    expect(text).toStartWith('# Proposal:')
    expect(text).toContain('demo')
  })

  it('approve: reader is 403, approver flips the proposal atomically', async () => {
    const forbidden = await fetch(`${base}/v1/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: json(readerKey),
      body: JSON.stringify({ note: 'nope' }),
    })
    expect(forbidden.status).toBe(403)

    const res = await fetch(`${base}/v1/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: json(approverKey),
      body: JSON.stringify({ note: 'source is authoritative' }),
    })
    expect(res.status).toBe(200)
    const result = (await res.json()) as { status: string; concepts: string[]; claims_verified: number }
    expect(result.status).toBe('approved')
    expect(result.concepts).toContain('okf-notes')
    expect(result.claims_verified).toBeGreaterThan(0)

    // Double-approve → 409 proposal_not_pending (empty body allowed).
    const again = await fetch(`${base}/v1/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: json(approverKey),
    })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code: string }).code).toBe('proposal_not_pending')
  })

  it('concept read serves markdown + verified claims + citations', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/concepts/okf-notes`, { headers: bearer(readerKey) })
    expect(res.status).toBe(200)
    const concept = (await res.json()) as {
      slug: string
      rev: number
      markdown: string
      claims: { status: string; citations: { source_id: string }[] }[]
      agent_meta: Record<string, unknown>
    }
    expect(concept.slug).toBe('okf-notes')
    expect(concept.rev).toBe(1)
    expect(concept.markdown).toContain('Open Knowledge Format')
    expect(concept.claims.length).toBeGreaterThan(0)
    expect(concept.claims[0]!.status).toBe('verified')
    expect(concept.claims[0]!.citations[0]!.source_id).toBe(sourceId)
    expect(concept.agent_meta.model).toBe('fake')
  })

  it('history exposes revisions with agent_meta (model, prompt version)', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/concepts/okf-notes/history`, { headers: bearer(readerKey) })
    const body = (await res.json()) as { revisions: { rev: number; status: string; agent_meta: { model?: string } }[] }
    expect(body.revisions).toHaveLength(1)
    expect(body.revisions[0]!.status).toBe('current')
    expect(body.revisions[0]!.agent_meta.model).toBe('fake')
  })

  it('concept list: ETag = approved epoch, 304 on If-None-Match', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/concepts`, { headers: bearer(readerKey) })
    expect(res.status).toBe(200)
    const etag = res.headers.get('etag')
    expect(etag).toBe('"1"') // one approved proposal bumped the epoch once
    const body = (await res.json()) as { items: { slug: string }[]; epoch: number }
    expect(body.items.map((i) => i.slug)).toContain('okf-notes')

    const cached = await fetch(`${base}/v1/spaces/demo/concepts`, {
      headers: { ...bearer(readerKey), 'if-none-match': etag! },
    })
    expect(cached.status).toBe(304)
  })

  it('search finds the approved concept via FTS with <mark> headlines', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/search?q=knowledge+format`, { headers: bearer(readerKey) })
    expect(res.status).toBe(200)
    const { hits } = (await res.json()) as { hits: { kind: string; slug: string | null; headline: string }[] }
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.slug === 'okf-notes')).toBe(true)
    expect(hits.some((h) => h.headline.includes('<mark>'))).toBe(true)
  })

  it('query answers with citations through the provider (FakeProvider echo)', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/query`, {
      method: 'POST',
      headers: json(readerKey),
      body: JSON.stringify({ question: 'Is OKF a draft?' }),
    })
    expect(res.status).toBe(200)
    const answer = (await res.json()) as { not_in_knowledge_base: boolean; agent_run_id: string; citations: unknown[] }
    expect(answer.not_in_knowledge_base).toBe(false)
    expect(answer.agent_run_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(answer.citations.length).toBeGreaterThan(0)
  })

  it('sources: keyset list + full read', async () => {
    const list = await fetch(`${base}/v1/spaces/demo/sources`, { headers: bearer(readerKey) })
    const { items } = (await list.json()) as { items: { id: string; content_hash: string }[] }
    expect(items.map((s) => s.id)).toContain(sourceId)

    const one = await fetch(`${base}/v1/spaces/demo/sources/${sourceId}`, { headers: bearer(readerKey) })
    const source = (await one.json()) as { raw_content: string; markdown: string }
    expect(source.raw_content).toBe(NOTE_MD)
  })

  it('decisions: a meeting ingest stages a decision, invisible until approved, then readable', async () => {
    const meetingMd = '# Sync\n\nWe decided to communicate between products over standard webhooks only.'
    const ingest = await fetch(`${base}/v1/spaces/demo/ingest`, {
      method: 'POST',
      headers: json(writerKey),
      body: JSON.stringify({ markdown: meetingMd, title: 'Architecture sync', source_kind: 'meeting' }),
    })
    expect(ingest.status).toBe(202)
    const { ingest_id } = (await ingest.json()) as { ingest_id: string }
    expect(await app.ingest.runOnce()).toBe(true)
    const done = (await (await fetch(`${base}/v1/ingests/${ingest_id}`, { headers: bearer(writerKey) })).json()) as {
      status: string
      proposal_id: string
    }
    expect(done.status).toBe('done')

    const proposalJson = await fetch(`${base}/v1/proposals/${done.proposal_id}`, { headers: bearer(readerKey) })
    expect(proposalJson.status).toBe(200)
    const proposal = (await proposalJson.json()) as {
      space_id?: unknown
      decisions: {
        slug: string
        title: string
        context: string
        decision: string
        rationale: string
        alternatives: unknown[]
      }[]
    }
    expect(proposal.space_id).toBeUndefined()
    expect(proposal.decisions).toEqual([
      {
        slug: 'architecture-sync-decision',
        title: 'Decision on Architecture sync',
        context: '# Sync',
        decision: '# Sync',
        rationale: '',
        alternatives: [],
      },
    ])

    const proposalMarkdown = await fetch(`${base}/v1/proposals/${done.proposal_id}`, {
      headers: { ...bearer(readerKey), accept: 'text/markdown' },
    })
    expect(proposalMarkdown.status).toBe(200)
    const markdown = await proposalMarkdown.text()
    expect(markdown).toContain('## Decision `architecture-sync-decision` — Decision on Architecture sync')
    expect(markdown).toContain('### Context\n\n# Sync')
    expect(markdown).toContain('### Decision\n\n# Sync')
    expect(markdown).toContain('### Rationale\n\n_None provided._')
    expect(markdown).toContain('### Alternatives\n\n```json\n[]\n```')

    // Before approval the decision is staged (proposed) → not readable.
    const beforeList = await fetch(`${base}/v1/spaces/demo/decisions`, { headers: bearer(readerKey) })
    const before = (await beforeList.json()) as { items: { slug: string }[] }
    expect(before.items.length).toBe(0)

    const approved = await fetch(`${base}/v1/proposals/${done.proposal_id}/approve`, {
      method: 'POST',
      headers: json(approverKey),
    })
    expect(approved.status).toBe(200)

    // After approval the decision log lists it and the detail carries the full record.
    const list = await fetch(`${base}/v1/spaces/demo/decisions`, { headers: bearer(readerKey) })
    const listed = (await list.json()) as { items: { slug: string; status: string }[] }
    expect(listed.items.length).toBe(1)
    const slug = listed.items[0]!.slug
    expect(listed.items[0]!.status).toBe('active')

    const detailRes = await fetch(`${base}/v1/spaces/demo/decisions/${slug}`, { headers: bearer(readerKey) })
    expect(detailRes.status).toBe(200)
    const detail = (await detailRes.json()) as { decision: string; context: string; agent_meta: { model?: string } }
    expect(detail.decision.length).toBeGreaterThan(0)
    expect(detail.agent_meta.model).toBe('fake') // provenance carried

    // A missing slug is a clean 404.
    const missing = await fetch(`${base}/v1/spaces/demo/decisions/does-not-exist`, { headers: bearer(readerKey) })
    expect(missing.status).toBe(404)
  })

  it('document upload: a real .docx is extracted and ingested end-to-end', async () => {
    const docx = new Uint8Array(readFileSync(join(import.meta.dir, '../fixtures/documents/sample.docx')))
    const res = await fetch(`${base}/v1/spaces/demo/ingest/document?filename=okf-brief.docx`, {
      method: 'POST',
      headers: { ...bearer(writerKey), 'content-type': 'application/octet-stream' },
      body: docx,
    })
    expect(res.status).toBe(202)
    const { ingest_id } = (await res.json()) as { ingest_id: string }
    expect(res.headers.get('location')).toBe(`/v1/ingests/${ingest_id}`)

    expect(await app.ingest.runOnce()).toBe(true)
    const done = (await (await fetch(`${base}/v1/ingests/${ingest_id}`, { headers: bearer(writerKey) })).json()) as {
      status: string
      source_id: string
    }
    expect(done.status).toBe('done')

    // The archived source is the EXTRACTED markdown from the docx (not the raw
    // binary) — proving the extraction ran before the pipeline.
    const source = (await (
      await fetch(`${base}/v1/spaces/demo/sources/${done.source_id}`, { headers: bearer(readerKey) })
    ).json()) as { raw_content: string; markdown: string }
    expect(source.markdown).toContain('Open Knowledge Format')
    expect(source.markdown).toContain('concept identity')
  })

  it('document upload: unknown extension → 415 unsupported_document', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/ingest/document?filename=archive.zip`, {
      method: 'POST',
      headers: { ...bearer(writerKey), 'content-type': 'application/octet-stream' },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    })
    expect(res.status).toBe(415)
    expect(((await res.json()) as { code: string }).code).toBe('unsupported_document')
  })

  it('lint reports a healthy space (counts shape, CI-consumable)', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/lint`, { headers: bearer(readerKey) })
    expect(res.status).toBe(200)
    const report = (await res.json()) as { findings: { severity: string }[]; counts: { error: number } }
    expect(report.counts.error).toBe(0)
  })

  // Regression guard: /mcp must be mounted by the REAL createApp composition
  // root, not just by the isolated mount tests. A prod deploy 404'd POST /mcp
  // because the mount wiring lived only in a docstring — this initialize check
  // over the same server the binary runs would have caught it.
  it('POST /mcp initialize returns a session (composition-root mount)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        ...json(BOOTSTRAP),
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'it', version: '0' } },
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBeTruthy()
    expect(await res.text()).toContain('protocolVersion')
  })

  it('export streams a zip; import stages it as ONE proposal in another space', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/export?format=md`, { headers: bearer(readerKey) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    const zip = new Uint8Array(await res.arrayBuffer())
    expect([zip[0], zip[1]]).toEqual([0x50, 0x4b]) // 'PK'

    const created = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'imported', name: 'Import Target' }),
    })
    expect(created.status).toBe(201)

    const imported = await fetch(`${base}/v1/spaces/imported/import?format=md`, {
      method: 'POST',
      headers: { ...bearer(writerKey), 'content-type': 'application/zip' },
      body: zip,
    })
    expect(imported.status).toBe(202)
    const body = (await imported.json()) as { proposal_id: string; status: string; sources_created: number }
    expect(body.status).toBe('pending')
    expect(body.sources_created).toBeGreaterThan(0)

    // The review gate holds: nothing readable in 'imported' before approval.
    const concepts = await fetch(`${base}/v1/spaces/imported/concepts`, { headers: bearer(readerKey) })
    expect(((await concepts.json()) as { items: unknown[] }).items).toHaveLength(0)
  })

  it('webhook admin: register (secret shown once), list (no secret), deliveries', async () => {
    const created = await fetch(`${base}/v1/spaces/demo/webhooks`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ url: 'http://127.0.0.1:39999/hook', events: ['wikikit.proposal.created'] }),
    })
    expect(created.status).toBe(201)
    const endpoint = (await created.json()) as { id: string; secret: string }
    expect(endpoint.secret).toStartWith('whsec_')

    const list = await fetch(`${base}/v1/spaces/demo/webhooks`, { headers: bearer(BOOTSTRAP) })
    const { items } = (await list.json()) as { items: Record<string, unknown>[] }
    expect(items).toHaveLength(1)
    expect(items[0]!.secret).toBeUndefined() // shown once at creation only

    const deliveries = await fetch(`${base}/v1/spaces/demo/webhooks/${endpoint.id}/deliveries`, {
      headers: bearer(BOOTSTRAP),
    })
    expect(deliveries.status).toBe(200)

    // Webhook admin is admin-scoped: the writer key must not see it.
    const forbidden = await fetch(`${base}/v1/spaces/demo/webhooks`, { headers: bearer(writerKey) })
    expect(forbidden.status).toBe(403)
  })

  it('rejecting a pending proposal keeps knowledge invisible (audit rows retained)', async () => {
    const staged = await fetch(`${base}/v1/spaces/demo/proposals`, {
      method: 'POST',
      headers: json(writerKey),
      body: JSON.stringify({
        title: 'Manual: rejected knowledge',
        input_hash: 'a'.repeat(64),
        concepts: [
          {
            slug: 'to-be-rejected',
            title: 'To Be Rejected',
            summary: '',
            markdown: '# Never visible',
            claims: [],
            relations: [],
          },
        ],
      }),
    })
    expect(staged.status).toBe(201)
    const { proposal_id } = (await staged.json()) as { proposal_id: string }

    const rejected = await fetch(`${base}/v1/proposals/${proposal_id}/reject`, {
      method: 'POST',
      headers: json(approverKey),
      body: JSON.stringify({ note: 'not knowledge' }),
    })
    expect(rejected.status).toBe(200)
    expect(((await rejected.json()) as { status: string }).status).toBe('rejected')

    const read = await fetch(`${base}/v1/spaces/demo/concepts/to-be-rejected`, { headers: bearer(readerKey) })
    expect(read.status).toBe(404)
  })

  it('product stats aggregate real PostgreSQL rows through the authenticated API', async () => {
    const synthetic = await fetch(`${base}/v1/spaces/demo/search?q=okf`, {
      headers: {
        ...bearer(readerKey),
        'x-wikikit-traffic-class': 'synthetic',
        'x-wikikit-request-source': 'manual',
        'x-wikikit-session-id': 'integration-session',
      },
    })
    expect(synthetic.status).toBe(200)
    await Bun.sleep(20)

    const now = Date.now()
    const query = new URLSearchParams({
      bucket: 'hour',
      from: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      to: new Date(now + 60 * 60 * 1000).toISOString(),
      tz: 'UTC',
    })
    const responses: Record<string, Record<string, unknown>> = {}
    for (const resource of ['ingests', 'knowledge', 'llm', 'webhooks']) {
      const res = await fetch(`${base}/v1/spaces/demo/stats/${resource}?${query}`, { headers: bearer(readerKey) })
      expect(res.status).toBe(200)
      responses[resource] = (await res.json()) as Record<string, unknown>
      expect(responses[resource]!.bucket).toBe('hour')
      expect(responses[resource]!.tz).toBe('UTC')
      const serialized = JSON.stringify(responses[resource])
      expect(serialized).not.toContain(NOTE_MD)
      expect(serialized).not.toContain(sourceId)
      expect(serialized).not.toContain(proposalId)
    }

    const ingestTotals = responses.ingests!.totals as { jobs: Record<string, number> }
    expect(ingestTotals.jobs.created).toBeGreaterThanOrEqual(3)
    expect(ingestTotals.jobs.done).toBeGreaterThanOrEqual(3)
    expect(ingestTotals.jobs.failed).toBe(0)
    const knowledgeTotals = responses.knowledge!.totals as Record<string, number>
    expect(knowledgeTotals.sources_created).toBeGreaterThanOrEqual(3)
    expect(knowledgeTotals.proposals_created).toBeGreaterThanOrEqual(4)
    expect(knowledgeTotals.proposals_approved).toBeGreaterThanOrEqual(2)
    expect(knowledgeTotals.proposals_rejected).toBeGreaterThanOrEqual(1)
    expect((responses.llm!.totals as { calls: number }).calls).toBeGreaterThanOrEqual(7)
    expect((responses.webhooks!.totals as { events: number }).events).toBeGreaterThanOrEqual(1)

    for (const resource of ['http', 'usage', 'reviews']) {
      const res = await fetch(`${base}/v1/spaces/demo/stats/${resource}?${query}&traffic_class=all`, {
        headers: bearer(readerKey),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        schema_version: string
        quality: { sampled: boolean; content_captured: boolean }
        totals: Array<{ metrics: { calls: { value: number }; unique_actors: { value: number } } }>
      }
      expect(body.schema_version).toBe('wikikit.usage-stats.v1')
      expect(body.quality).toMatchObject({ sampled: false, content_captured: false })
      expect(body.totals[0]!.metrics.calls.value).toBeGreaterThan(0)
      expect(JSON.stringify(body)).not.toContain(NOTE_MD)
      expect(JSON.stringify(body)).not.toContain(sourceId)
      expect(JSON.stringify(body)).not.toContain(proposalId)
    }

    const { rows: raw } = await app.database.db.query<Record<string, unknown>>(
      'SELECT * FROM wk_usage_events ORDER BY created_at',
    )
    expect(raw.length).toBeGreaterThan(0)
    expect(JSON.stringify(raw)).not.toMatch(
      /integration-session|itest-http-bootstrap|portable knowledge|OKF is a draft/,
    )
    expect(raw.some((row) => row.traffic_class === 'synthetic')).toBe(true)
  })
})
