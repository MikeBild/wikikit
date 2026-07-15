// ROUTES registry integrity — the local half of the drift-test contract (§8):
// handlers ↔ registry set-equal, every schema name resolves, the binding §5.2
// route table is complete and unchanged.
import { describe, expect, test } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { ForbiddenError } from '../../src/domain/errors.ts'
import type { Principal } from '../../src/http/auth.ts'
import { HANDLERS, ROUTES, type HandlerInput, type HttpDeps } from '../../src/http/routes.ts'
import { SCHEMAS } from '../../src/http/schemas.ts'

// The §5.2 binding table (method + path + scope). Editing this list is a
// deliberate API change: update CONTRACTS.md first, then this pin.
const CONTRACT_TABLE: [string, string, string | null][] = [
  ['post', '/v1/spaces', 'admin'],
  ['get', '/v1/spaces/{space}', 'knowledge:read'],
  ['post', '/v1/spaces/{space}/ingest', 'knowledge:propose'],
  ['get', '/v1/ingests/{id}', 'knowledge:propose'],
  ['get', '/v1/spaces/{space}/sources', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/sources/{id}', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/decisions', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/decisions/{slug}', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/concepts', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/concepts/{slug}', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/concepts/{slug}/history', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/search', 'knowledge:read'],
  ['post', '/v1/spaces/{space}/query', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/proposals', 'knowledge:read'],
  ['post', '/v1/spaces/{space}/proposals', 'knowledge:propose'],
  ['get', '/v1/proposals/{id}', 'knowledge:read'],
  ['post', '/v1/proposals/{id}/approve', 'knowledge:approve'],
  ['post', '/v1/proposals/{id}/reject', 'knowledge:approve'],
  ['get', '/v1/spaces/{space}/lint', 'knowledge:read'],
  ['get', '/v1/spaces/{space}/export', 'knowledge:read'],
  ['post', '/v1/spaces/{space}/import', 'knowledge:propose'],
  ['get', '/v1/spaces/{space}/webhooks', 'admin'],
  ['post', '/v1/spaces/{space}/webhooks', 'admin'],
  ['get', '/v1/spaces/{space}/webhooks/{id}/deliveries', 'admin'],
  ['post', '/v1/api-keys', 'admin'],
  ['get', '/health', null],
  ['get', '/ready', null],
  ['get', '/metrics', null],
  ['get', '/openapi.json', null],
  ['get', '/llms.txt', null],
  ['get', '/llms-full.txt', null],
]

describe('ROUTES registry', () => {
  test('matches the binding §5.2 contract table exactly (method, path, scope)', () => {
    const actual = ROUTES.map((r) => [r.method, r.path, r.scope]).sort()
    expect(actual).toEqual([...CONTRACT_TABLE].sort() as never)
  })

  test('method+path pairs are unique', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('handler names ↔ HANDLERS are set-equal (no orphans either way)', () => {
    const declared = new Set(ROUTES.map((r) => r.handler))
    const implemented = new Set(Object.keys(HANDLERS))
    expect([...declared].sort()).toEqual([...implemented].sort())
  })

  test('every referenced schema name resolves in SCHEMAS', () => {
    for (const route of ROUTES) {
      for (const name of [route.request?.params, route.request?.query, route.request?.body]) {
        if (name) expect(SCHEMAS[name], `${route.method} ${route.path} request ${name}`).toBeDefined()
      }
      for (const [status, spec] of Object.entries(route.responses)) {
        if (spec.schema) {
          expect(SCHEMAS[spec.schema], `${route.method} ${route.path} ${status} ${spec.schema}`).toBeDefined()
        }
      }
    }
  })

  test('every route declares at least one 2xx/3xx response and a summary', () => {
    for (const route of ROUTES) {
      expect(route.summary.length, route.path).toBeGreaterThan(10)
      expect(
        Object.keys(route.responses).some((status) => Number(status) >= 200 && Number(status) < 400),
        route.path,
      ).toBe(true)
    }
  })

  test('path templates only bind params the schemas know about', () => {
    for (const route of ROUTES) {
      const templateParams = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)
      if (!templateParams.length) continue
      expect(route.request?.params, `${route.path} has params but declares no schema`).toBeDefined()
      const schema = SCHEMAS[route.request!.params!]!
      const parsed = schema.safeParse(Object.fromEntries(templateParams.map((p) => [p, 'not-valid-anything'])))
      // We only assert the schema CONSUMES the same param names — a parse
      // failure on dummy values is fine, unknown-key failures are not.
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          expect(issue.code).not.toBe('unrecognized_keys')
        }
      }
    }
  })

  test('ingest is the only 202+Location producer among spaces POSTs; import answers 202 too', () => {
    const ingest = ROUTES.find((r) => r.handler === 'createIngestHandler')!
    expect(ingest.responses[202]).toBeDefined()
    const imp = ROUTES.find((r) => r.handler === 'importHandler')!
    expect(imp.responses[202]).toBeDefined()
    expect(imp.rawBody).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Handler behavior (no socket): the §5.2 space-binding guard on space
// creation and RFC 9110 If-None-Match semantics on the concepts list.

interface Call {
  sql: string
  values: unknown[]
}

function fakeDb(routes: { match: RegExp; rows: Record<string, unknown>[] }[]) {
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

const SPACE_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'demo',
  name: 'Demo',
  settings: {},
  epoch: 7,
  created_at: new Date('2026-07-01T00:00:00Z'),
  updated_at: new Date('2026-07-01T00:00:00Z'),
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return { keyId: 'key-1', scopes: ['*'], spaceId: null, name: 'test', ...overrides }
}

function handlerInput(overrides: Partial<HandlerInput> = {}): HandlerInput {
  return {
    requestId: 'abcdef123456',
    principal: principal(),
    params: {},
    query: {},
    body: undefined,
    req: { headers: {} } as IncomingMessage,
    res: { writeHead() {}, end() {} } as unknown as ServerResponse,
    ...overrides,
  }
}

function handlerDeps(db: unknown): HttpDeps {
  return {
    db,
    auth: { requireScope: () => {} },
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as HttpDeps
}

describe('createSpaceHandler — space-binding guard (§5.2)', () => {
  test('a space-scoped admin key cannot create spaces (403, nothing written)', async () => {
    const { db, calls } = fakeDb([])
    const input = handlerInput({
      principal: principal({ spaceId: SPACE_ROW.id, scopes: ['admin'] }),
      body: { slug: 'new-space', name: 'New Space' },
    })
    await expect(HANDLERS.createSpaceHandler!(handlerDeps(db), input)).rejects.toBeInstanceOf(ForbiddenError)
    expect(calls.length).toBe(0)
  })

  test('a global admin key creates spaces normally', async () => {
    const { db } = fakeDb([{ match: /INSERT INTO "public"\."wk_spaces"/, rows: [SPACE_ROW] }])
    const input = handlerInput({ body: { slug: 'demo', name: 'Demo' } })
    const result = await HANDLERS.createSpaceHandler!(handlerDeps(db), input)
    expect(result!.status).toBe(201)
  })
})

describe('listConceptsHandler — If-None-Match (RFC 9110 list semantics)', () => {
  function conceptsDb() {
    return fakeDb([
      { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [SPACE_ROW] },
      { match: /JOIN wk_concept_revisions r/, rows: [] },
    ])
  }

  async function run(inm: string | undefined): Promise<{ status: number | null; result: unknown }> {
    const { db } = conceptsDb()
    let status: number | null = null
    const res = {
      writeHead(code: number) {
        status = code
      },
      end() {},
    } as unknown as ServerResponse
    const input = handlerInput({
      params: { space: 'demo' },
      req: { headers: inm === undefined ? {} : { 'if-none-match': inm } } as never,
      res,
    })
    const result = await HANDLERS.listConceptsHandler!(handlerDeps(db), input)
    return { status, result }
  }

  test('single matching etag → 304', async () => {
    expect((await run('"7"')).status).toBe(304)
  })

  test('comma-separated list containing the current epoch → 304', async () => {
    expect((await run('"4", "7"')).status).toBe(304)
  })

  test('weak validators are stripped per entry', async () => {
    expect((await run('W/"4", W/"7"')).status).toBe(304)
  })

  test('* matches any current representation → 304', async () => {
    expect((await run('*')).status).toBe(304)
  })

  test('no match (or no header) → 200 with the ETag set', async () => {
    const miss = await run('"3", "4"')
    expect(miss.status).toBeNull()
    expect((miss.result as { status: number; headers: Record<string, string> }).status).toBe(200)
    expect((miss.result as { headers: Record<string, string> }).headers.etag).toBe('"7"')
    const bare = await run(undefined)
    expect((bare.result as { status: number }).status).toBe(200)
  })
})
