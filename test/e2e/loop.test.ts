// End-to-end: the real HTTP surface, the real ingest pipeline, real Postgres,
// and the REAL provider (`ai` + `@ai-sdk/anthropic`) talking to a stub
// Anthropic endpoint. Nothing below the composition root is mocked.
//
// WHY this layer exists at all, given unit + integration are green: every other
// suite injects FakeProvider, which replaces the provider object — so the whole
// vendor edge goes untested. These assertions are the ones only this layer can
// make, and each maps to a way the product silently breaks on a dependency bump:
//   - the request the SDK builds (structured-output schema, max_tokens)
//   - cache_control landing on the byte-stable system part → the prompt-cache
//     hit that makes synthesis affordable (a regression here is a 5x bill, and
//     nothing else would fail)
//   - usage (incl. cache reads) and the answered model id reaching wk_agent_runs
//   - stop_reason mapping to the typed error set
// Gated behind RUN_INTEGRATION=1; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createApp, type App } from '../../src/app.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createLlmProvider } from '../../src/llm/aisdk.ts'
import { createLogger } from '../../src/logger.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { startLlmStub, type LlmStub } from './llm-stub.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BOOTSTRAP = 'wk_e2e-bootstrap'
const SOURCE_MD = '# OKF\n\nThe Open Knowledge Format is a draft specification at v0.1.\n'

function e2eConfig(databaseUrl: string, stubUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl,
    keyPepper: 'e2e-pepper',
    bootstrapApiKey: BOOTSTRAP,
    llmProvider: 'anthropic' as const,
    llmApiKey: 'sk-ant-e2e-stub',
    llmApiKeyEnv: 'ANTHROPIC_API_KEY',
    // The whole point: the real SDK, pointed at our endpoint.
    anthropicBaseUrl: stubUrl,
    modelSynthesis: 'claude-sonnet-5',
    modelClassify: 'claude-haiku-4-5',
    modelAnswer: 'claude-sonnet-5',
    maxBodyBytes: 10 * 1024 * 1024,
    maxIngestTokens: 100_000,
    ingestConcurrency: 1,
    webhookPollMs: 60_000,
    webhookTimeoutMs: 1000,
    webhookMaxAttempts: 1,
    webhookCircuitThreshold: 5,
    webhookAllowPrivateTargets: true,
    trustProxy: false,
    mcpSessionTtlMs: 60_000,
    mcpMaxSessions: 10,
    logLevel: 'error',
    version: '0.0.0-e2e',
    llmConfigured: true,
  }
}

/** Canned model output per call kind — quotes are verbatim from SOURCE_MD so the grounding guard keeps the claim. */
const RESPONSES: Record<string, unknown> = {
  classify: { affected: [], new: [{ slug: 'open-knowledge-format', title: 'Open Knowledge Format' }] },
  synthesize: {
    title: 'Open Knowledge Format',
    summary: 'A draft bundle format.',
    markdown: '# Open Knowledge Format\n\nOKF is a draft at v0.1.\n',
    claims: [
      {
        subject: 'open-knowledge-format',
        predicate: 'has_status',
        object: 'draft-v0.1',
        quote: 'The Open Knowledge Format is a draft specification at v0.1.',
        confidence: 0.9,
      },
    ],
    relations: [],
    decisions: [],
  },
  answer: {
    answer_markdown: 'OKF is a draft at v0.1 [open-knowledge-format].',
    cited_slugs: ['open-knowledge-format'],
    not_in_knowledge_base: false,
  },
  distill: { learnings: [] },
}

let app: App
let stub: LlmStub
let base: string

const json = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' })

describe('e2e: real SDK against a stub Anthropic endpoint', () => {
  beforeAll(async () => {
    if (!integration) return
    stub = startLlmStub((kind) => RESPONSES[kind] ?? {})
    const url = await provisionIntegrationDatabase('wikikit_test_e2e')
    const config = e2eConfig(url, stub.url)
    await runMigrations(config)
    app = createApp(config, {
      // No FakeProvider — the real thing.
      llm: createLlmProvider(config),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'demo', name: 'Demo' }),
    })
  })

  afterAll(async () => {
    if (!integration) return
    await app.close()
    stub?.stop()
  })

  it('ingests through the real provider and stages a grounded proposal', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/ingest`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ markdown: SOURCE_MD, title: 'OKF note' }),
    })
    expect(res.status).toBe(202)
    const { ingest_id } = (await res.json()) as { ingest_id: string }

    expect(await app.ingest.runOnce()).toBe(true)
    const status = await fetch(`${base}/v1/ingests/${ingest_id}`, { headers: json(BOOTSTRAP) })
    const job = (await status.json()) as { status: string; proposal_id: string | null; error: unknown }
    expect(job.error).toBeNull()
    expect(job.status).toBe('done')
    expect(job.proposal_id).toBeTruthy()

    // Two real HTTP round trips through the SDK: classify, then synthesize.
    const kinds = stub.calls.map((call) => call.system.slice(0, 30))
    expect(kinds.some((k) => k.startsWith('You are the classification'))).toBe(true)
    expect(kinds.some((k) => k.startsWith('You are the synthesis'))).toBe(true)

    // The claim survived the grounding guard, so the quote really did travel
    // out to the "model" and back and still matched the archived source.
    const diff = await fetch(`${base}/v1/proposals/${job.proposal_id}`, {
      headers: { authorization: `Bearer ${BOOTSTRAP}`, accept: 'text/markdown' },
    })
    expect(await diff.text()).toContain('has_status')
  })

  it('sends the cached system prefix and the structured-output schema the SDK derives', async () => {
    const classify = stub.calls.find((call) => call.system.startsWith('You are the classification'))!

    // The cost-critical property (a benchmark once measured ~5x input tokens
    // without it): the byte-stable system prompt rides as its own part and
    // carries cache_control, with the per-source material in a second part.
    expect(classify.cacheControl).toEqual({ type: 'ephemeral' })
    expect(classify.parts).toBe(2)
    expect(classify.rendered).toContain('Concept index')
    expect(classify.system).not.toContain('Concept index')

    // Our zod object reached the wire as a closed json_schema — this is what
    // constrains the model, and it is generated, so nothing else proves it.
    expect(classify.schema.type).toBe('object')
    expect(classify.schema.additionalProperties).toBe(false)
    expect(Object.keys(classify.schema.properties as object).sort()).toEqual(['affected', 'new'])
    expect(classify.model).toBe('claude-haiku-4-5')
    expect(classify.maxTokens).toBe(2048)
  })

  it('records the answered model and cache-read usage in the audit ledger', async () => {
    const runs = await app.database.db.select<{ kind: string; model: string; usage: Record<string, number> }>(
      'wk_agent_runs',
      { kind: 'eq.classify', limit: 1 },
    )
    expect(runs).toHaveLength(1)
    // The id the API ANSWERED with, not the alias we asked for — provenance
    // must survive an alias silently resolving to a new dated model.
    expect(runs[0]!.model).toBe('claude-haiku-4-5-stub')
    // Cache reads are the audit trail of the cost mechanism above.
    expect(runs[0]!.usage.cache_read_input_tokens).toBe(1900)
    expect(runs[0]!.usage.input_tokens).toBe(120)
  })

  it('answers a query through the real provider with citations', async () => {
    const approve = await fetch(`${base}/v1/spaces/demo/proposals?status=pending`, { headers: json(BOOTSTRAP) })
    const { items } = (await approve.json()) as { items: { id: string }[] }
    await fetch(`${base}/v1/proposals/${items[0]!.id}/approve`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ note: 'e2e' }),
    })

    // Terms that actually occur in the approved concept: retrieval is FTS with
    // AND semantics, so a question about words the knowledge base never uses
    // legitimately returns no evidence (and would cite nothing).
    const res = await fetch(`${base}/v1/spaces/demo/query`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ question: 'open knowledge format' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { citations: { slug: string }[]; agent_run_id: string }
    // Citations resolve through evidence actually loaded, so this proves the
    // whole retrieval → real-SDK → cite chain, not just that the stub answered.
    expect(body.citations.map((c) => c.slug)).toContain('open-knowledge-format')
    expect(body.agent_run_id).toBeTruthy()
  })

  it('captures a session through the real provider', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/agent/sessions`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ transcript: 'user: fix the typo\nassistant: done' }),
    })
    expect(res.status).toBe(200)
    // The stub answers `{learnings: []}` — the routine-session path, over the
    // real SDK: a valid empty structured output must not read as a failure.
    expect(await res.json()).toMatchObject({ status: 'no_learnings', learnings: 0 })

    const distill = stub.calls.filter((call) => call.system.startsWith('You are the session-distillation'))
    expect(distill).toHaveLength(1)
    expect(distill[0]!.model).toBe('claude-haiku-4-5')
    expect(distill[0]!.rendered).toContain('<transcript>')
  })
})
