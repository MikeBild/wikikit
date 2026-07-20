// Response-schema provider contract (plan §14.2): for every ROUTES entry that
// declares a 2xx/3xx response schema, drive a representative request through
// the REAL in-process app (createApp → real router/auth/handlers/domain) and
// validate the actual JSON response against the declared zod schema.
//
// WHY this exists: buildOpenApi derives the spec from those schema NAMES, so
// any generated client / connector import trusts that a
// 200 from /v1/spaces/{space}/concepts/{slug} parses as zConceptResponse. The
// registry alone cannot prove that — only a handler actually producing a
// response can. A handler that adds/renames/drops a field fails HERE, before
// any consumer does.
//
// Unit-level by design (no docker, no network): the database is a stub Db that
// pattern-matches the exact queries the domain modules issue and returns one
// canonical fixture row per table, and the LLM is the deterministic
// FakeProvider. The fixtures are deliberately FULLY populated (claims WITH
// citations, proposals WITH source_ids, ...) so optional-looking fields are
// exercised, not skipped.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, type App } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { createZip } from '../../src/export/zip.ts'
import { ROUTES } from '../../src/http/routes.ts'
import { SCHEMAS } from '../../src/http/schemas.ts'
import { createLogger } from '../../src/logger.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'

// ---------------------------------------------------------------------------
// Fixture identities. zod v4's z.uuid() enforces RFC 4122 version/variant
// nibbles, so every id is a well-formed v4-shaped uuid, not a zero blob.
const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const CONCEPT_ID = '22222222-2222-4222-8222-222222222222'
const REV_ID = '33333333-3333-4333-8333-333333333333'
const CLAIM_ID = '44444444-4444-4444-8444-444444444444'
const SOURCE_ID = '55555555-5555-4555-8555-555555555555'
const PROPOSAL_ID = '66666666-6666-4666-8666-666666666666'
const JOB_ID = '77777777-7777-4777-8777-777777777777'
const ENDPOINT_ID = '88888888-8888-4888-8888-888888888888'
const RUN_ID = '99999999-9999-4999-8999-999999999999'
const KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DELIVERY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const BOOTSTRAP = 'wk_response-schema-contract-bootstrap-key'
const NOW = new Date('2026-07-15T12:00:00Z')
const HEX64 = 'a'.repeat(64)

const SPACE = {
  id: SPACE_ID,
  slug: 'demo',
  name: 'Demo Space',
  settings: {},
  epoch: 7,
  created_at: NOW,
  updated_at: NOW,
}

const SOURCE_ROW = {
  id: SOURCE_ID,
  space_id: SPACE_ID,
  kind: 'markdown' as const,
  url: null,
  title: 'A note',
  content_hash: 'b'.repeat(64),
  raw_content: '# A note\n\nbody',
  markdown: '# A note\n\nbody',
  metadata: {},
  created_at: NOW,
}

const AGENT_META = {
  model: 'claude-sonnet-5',
  prompt_version: 'synthesize.v1',
  input_hash: HEX64,
  usage: { input_tokens: 10, output_tokens: 5 },
  source_ids: [SOURCE_ID],
}

const PROPOSAL_ROW = {
  id: PROPOSAL_ID,
  space_id: SPACE_ID,
  status: 'pending' as const,
  title: 'Update wikikit',
  summary: 'Adds one claim.',
  input_hash: HEX64,
  source_ids: [SOURCE_ID],
  agent_meta: AGENT_META,
  reviewer: null,
  review_note: null,
  reviewed_at: null,
  created_at: NOW,
}

// ---------------------------------------------------------------------------
// Stub Db. select()/insert() dispatch on table + filters; query() dispatches
// on distinctive substrings of the exact SQL the domain modules issue (the
// SQL is part of THIS repo, so a changed query that stops matching simply
// makes the affected case fail loudly — never silently pass).
function stubDb(): Db {
  let generated = 0
  const freshId = (): string => `cccccccc-cccc-4ccc-8ccc-${String(++generated).padStart(12, '0')}`

  const db: Db = {
    async query<R>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }> {
      const rows = ((): unknown[] => {
        // createProposal staging plumbing -----------------------------------
        if (text.includes('id = ANY($2::uuid[])')) {
          // Source-ownership check: every referenced id resolves in-space.
          return ((params?.[1] as string[]) ?? []).map((id) => ({ id }))
        }
        if (text.includes('FROM wk_concepts') && text.includes('FOR UPDATE')) {
          return [{ id: CONCEPT_ID, current_revision_id: null }]
        }
        if (text.startsWith('INSERT INTO wk_concepts')) return [{ id: CONCEPT_ID, current_revision_id: null }]
        if (text.includes('COALESCE(MAX(rev)')) return [{ next: 1 }]
        if (text.startsWith('INSERT INTO wk_relations') || text.startsWith('INSERT INTO wk_decisions')) return []
        if (text.includes('unnest(')) return [] // findContradictions persisted side

        // getProposal (structured diff) -------------------------------------
        if (text.includes('FROM wk_concept_revisions r') && text.includes('r.proposal_id = $1')) {
          return [
            {
              concept_id: CONCEPT_ID,
              slug: 'wikikit',
              markdown: '# WikiKit (new)\n',
              base_revision_id: null,
              old_markdown: null,
            },
          ]
        }
        if (text.includes('FROM wk_claims cl') && text.includes('cl.proposal_id = $1')) {
          return [
            {
              concept_id: CONCEPT_ID,
              subject: 'wikikit',
              predicate: 'is',
              object: 'headless',
              status: 'proposed',
              collides: false,
            },
          ]
        }
        if (text.includes('FROM wk_relations rel') && text.includes('rel.proposal_id = $1')) return []

        // getConcept relations (active only) --------------------------------
        if (text.includes('FROM wk_relations rel') && text.includes("rel.status = 'active'")) {
          return [{ to_slug: 'open-knowledge-format', kind: 'related' }]
        }

        // getConcept (slug-addressed) vs listConcepts (paged) ---------------
        if (text.includes('FROM wk_concepts c') && text.includes('c.slug = $2')) {
          return [
            {
              concept_id: CONCEPT_ID,
              revision_id: REV_ID,
              slug: 'wikikit',
              title: 'WikiKit',
              summary: 'Headless knowledge system.',
              markdown: '# WikiKit\n\nBody.',
              rev: 3,
              updated_at: NOW,
              agent_meta: AGENT_META,
            },
          ]
        }
        if (text.includes('SELECT c.slug, r.title, r.summary\n')) {
          return [{ slug: 'wikikit', title: 'WikiKit', summary: 'Headless knowledge system.' }]
        }
        if (text.includes('FROM wk_concepts c') && text.includes('JOIN wk_concept_revisions r')) {
          return [{ slug: 'wikikit', title: 'WikiKit', summary: 'Headless knowledge system.', rev: 3, updated_at: NOW }]
        }

        // listSources --------------------------------------------------------
        if (text.includes('FROM wk_sources') && text.includes('ORDER BY created_at DESC')) return [SOURCE_ROW]

        // listWebhookDeliveries ----------------------------------------------
        if (text.includes('FROM wk_webhook_deliveries d') && text.includes('SELECT d.id')) {
          return [
            {
              id: DELIVERY_ID,
              event_id: 42,
              event_type: 'wikikit.proposal.created',
              status: 'delivered',
              attempt: 1,
              next_attempt_at: null,
              response_status: 200,
              last_error: null,
              created_at: NOW,
            },
          ]
        }

        // Lint rules and anything else read-only: empty result is valid.
        return []
      })()
      return { rows: rows as R[], rowCount: rows.length }
    },

    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(db) // the stub has no isolation to manage
    },

    async call<R>(fn: string): Promise<R[]> {
      if (fn === 'wk_search') {
        return [
          {
            kind: 'concept',
            concept_slug: 'wikikit',
            claim_id: null,
            title: 'WikiKit',
            headline: '<mark>WikiKit</mark> is a headless knowledge system',
            rank: 0.42,
          },
        ] as R[]
      }
      if (fn === 'wk_apply_proposal') {
        return [
          {
            proposal_id: PROPOSAL_ID,
            status: 'approved',
            concepts: ['wikikit'],
            claims_verified: 1,
            claims_disputed: 0,
          },
        ] as R[]
      }
      if (fn === 'wk_reject_proposal') return [{ proposal_id: PROPOSAL_ID, status: 'rejected' }] as R[]
      throw new Error(`unexpected db.call(${fn})`)
    },

    async emitEvent() {},

    async select<R>(table: string, q: Record<string, unknown> = {}): Promise<R[]> {
      const rows = ((): unknown[] => {
        switch (table) {
          case 'wk_spaces':
            // Only 'demo' exists; anything else is an honest 404.
            if (q.slug !== undefined && q.slug !== `eq.${SPACE.slug}`) return []
            if (q.id !== undefined && q.id !== `eq.${SPACE.id}`) return []
            return [SPACE]
          case 'wk_sources':
            if (q.content_hash !== undefined) return [] // dedup pre-checks: nothing ingested yet
            if (q.id !== undefined) return q.id === `eq.${SOURCE_ID}` ? [SOURCE_ROW] : []
            return [SOURCE_ROW]
          case 'wk_concepts':
            return [{ id: CONCEPT_ID, space_id: SPACE_ID, slug: 'wikikit', current_revision_id: REV_ID }]
          case 'wk_concept_revisions':
            return [
              {
                id: REV_ID,
                rev: 3,
                status: 'current',
                title: 'WikiKit',
                summary: 'Headless knowledge system.',
                base_revision_id: null,
                proposal_id: PROPOSAL_ID,
                agent_meta: AGENT_META,
                created_at: NOW,
              },
            ]
          case 'wk_claims':
            return [
              {
                id: CLAIM_ID,
                subject: 'wikikit',
                predicate: 'is',
                object: 'headless',
                status: 'verified',
                confidence: 0.9,
                valid_from: null,
                valid_until: null,
                created_at: NOW,
                agent_meta: AGENT_META,
              },
            ]
          case 'wk_citations':
            return [{ claim_id: CLAIM_ID, source_id: SOURCE_ID, quote: 'WikiKit is headless.', locator: 'lines 1-2' }]
          case 'wk_change_proposals':
            if (q.input_hash !== undefined) return [] // staging dedup: no pending twin
            return [PROPOSAL_ROW]
          case 'wk_ingest_jobs':
            return [
              {
                id: JOB_ID,
                space_id: SPACE_ID,
                status: 'done',
                proposal_id: PROPOSAL_ID,
                source_id: SOURCE_ID,
                error: null,
              },
            ]
          case 'wk_decisions':
            // A missing slug (getDecision) still returns the row here — the
            // representative case only reads the happy path; visibility rules
            // are covered by the integration suite.
            return [
              {
                slug: 'no-direct-mqtt',
                title: 'No direct MQTT integration',
                status: 'active',
                context: 'Evaluated broker coupling',
                decision: 'Communicate over standard webhooks only',
                rationale: 'Loose coupling wins',
                alternatives: [{ option: 'direct MQTT', reason_rejected: 'tight coupling' }],
                agent_meta: AGENT_META,
                created_at: NOW,
              },
            ]
          case 'wk_webhook_endpoints':
            return [
              {
                id: ENDPOINT_ID,
                space_id: SPACE_ID,
                url: 'https://example.com/hook',
                secret: 'encrypted-at-rest',
                events: ['wikikit.proposal.created'],
                active: true,
                failure_count: 0,
                disabled_until: null,
                created_at: NOW,
              },
            ]
          case 'wk_api_keys':
            return [
              {
                id: KEY_ID,
                name: 'ci-reader',
                scopes: ['knowledge:read'],
                space_id: null,
                created_at: NOW,
                last_used_at: null,
                revoked_at: null,
              },
            ]
          default:
            return []
        }
      })()
      return rows as R[]
    },

    async insert<R>(table: string, body: Record<string, unknown> | Record<string, unknown>[]): Promise<R[]> {
      const first = Array.isArray(body) ? (body[0] ?? {}) : body
      const rows = ((): unknown[] => {
        switch (table) {
          case 'wk_spaces':
            // routes.createSpace serializes settings to a JSON string for pg;
            // echo the parsed object back like the jsonb column would.
            return [
              {
                id: freshId(),
                slug: first.slug,
                name: first.name,
                settings: JSON.parse(String(first.settings ?? '{}')) as Record<string, unknown>,
                epoch: 0,
                created_at: NOW,
                updated_at: NOW,
              },
            ]
          case 'wk_ingest_jobs':
            return [{ id: JOB_ID, ...first }]
          case 'wk_change_proposals':
            return [{ id: PROPOSAL_ID, ...first }]
          case 'wk_claims':
            return [{ id: CLAIM_ID, ...first }]
          case 'wk_agent_runs':
            return [{ id: RUN_ID, ...first }]
          case 'wk_api_keys':
            return [{ id: KEY_ID, ...first }]
          case 'wk_webhook_endpoints':
            return [
              {
                id: ENDPOINT_ID,
                ...first,
                active: true,
                failure_count: 0,
                disabled_until: null,
                created_at: NOW,
              },
            ]
          case 'wk_sources':
            return [{ id: freshId(), ...first, metadata: {}, created_at: NOW }]
          default: {
            const all = Array.isArray(body) ? body : [body]
            return all.map((row) => ({ id: freshId(), ...row }))
          }
        }
      })()
      return rows as R[]
    },

    async update<R>(table: string, _filters: Record<string, unknown>, body: Record<string, unknown>): Promise<R[]> {
      if (table === 'wk_spaces') {
        return [
          {
            ...SPACE,
            settings: JSON.parse(String(body.settings)),
            updated_at: body.updated_at,
          },
        ] as R[]
      }
      return []
    },
    async remove(): Promise<void> {},
  }
  return db
}

function testConfig(): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl: 'postgresql://stub',
    keyPepper: 'response-schema-test-pepper',
    bootstrapApiKey: BOOTSTRAP,
    environment: 'test',
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
    webhookAllowPrivateTargets: true, // lets the webhook case register an http target without DNS
    trustProxy: false,
    mcpSessionTtlMs: 60_000,
    mcpMaxSessions: 10,
    logLevel: 'error',
    version: '0.0.0-contract-test',
    llmConfigured: false,
  }
}

// A real md-format bundle for POST .../import, zipped from the committed
// markdown-tree fixture — the same tree the export/import unit tests parse,
// so this test never invents its own bundle dialect.
function fixtureBundleZip(): Uint8Array {
  const root = fileURLToPath(new URL('../fixtures/markdown-tree/', import.meta.url))
  const entries: { path: string; data: Uint8Array }[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      else entries.push({ path: `${prefix}${entry.name}`, data: readFileSync(join(dir, entry.name)) })
    }
  }
  walk(root, '')
  return createZip(entries)
}

// ---------------------------------------------------------------------------
// The representative request per route. `template` keys back into ROUTES (the
// coverage test below proves this list stays complete as routes are added).
interface RouteCase {
  template: string
  method: 'get' | 'post' | 'delete'
  url: string
  status: number
  body?: unknown
  rawBody?: Uint8Array
  authKey?: string
}

const CASES: RouteCase[] = [
  { template: '/v1/spaces', method: 'get', url: '/v1/spaces', status: 200 },
  { template: '/v1/spaces', method: 'post', url: '/v1/spaces', status: 201, body: { slug: 'fresh', name: 'Fresh' } },
  {
    template: '/v1/agent/briefing',
    method: 'get',
    url: '/v1/agent/briefing?spaces=demo&budget_tokens=500',
    status: 200,
  },
  {
    template: '/v1/agent/context',
    method: 'post',
    url: '/v1/agent/context',
    status: 200,
    body: { prompt: 'unrelated task', max_spaces: 3, budget_tokens: 500 },
  },
  { template: '/v1/spaces/{space}', method: 'get', url: '/v1/spaces/demo', status: 200 },
  {
    template: '/v1/spaces/{space}/settings',
    method: 'post',
    url: '/v1/spaces/demo/settings',
    status: 200,
    body: { settings: { agent_context: { keywords: ['demo'] } } },
  },
  {
    template: '/v1/spaces/{space}/ingest',
    method: 'post',
    url: '/v1/spaces/demo/ingest',
    status: 202,
    body: { markdown: '# a brand-new note\n\nnever seen before' },
  },
  {
    // .txt → text passthrough (no binary parser needed at contract level); the
    // real pdf/docx/xlsx extractors are covered by unit + integration tests.
    template: '/v1/spaces/{space}/ingest/document',
    method: 'post',
    url: '/v1/spaces/demo/ingest/document?filename=notes.txt',
    status: 202,
    rawBody: new TextEncoder().encode('A brand-new document, never seen before.'),
  },
  {
    // FakeProvider.distill returns no learnings — the routine-session shape,
    // and the one that answers without touching the ingest pipeline.
    template: '/v1/spaces/{space}/agent/sessions',
    method: 'post',
    url: '/v1/spaces/demo/agent/sessions',
    status: 200,
    body: { transcript: 'human: fix the typo\nassistant: done' },
  },
  { template: '/v1/ingests/{id}', method: 'get', url: `/v1/ingests/${JOB_ID}`, status: 200 },
  { template: '/v1/spaces/{space}/sources', method: 'get', url: '/v1/spaces/demo/sources', status: 200 },
  {
    template: '/v1/spaces/{space}/sources/{id}',
    method: 'get',
    url: `/v1/spaces/demo/sources/${SOURCE_ID}`,
    status: 200,
  },
  { template: '/v1/spaces/{space}/decisions', method: 'get', url: '/v1/spaces/demo/decisions', status: 200 },
  {
    template: '/v1/spaces/{space}/decisions/{slug}',
    method: 'get',
    url: '/v1/spaces/demo/decisions/no-direct-mqtt',
    status: 200,
  },
  { template: '/v1/spaces/{space}/concepts', method: 'get', url: '/v1/spaces/demo/concepts', status: 200 },
  {
    template: '/v1/spaces/{space}/concepts/{slug}',
    method: 'get',
    url: '/v1/spaces/demo/concepts/wikikit',
    status: 200,
  },
  {
    template: '/v1/spaces/{space}/concepts/{slug}/history',
    method: 'get',
    url: '/v1/spaces/demo/concepts/wikikit/history',
    status: 200,
  },
  { template: '/v1/spaces/{space}/search', method: 'get', url: '/v1/spaces/demo/search?q=wikikit', status: 200 },
  {
    template: '/v1/spaces/{space}/query',
    method: 'post',
    url: '/v1/spaces/demo/query',
    status: 200,
    body: { question: 'What is WikiKit?' },
  },
  { template: '/v1/spaces/{space}/proposals', method: 'get', url: '/v1/spaces/demo/proposals', status: 200 },
  {
    template: '/v1/spaces/{space}/proposals',
    method: 'post',
    url: '/v1/spaces/demo/proposals',
    status: 201,
    body: {
      title: 'Stage a concept',
      input_hash: HEX64,
      source_ids: [SOURCE_ID],
      concepts: [
        {
          slug: 'wikikit',
          title: 'WikiKit',
          markdown: '# WikiKit\n',
          claims: [
            {
              subject: 'wikikit',
              predicate: 'is',
              object: 'headless',
              confidence: 0.9,
              citations: [{ source_id: SOURCE_ID, quote: 'WikiKit is headless.' }],
            },
          ],
          relations: [{ to_slug: 'open-knowledge-format', kind: 'related' }],
        },
      ],
    },
  },
  { template: '/v1/proposals/{id}', method: 'get', url: `/v1/proposals/${PROPOSAL_ID}`, status: 200 },
  { template: '/v1/proposals/{id}/approve', method: 'post', url: `/v1/proposals/${PROPOSAL_ID}/approve`, status: 200 },
  { template: '/v1/proposals/{id}/reject', method: 'post', url: `/v1/proposals/${PROPOSAL_ID}/reject`, status: 200 },
  { template: '/v1/spaces/{space}/lint', method: 'get', url: '/v1/spaces/demo/lint', status: 200 },
  {
    template: '/v1/spaces/{space}/import',
    method: 'post',
    url: '/v1/spaces/demo/import?format=md',
    status: 202,
    rawBody: fixtureBundleZip(),
  },
  { template: '/v1/spaces/{space}/webhooks', method: 'get', url: '/v1/spaces/demo/webhooks', status: 200 },
  {
    template: '/v1/spaces/{space}/webhooks',
    method: 'post',
    url: '/v1/spaces/demo/webhooks',
    status: 201,
    body: { url: 'http://127.0.0.1:9099/hook', events: ['wikikit.proposal.created'] },
  },
  {
    template: '/v1/spaces/{space}/webhooks/{id}/deliveries',
    method: 'get',
    url: `/v1/spaces/demo/webhooks/${ENDPOINT_ID}/deliveries`,
    status: 200,
  },
  {
    template: '/v1/api-keys',
    method: 'get',
    url: '/v1/api-keys',
    status: 200,
  },
  {
    template: '/v1/api-keys',
    method: 'post',
    url: '/v1/api-keys',
    status: 201,
    body: { name: 'ci-reader', scopes: ['knowledge:read'] },
  },
  {
    template: '/v1/api-keys/{id}',
    method: 'delete',
    url: `/v1/api-keys/${KEY_ID}`,
    status: 200,
  },
  ...['ingests', 'knowledge', 'llm', 'webhooks'].map((name) => ({
    template: `/v1/spaces/{space}/stats/${name}`,
    method: 'get' as const,
    url: `/v1/spaces/demo/stats/${name}?bucket=hour&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z`,
    status: 200,
  })),
  { template: '/ready', method: 'get', url: '/ready', status: 200 },
]

// ---------------------------------------------------------------------------

let app: App
let base: string

beforeAll(async () => {
  app = createApp(testConfig(), {
    database: { db: stubDb(), async close() {} },
    llm: createFakeProvider(),
    logger: createLogger({ level: 'error', write: () => {} }),
  })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await app.close()
})

describe('response-schema contract', () => {
  // Completeness guard FIRST: a new route with a declared response schema and
  // no representative case here must fail this suite, otherwise the contract
  // would rot one route at a time.
  test('every ROUTES entry with a 2xx/3xx response schema has a representative case', () => {
    const covered = new Set(CASES.map((c) => `${c.method} ${c.template}`))
    for (const route of ROUTES) {
      const hasSchema = Object.entries(route.responses).some(
        ([status, spec]) => Number(status) < 400 && spec.schema !== undefined,
      )
      if (!hasSchema) continue
      expect(covered.has(`${route.method} ${route.path}`), `${route.method} ${route.path} has no case`).toBe(true)
    }
  })

  for (const c of CASES) {
    test(`${c.method.toUpperCase()} ${c.template} → ${c.status} matches its declared schema`, async () => {
      const route = ROUTES.find((r) => r.method === c.method && r.path === c.template)
      expect(route, `case references unknown route ${c.method} ${c.template}`).toBeDefined()
      const schemaName = route!.responses[c.status]?.schema
      expect(schemaName, `${c.template} declares no schema for ${c.status}`).toBeDefined()
      const schema = SCHEMAS[schemaName!]
      expect(schema, `schema ${schemaName} missing from SCHEMAS`).toBeDefined()

      const res = await fetch(`${base}${c.url}`, {
        method: c.method.toUpperCase(),
        headers: { authorization: `Bearer ${c.authKey ?? BOOTSTRAP}` },
        body: c.rawBody ?? (c.body !== undefined ? JSON.stringify(c.body) : undefined),
      })
      const text = await res.text()
      expect(res.status, `${c.method} ${c.url} answered ${res.status}: ${text.slice(0, 400)}`).toBe(c.status)

      const parsed = schema!.safeParse(JSON.parse(text))
      const issues = parsed.success
        ? ''
        : parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
      expect(parsed.success, `${schemaName} rejected the live response: ${issues}\nbody: ${text.slice(0, 600)}`).toBe(
        true,
      )
    })
  }

  // The 202 ingest ack must also point the poller somewhere real — Location
  // is part of the async-job contract (§5.2), not decoration.
  test('POST .../ingest sets Location: /v1/ingests/{id}', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
      body: JSON.stringify({ markdown: '# another unseen note' }),
    })
    expect(res.status).toBe(202)
    expect(res.headers.get('location')).toBe(`/v1/ingests/${JOB_ID}`)
  })
})
