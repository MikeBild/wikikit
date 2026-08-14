// The cross-wiki overview against real Postgres: the two GROUP BY statements
// in reviewOverview, driven through GET /v1/stats/overview and the
// wikikit_overview tool over seeded rows.
//
// WHY integration and not a stub: the aggregate FILTER + LATERAL combination
// is exactly the SQL a stub cannot vouch for. What is asserted here is the
// semantics the surfaces promise — a space with nothing pending answers a
// measured 0 with a NULL age (never "0 days"), `pending_derived` counts a
// proposal only when EVERY cited source carries the derived stamp (mixed
// provenance does not count), `created_7d` counts any status inside the
// window, and a space-scoped key gets a one-row overview instead of an error.
//
// RUN_INTEGRATION=1 gated; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createApp, type App } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'
import { TOOLS, type Principal, type ToolDeps } from '../../src/mcp/tools.ts'
import { createLogger } from '../../src/logger.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BOOTSTRAP = 'wk_itest-overview-bootstrap'

function integrationConfig(databaseUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl,
    keyPepper: 'itest-overview-pepper',
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
    ingestMaxRuntimeMs: 90 * 60 * 1000,
    webhookPollMs: 60_000,
    webhookTimeoutMs: 1000,
    webhookMaxAttempts: 1,
    webhookCircuitThreshold: 5,
    webhookAllowPrivateTargets: true,
    trustProxy: false,
    mcpSessionTtlMs: 60_000,
    mcpMaxSessions: 10,
    logLevel: 'error',
    version: '0.0.0-itest',
    llmConfigured: false,
    scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS,
    scaffoldingKindsDeclared: false,
    schedulerEnabled: false,
  }
}

let app: App
let database: Database
let db: Db
let base: string
let alphaId = ''
let readerKey = ''
let alphaKey = ''

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
const json = (key: string) => ({ ...bearer(key), 'content-type': 'application/json' })

interface OverviewWire {
  schema_version: string
  generated_at: string
  totals: { pending: number; pending_derived: number; created_7d: number; oldest_days: number | null }
  items: {
    space: string
    name: string
    purpose: string | null
    review_queue: { pending: number; oldest_days: number | null; pending_derived: number }
    created_7d: number
    concepts: number
  }[]
}

async function seedSource(spaceId: string, title: string, derived: boolean): Promise<string> {
  const [row] = await db.insert<{ id: string }>('wk_sources', {
    space_id: spaceId,
    kind: 'markdown',
    title,
    content_hash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    raw_content: `# ${title}`,
    markdown: `# ${title}`,
    metadata: JSON.stringify(derived ? { derived_from_output_id: randomUUID() } : {}),
  })
  return row!.id
}

async function seedProposal(
  spaceId: string,
  args: { status?: string; sourceIds?: string[]; ageDays?: number },
): Promise<void> {
  await db.query(
    `INSERT INTO wk_change_proposals (space_id, status, title, input_hash, source_ids, created_at)
     VALUES ($1, $2, $3, $4, $5::uuid[], now() - make_interval(days => $6))`,
    [
      spaceId,
      args.status ?? 'pending',
      'Seeded change',
      randomUUID().replaceAll('-', ''),
      args.sourceIds ?? [],
      args.ageDays ?? 0,
    ],
  )
}

describe('cross-wiki overview (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_spaces_overview')
    const config = integrationConfig(url)
    await runMigrations(config)
    database = createPostgres(config)
    db = database.db
    app = createApp(config, {
      database,
      llm: createFakeProvider(),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`

    const create = async (slug: string, name: string, settings?: Record<string, unknown>) => {
      const res = await fetch(`${base}/v1/spaces`, {
        method: 'POST',
        headers: json(BOOTSTRAP),
        body: JSON.stringify({ slug, name, settings }),
      })
      return ((await res.json()) as { id: string }).id
    }
    alphaId = await create('alpha', 'Alpha', { purpose: 'First wiki' })
    await create('beta', 'Beta')

    // Alpha: a 21-day-old pending change with MIXED provenance (one derived
    // source beside one outside source — must NOT count as derived), a fresh
    // pending change resting ONLY on derived sources (must count), and an
    // approved change from this week (created_7d counts any status).
    const outside = await seedSource(alphaId, 'Outside evidence', false)
    const derived = await seedSource(alphaId, 'Promoted answer', true)
    await seedProposal(alphaId, { sourceIds: [outside, derived], ageDays: 21 })
    await seedProposal(alphaId, { sourceIds: [derived] })
    await seedProposal(alphaId, { status: 'approved', ageDays: 3 })
    // Two pages, one of them not yet visible (no current revision).
    await db.insert('wk_concepts', {
      space_id: alphaId,
      slug: 'visible-page',
      title: 'Visible',
      current_revision_id: randomUUID(),
    })
    await db.insert('wk_concepts', { space_id: alphaId, slug: 'proposed-only', title: 'Proposed' })

    const mint = async (name: string, scopes: string[], space?: string) => {
      const res = await fetch(`${base}/v1/api-keys`, {
        method: 'POST',
        headers: json(BOOTSTRAP),
        body: JSON.stringify({ name, scopes, ...(space ? { space } : {}) }),
      })
      return ((await res.json()) as { key: string }).key
    }
    readerKey = await mint('reader', ['knowledge:read'])
    alphaKey = await mint('alpha-only', ['knowledge:read'], 'alpha')
  })

  afterAll(async () => {
    if (!integration) return
    await app.close()
  })

  it('aggregates per space with null-not-zero ages and mixed provenance not counted as derived', async () => {
    const res = await fetch(`${base}/v1/stats/overview`, { headers: bearer(readerKey) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as OverviewWire
    expect(body.schema_version).toBe('wikikit.spaces-overview.v1')

    const alpha = body.items.find((item) => item.space === 'alpha')!
    expect(alpha.purpose).toBe('First wiki')
    expect(alpha.review_queue.pending).toBe(2)
    expect(alpha.review_queue.oldest_days).toBe(21)
    // The mixed-provenance proposal does not count: derived means EVERY cited
    // source carries the stamp.
    expect(alpha.review_queue.pending_derived).toBe(1)
    expect(alpha.created_7d).toBe(2)
    expect(alpha.concepts).toBe(1)

    // Beta holds nothing: measured zeros, and a NULL age — never "0 days".
    const beta = body.items.find((item) => item.space === 'beta')!
    expect(beta.purpose).toBeNull()
    expect(beta.review_queue).toEqual({ pending: 0, oldest_days: null, pending_derived: 0 })
    expect(beta.created_7d).toBe(0)
    expect(beta.concepts).toBe(0)

    expect(body.totals).toEqual({ pending: 2, pending_derived: 1, created_7d: 2, oldest_days: 21 })
  })

  it('a space-scoped key gets a one-row overview, not an error', async () => {
    const res = await fetch(`${base}/v1/stats/overview`, { headers: bearer(alphaKey) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as OverviewWire
    expect(body.items.map((item) => item.space)).toEqual(['alpha'])
    expect(body.totals.pending).toBe(2)
  })

  it('wikikit_overview serves the identical wire shape', async () => {
    const tool = TOOLS.find((entry) => entry.name === 'wikikit_overview')!
    const principal: Principal = { keyId: 'itest', scopes: ['knowledge:read'], spaceId: null, name: 'itest' }
    const viaTool = (await tool.execute({ db } as ToolDeps, principal, {})) as OverviewWire
    const viaRest = (await (
      await fetch(`${base}/v1/stats/overview`, { headers: bearer(readerKey) })
    ).json()) as OverviewWire
    // generated_at is the one field that may differ between two reads.
    expect({ ...viaTool, generated_at: null }).toEqual({ ...viaRest, generated_at: null })
  })
})
