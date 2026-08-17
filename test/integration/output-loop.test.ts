// The loop, end to end, against real Postgres: ask → the answer is persisted as
// an Output → a human promotes it → the ordinary ingest pipeline archives it as
// a source marked derived → a proposal → an approval → the page is visible, and
// `self-derived-only` reports it for exactly as long as nothing outside the wiki
// backs it up.
//
// WHY THE WHOLE CHAIN IS ONE TEST. Every link is covered somewhere cheaper — the
// rendering's determinism in test/unit/domain-outputs.test.ts, the wire shapes in
// test/contract, the rule's finding shape against a fake pool. What none of them
// can see is the property the design turns on: that promotion is NOT a shortcut.
// The promoted answer has to travel the same road a human's document travels —
// content-hash dedup, the grounding guard, a proposal, a review — and it has to
// arrive marked, so the linter can tell knowledge that quotes the world from
// knowledge that quotes only WikiKit. A stub answers whatever it was handed;
// only a real database settles whether the marker survived the enqueue → worker
// → archive hop, and whether the lint rule's lateral actually splits a page's
// citations by provenance.
//
// The last act is the one that makes the rule fair: an outside source lands on
// the same page and the finding disappears. A warning that never clears is a
// warning operators switch off.
//
// RUN_INTEGRATION=1 gated; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createApp, type App } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'
import { lintSpace } from '../../src/domain/lint.ts'
import { renderOutputSource } from '../../src/domain/outputs.ts'
import { createLogger } from '../../src/logger.ts'
import type { ClassifyOutput } from '../../src/llm/schemas.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BOOTSTRAP = 'wk_itest-loop-bootstrap'

/** Flipped per test: the second ingest has to land on the page the first one made. */
let classifyPlan: ((title: string | null) => ClassifyOutput) | null = null

function integrationConfig(databaseUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl,
    keyPepper: 'itest-loop-pepper',
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
    llmConfigured: true,
    scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS,
    scaffoldingKindsDeclared: false,
    // The scheduler has its own file; a timer racing this one would file
    // briefings into the middle of these assertions.
    schedulerEnabled: false,
  }
}

let app: App
let database: Database
let db: Db
let base: string
let spaceId = ''
let readerKey = ''
let writerKey = ''
let approverKey = ''

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
const json = (key: string) => ({ ...bearer(key), 'content-type': 'application/json' })

/** Ingest one document and drive the worker to a terminal state (house pattern). */
async function ingestAndSettle(body: Record<string, unknown>): Promise<{ ingest_id: string; proposal_id: string }> {
  const accepted = await fetch(`${base}/v1/spaces/demo/ingest`, {
    method: 'POST',
    headers: json(writerKey),
    body: JSON.stringify(body),
  })
  expect(accepted.status).toBe(202)
  const { ingest_id } = (await accepted.json()) as { ingest_id: string }
  return { ingest_id, proposal_id: await settle(ingest_id) }
}

async function settle(ingestId: string): Promise<string> {
  expect(await app.ingest.runOnce()).toBe(true)
  const res = await fetch(`${base}/v1/ingests/${ingestId}`, { headers: bearer(writerKey) })
  const job = (await res.json()) as { status: string; proposal_id: string | null; created_at: string }
  expect(job.status).toBe('done')
  // Additive on the status shape, and the inbox is why: a queued job has no
  // started_at and no finished_at, so without this it carried no time at all.
  expect(job.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(job.proposal_id).toBeTruthy()
  return job.proposal_id!
}

async function approve(proposalId: string): Promise<void> {
  const res = await fetch(`${base}/v1/proposals/${proposalId}/approve`, { method: 'POST', headers: json(approverKey) })
  expect(res.status).toBe(200)
}

async function conceptSlugs(): Promise<string[]> {
  const res = await fetch(`${base}/v1/spaces/demo/concepts`, { headers: bearer(readerKey) })
  const { items } = (await res.json()) as { items: { slug: string }[] }
  return items.map((item) => item.slug)
}

async function selfDerivedSlugs(): Promise<string[]> {
  const report = await lintSpace(db, spaceId, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
  return report.findings.filter((finding) => finding.rule === 'self-derived-only').map((f) => f.concept_slug ?? '')
}

const POLICY_MD = '# Widget policy\n\nEvery widget shipment is checked twice before it leaves the yard.\n'
const OUTSIDE_MD = '# Widget policy addendum\n\nThe yard check is signed off by the shift lead.\n'

let outputId = ''
let promotedIngestId = ''
let promotedSlug = ''

describe('the output loop (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_output_loop')
    const config = integrationConfig(url)
    await runMigrations(config)
    // A pool of our own so the assertions can read the tables the API does not
    // expose (wk_sources.metadata) and run the linter directly.
    database = createPostgres(config)
    db = database.db
    app = createApp(config, {
      database,
      llm: createFakeProvider({
        classify: (input) =>
          classifyPlan?.(input.source.title ?? null) ?? {
            affected: [],
            new: [
              {
                slug: (input.source.title ?? 'untitled')
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 60),
                title: input.source.title ?? 'Untitled',
              },
            ],
          },
      }),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`

    const created = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'demo', name: 'Demo Space' }),
    })
    spaceId = ((await created.json()) as { id: string }).id
    const mint = async (name: string, scopes: string[]) => {
      const res = await fetch(`${base}/v1/api-keys`, {
        method: 'POST',
        headers: json(BOOTSTRAP),
        body: JSON.stringify({ name, scopes }),
      })
      return ((await res.json()) as { key: string }).key
    }
    readerKey = await mint('reader', ['knowledge:read'])
    writerKey = await mint('writer', ['knowledge:read', 'knowledge:propose'])
    approverKey = await mint('approver', ['knowledge:approve'])
  })

  afterAll(async () => {
    if (!integration) return
    await app.close() // closes the database it was handed
  })

  // ------------------------------------------------------------------ set-up
  it('a page grounded in an OUTSIDE source is not reported by self-derived-only', async () => {
    classifyPlan = null
    const { proposal_id } = await ingestAndSettle({ markdown: POLICY_MD, title: 'Widget policy' })
    await approve(proposal_id)

    expect(await conceptSlugs()).toContain('widget-policy')
    // The baseline the rest of this file is measured against: ordinary
    // knowledge, quoting an archived document, reported by nothing.
    expect(await selfDerivedSlugs()).toEqual([])
  })

  // -------------------------------------------------------------------- query
  it('/query persists its answer and hands back the handle to promote it', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/query`, {
      method: 'POST',
      headers: json(readerKey),
      body: JSON.stringify({ question: 'How are widget shipments checked?' }),
    })
    expect(res.status).toBe(200)
    const answer = (await res.json()) as {
      output_id: string | null
      citations: { slug: string }[]
      not_in_knowledge_base: boolean
    }
    expect(answer.not_in_knowledge_base).toBe(false)
    expect(answer.citations.map((c) => c.slug)).toContain('widget-policy')
    // The one additive field, and the whole reason the loop can close: without
    // it a good answer has no handle and the loop ends in the chat window.
    expect(answer.output_id).toMatch(/^[0-9a-f-]{36}$/)
    outputId = answer.output_id!
  })

  it('the output is readable, unpromoted, and its markdown rendering is deterministic', async () => {
    const res = await fetch(`${base}/v1/outputs/${outputId}`, { headers: bearer(readerKey) })
    expect(res.status).toBe(200)
    const output = (await res.json()) as {
      space_id: string
      kind: string
      question: string
      promoted_ingest_id: string | null
      markdown: string
    }
    expect(output.kind).toBe('answer')
    expect(output.question).toBe('How are widget shipments checked?')
    expect(output.promoted_ingest_id).toBeNull()
    // Global-by-id: the id came from /query and carries no space, so the row's
    // space is what the key/space match is enforced against.
    expect(output.space_id).toBe(spaceId)

    // text/markdown serves what promotion WOULD archive, byte for byte — so a
    // reviewer reads exactly the document that will become the source. Twice,
    // because that is the promise dedup rests on.
    const first = await fetch(`${base}/v1/outputs/${outputId}`, {
      headers: { ...bearer(readerKey), accept: 'text/markdown' },
    })
    expect(first.headers.get('content-type')).toContain('text/markdown')
    const doc = await first.text()
    const second = await (
      await fetch(`${base}/v1/outputs/${outputId}`, { headers: { ...bearer(readerKey), accept: 'text/markdown' } })
    ).text()
    expect(second).toBe(doc)
    expect(doc).toContain('How are widget shipments checked?')

    const listed = await fetch(`${base}/v1/spaces/demo/outputs?kind=answer`, { headers: bearer(readerKey) })
    const page = (await listed.json()) as { items: { id: string; markdown: string }[] }
    expect(page.items.map((item) => item.id)).toContain(outputId)
    // Full rows in the list: a page of questions nobody can read without a
    // request per row is a page nobody reads.
    expect(page.items[0]!.markdown.length).toBeGreaterThan(0)
  })

  // ------------------------------------------------------------------ promote
  it('promotion opens an ORDINARY ingest job, and a second promote returns the first one', async () => {
    const res = await fetch(`${base}/v1/outputs/${outputId}/promote`, { method: 'POST', headers: json(writerKey) })
    expect(res.status).toBe(202)
    promotedIngestId = ((await res.json()) as { ingest_id: string }).ingest_id
    expect(res.headers.get('location')).toBe(`/v1/ingests/${promotedIngestId}`)

    // A duplicate click is the same answer with a better shape: the caller
    // lands on the change that already exists rather than on a 409.
    const again = await fetch(`${base}/v1/outputs/${outputId}/promote`, { method: 'POST', headers: json(writerKey) })
    expect(again.status).toBe(202)
    expect(((await again.json()) as { ingest_id: string }).ingest_id).toBe(promotedIngestId)

    const output = (await (await fetch(`${base}/v1/outputs/${outputId}`, { headers: bearer(readerKey) })).json()) as {
      promoted_ingest_id: string
      promoted_at: string
    }
    expect(output.promoted_ingest_id).toBe(promotedIngestId)
    expect(output.promoted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('a reader with only knowledge:read cannot promote — it stages review work', async () => {
    const res = await fetch(`${base}/v1/outputs/${outputId}/promote`, { method: 'POST', headers: json(readerKey) })
    expect(res.status).toBe(403)
  })

  it('the promoted answer stops at the review gate like any other document', async () => {
    const proposalId = await settle(promotedIngestId)

    const staged = (await (
      await fetch(`${base}/v1/proposals/${proposalId}`, { headers: bearer(writerKey) })
    ).json()) as { status: string; concepts: { slug: string }[] }
    expect(staged.status).toBe('pending')
    promotedSlug = staged.concepts[0]!.slug

    // The point of contradicting the video: nothing became knowledge on its own.
    expect(await conceptSlugs()).not.toContain(promotedSlug)

    await approve(proposalId)
    expect(await conceptSlugs()).toContain(promotedSlug)
  })

  it('the archived source carries the derivation marker into wk_sources.metadata', async () => {
    // The marker has to survive enqueue → stored job input → the worker's
    // re-parse → createSource. That hop is exactly why it had to become a field
    // of zIngestInput rather than loose metadata: an unknown key is dropped
    // there, silently, on the one path that needs it.
    const { rows } = await db.query<{ id: string; derived: string | null; markdown: string }>(
      `SELECT id, metadata->>'derived_from_output_id' AS derived, markdown
         FROM wk_sources
        WHERE space_id = $1 AND jsonb_exists(metadata, 'derived_from_output_id')`,
      [spaceId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.derived).toBe(outputId)
    // …and what was archived is the deterministic rendering, verbatim, which is
    // what the grounding guard checked every synthesized quote against.
    const output = (await (
      await fetch(`${base}/v1/outputs/${outputId}`, { headers: bearer(readerKey) })
    ).json()) as Parameters<typeof renderOutputSource>[0]
    expect(rows[0]!.markdown).toBe(renderOutputSource(output))
  })

  // -------------------------------------------------------------------- lint
  it('self-derived-only reports the page whose evidence is the wiki’s own answer', async () => {
    // Every neighbouring rule is silent here, correctly: the source exists and
    // is archived verbatim, the claims quote it with real quotes. This is the
    // one rule that asks where the evidence CAME FROM.
    const findings = await lintSpace(db, spaceId, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
    const finding = findings.findings.find((entry) => entry.rule === 'self-derived-only')
    expect(finding?.concept_slug).toBe(promotedSlug)
    expect(finding?.severity).toBe('warn')
    // The fix names OUTSIDE explicitly — "ingest a source" alone would be read
    // as "promote another answer", which is the state, not the cure.
    expect(finding?.message.default_text).toContain('outside the wiki')
    // The page grounded in a real document is untouched by it.
    expect(await selfDerivedSlugs()).toEqual([promotedSlug])
  })

  it('the finding CLEARS as soon as one outside source backs the same page', async () => {
    // A warning that cannot be cleared is a warning operators switch off. The
    // second document lands on the page the promotion created, so the page now
    // quotes the world as well as itself.
    classifyPlan = () => ({ affected: [promotedSlug], new: [] })
    const { proposal_id } = await ingestAndSettle({ markdown: OUTSIDE_MD, title: 'Widget policy addendum' })
    await approve(proposal_id)
    classifyPlan = null

    expect(await selfDerivedSlugs()).toEqual([])
  })

  it('re-promoting after the source is archived stays free instead of stacking proposals', async () => {
    // The deterministic rendering closes the circle: the same output renders to
    // the same bytes, the same sha256 is already archived, and the promote path
    // answers with the job it opened the first time rather than staging a second
    // proposal for a human to reject.
    const res = await fetch(`${base}/v1/outputs/${outputId}/promote`, { method: 'POST', headers: json(writerKey) })
    expect(res.status).toBe(202)
    expect(((await res.json()) as { ingest_id: string }).ingest_id).toBe(promotedIngestId)

    const { rows } = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM wk_sources WHERE space_id = $1 AND jsonb_exists(metadata, 'derived_from_output_id')`,
      [spaceId],
    )
    expect(rows[0]!.count).toBe(1)
  })
})
