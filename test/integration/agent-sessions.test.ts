// Coding-agent session capture against a real Docker Postgres: routine session
// writes nothing, a taught rule becomes a reviewable proposal, re-teaching it
// dedups. Unit tests fake the db; the things that can only break for real are
// here — the wk_agent_runs.kind CHECK constraint has to admit 'distill'
// (migration 0002), and the content-hash dedup has to bite through the actual
// unique index rather than a thrown fake.
// Gated behind RUN_INTEGRATION=1; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createApp, type App } from '../../src/app.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createLogger } from '../../src/logger.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import type { DistillOutput } from '../../src/llm/schemas.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BOOTSTRAP = 'wk_itest-agent-bootstrap'

/** What the distiller returns; flipped per test to drive both branches. */
let distilled: DistillOutput = { learnings: [] }

const TAUGHT: DistillOutput = {
  learnings: [
    {
      title: 'Deploys go through CI',
      rule: 'Never deploy by hand; push to main and let CI deploy.',
      quote: 'no — we never deploy by hand, always let CI do it',
    },
  ],
}

function integrationConfig(databaseUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl,
    keyPepper: 'itest-agent-pepper',
    bootstrapApiKey: BOOTSTRAP,
    llmProvider: 'anthropic' as const,
    llmApiKey: 'itest',
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
    logLevel: 'error',
    version: '0.0.0-itest',
    // FakeProvider is always configured; capture must not 503 here.
    llmConfigured: true,
  }
}

let app: App
let base: string
let writerKey = ''

const json = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' })

interface CaptureBody {
  status: string
  ingest_id: string | null
  learnings: number
  agent_run_id: string
}

async function capture(transcript: string): Promise<CaptureBody> {
  const res = await fetch(`${base}/v1/spaces/demo/agent/sessions`, {
    method: 'POST',
    headers: json(writerKey),
    body: JSON.stringify({ transcript }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as CaptureBody
}

/** Drive the worker deterministically (house pattern) instead of racing a timer. */
async function settleIngest(id: string): Promise<{ status: string; proposal_id: string | null }> {
  expect(await app.ingest.runOnce()).toBe(true)
  const res = await fetch(`${base}/v1/ingests/${id}`, { headers: json(writerKey) })
  return (await res.json()) as { status: string; proposal_id: string | null }
}

describe('agent session capture (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_agent')
    const config = integrationConfig(url)
    await runMigrations(config)
    app = createApp(config, {
      llm: createFakeProvider({ distill: () => distilled }),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`

    await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'demo', name: 'Demo Space' }),
    })
    const key = await fetch(`${base}/v1/api-keys`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ name: 'writer', scopes: ['knowledge:read', 'knowledge:propose'] }),
    })
    writerKey = ((await key.json()) as { key: string }).key
  })

  afterAll(async () => {
    if (!integration) return
    await app.close()
  })

  it('a routine session writes an audit row and nothing else', async () => {
    distilled = { learnings: [] }
    const body = await capture('user: fix the typo\nassistant: fixed')

    expect(body).toMatchObject({ status: 'no_learnings', ingest_id: null, learnings: 0 })
    // The real assertion: a 'distill' row survives the wk_agent_runs kind CHECK
    // (migration 0002). Before it, this insert failed with a constraint error.
    expect(body.agent_run_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a taught rule becomes a pending proposal a human can read', async () => {
    distilled = TAUGHT
    const body = await capture('user: no — we never deploy by hand, always let CI do it')
    expect(body).toMatchObject({ status: 'queued', learnings: 1 })

    const settled = await settleIngest(body.ingest_id!)
    expect(settled.status).toBe('done')
    expect(settled.proposal_id).toBeTruthy()

    const diff = await fetch(`${base}/v1/proposals/${settled.proposal_id}`, {
      headers: { authorization: `Bearer ${writerKey}`, accept: 'text/markdown' },
    })
    expect(diff.status).toBe(200)
    const markdown = await diff.text()
    expect(markdown).toContain('pending')
    // The rule the human taught reached the review gate...
    expect(markdown).toContain('Never deploy by hand')
  })

  it('the staged knowledge stays invisible until someone approves it', async () => {
    const concepts = await fetch(`${base}/v1/spaces/demo/concepts`, { headers: json(writerKey) })
    const body = (await concepts.json()) as { items: unknown[] }
    // ...and stopped there: proposed content is unreachable for readers, so
    // capture can never publish behind the operator's back.
    expect(body.items).toEqual([])
  })

  it('re-teaching the same rule dedups instead of stacking proposals', async () => {
    distilled = TAUGHT
    const body = await capture('user: (said again in a later session) always let CI do it')

    // Same rules → same rendered markdown → same content hash. The hook fires
    // after every session, so this path must be a success, not a 409.
    expect(body).toMatchObject({ status: 'already_captured', ingest_id: null, learnings: 1 })
  })
})
