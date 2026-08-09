// GET /v1/installation/knowledge-config — the installation reporting its own
// knowledge-shaping configuration.
//
// The defect this route closes is that WIKIKIT_SCAFFOLDING_KINDS decides
// whether a page's evidence is measured or reported as absent, and an operator
// could not learn from their running installation which markers it honours: the
// value is a fact about one database, so the shared documentation cannot print
// it. These tests hold the two properties that make the answer usable —
// PROVENANCE (built-in vs configured) and a CLOSED set of reported fields.
//
// NOTE ON WHAT THIS FILE DOES NOT CONTAIN. No installation's marker is ever
// written here, exactly as in config.test.ts. Every assertion below is about
// SHAPE — how many markers, which one is WikiKit's, how each is attributed —
// plus the requirement that the values BE whatever loadConfig() holds. That
// discipline is why this file needed so little editing on the day the shipped
// deployment-specific default was finally deleted.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { loadConfig } from '../../src/config.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'
import { HANDLERS, ROUTES, type HandlerInput, type HttpDeps } from '../../src/http/routes.ts'
import { SCHEMAS } from '../../src/http/schemas.ts'

const PATH = '/v1/installation/knowledge-config'
const BUILT_IN = BUILT_IN_SCAFFOLDING_KINDS[0]!

interface Report {
  schema_version: string
  version: string
  scaffolding_kinds: {
    env: string
    configured: boolean
    items: { kind: string; origin: string }[]
  }
}

/**
 * Drive the handler with nothing but a config. The other deps are hostile on
 * purpose: this is a report of what the process was configured with, so a
 * version of it that ever reached the database or the LLM would throw here
 * rather than pass quietly.
 */
async function readReport(config: Config): Promise<{ status: number; body: Report }> {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('the configuration report must read nothing but deps.config')
      },
    },
  )
  const deps = { db: forbidden, llm: forbidden, auth: forbidden, config } as unknown as HttpDeps
  const input = { requestId: 'abcdef123456', params: {}, query: {} } as unknown as HandlerInput
  const result = await HANDLERS.knowledgeConfigHandler!(deps, input)
  return result as unknown as { status: number; body: Report }
}

// loadConfig() reads process.env; isolate it the way config.test.ts does, so a
// developer's own .env cannot decide the outcome of a provenance assertion.
const MANAGED = ['WIKIKIT_SKIP_DOTENV', 'WIKIKIT_SCAFFOLDING_KINDS']
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const name of MANAGED) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  process.env.WIKIKIT_SKIP_DOTENV = '1'
})

afterEach(() => {
  for (const name of MANAGED) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const route = () => ROUTES.find((entry) => entry.path === PATH && entry.method === 'get')

// ---------------------------------------------------------------------------
// Scope

describe('the route is administrative', () => {
  test("declares scope 'admin' with no alternative scope", () => {
    // This describes the INSTALLATION, not any one wiki, so it is not
    // space-scoped — and a knowledge:read credential exists to read knowledge,
    // not to enumerate how the installation is configured. Dropping the scope
    // (or widening it through altScopes) must fail here, not in review.
    expect(route(), `${PATH} is not registered`).toBeDefined()
    expect(route()!.scope).toBe('admin')
    expect(route()!.altScopes).toBeUndefined()
  })

  test('no knowledge scope satisfies it', () => {
    // The wire-level 403 `insufficient_scope` for each of these is asserted in
    // test/integration/auth.test.ts against a real server; this is the registry
    // half, which runs without a database.
    const satisfying: readonly (string | null)[] = [route()!.scope, ...(route()!.altScopes ?? [])]
    for (const scope of ['knowledge:read', 'knowledge:propose', 'knowledge:review', 'knowledge:approve']) {
      expect(satisfying, `${scope} must not satisfy ${PATH}`).not.toContain(scope)
    }
  })

  test('the unauthenticated descriptor answers with none of this deployment’s configuration', async () => {
    // The descriptor is unauthenticated and describes the PRODUCT — the same
    // bytes on every deployment of this build. What must never appear there is
    // not the PATH (every admin path is already public in /openapi.json, which
    // is also scope `null`) but the VALUES: the moment the descriptor describes
    // the deployment, every future field of the config report becomes a public
    // field decided by whoever adds it. See the WHAT DOES NOT BELONG HERE note
    // on serviceDescriptorHandler.
    const descriptor = ROUTES.find((entry) => entry.path === '/.well-known/service-descriptor.json')!
    expect(descriptor.scope).toBeNull()

    // A marker no build ships, so finding it in the response can only mean the
    // descriptor started reporting the installation's own configuration.
    const SENTINEL = 'never-in-an-anonymous-response'
    const config = { ...loadConfig(), scaffoldingKinds: [SENTINEL], scaffoldingKindsDeclared: true } as Config
    const result = (await HANDLERS.serviceDescriptorHandler!(
      { config } as unknown as HttpDeps,
      {} as unknown as HandlerInput,
    )) as { body: Record<string, unknown> }

    const serialized = JSON.stringify(result.body)
    expect(serialized).not.toContain(SENTINEL)
    expect(serialized).not.toContain('scaffolding')
    // Fixed product-level keys, so a configuration field cannot be added to the
    // anonymous surface without turning this red first.
    expect(Object.keys(result.body).sort()).toEqual(['artifacts', 'capabilities', 'service', 'version'])
  })
})

// ---------------------------------------------------------------------------
// Provenance

describe('effective values and where each came from', () => {
  test("nothing configured: WikiKit's own marker, alone and attributed", async () => {
    const config = loadConfig()
    const { status, body } = await readReport(config)

    expect(status).toBe(200)
    expect(body.schema_version).toBe('wikikit.knowledge-config.v1')
    expect(body.scaffolding_kinds.env).toBe('WIKIKIT_SCAFFOLDING_KINDS')
    // Nothing was written, and the report says so — the operator's "did I set
    // that?" answered without them comparing the list against a default they
    // cannot see. It stays worth reporting now that the list can no longer
    // imply it: an installation that declared exactly the built-in marker
    // produces these identical items.
    expect(body.scaffolding_kinds.configured).toBe(false)

    // Until this release the answer here was two items, the second attributed
    // `fallback`: WikiKit shipped one deployment's historical import marker as
    // a default so an upgrade would not silently un-recognise that
    // installation's pages. That installation declares the marker itself now,
    // the default is deleted, and `fallback` is gone from the schema with it —
    // so a shipped build honours WikiKit's own marker and nothing else.
    expect(body.scaffolding_kinds.items).toEqual([{ kind: BUILT_IN, origin: 'built_in' }])
    expect(body.scaffolding_kinds.items.map((item) => item.kind)).toEqual([...config.scaffoldingKinds!])
  })

  test('the retired third origin is no longer a value the schema will carry', async () => {
    // `origin` lost a value this release: `fallback` described the
    // deployment-specific marker WikiKit shipped as a default, and with that
    // default deleted it can never be produced. Asserted against the schema
    // because that is the promise clients read — a handler still emitting it
    // would now fail response validation on the one route an operator reaches
    // for when something looks wrong.
    process.env.WIKIKIT_SCAFFOLDING_KINDS = 'acme-relation-import'
    const schema = SCHEMAS.zKnowledgeConfigResponse!
    const { body } = await readReport(loadConfig())
    expect(schema.safeParse(body).success).toBe(true)
    const retired = {
      ...body,
      scaffolding_kinds: {
        ...body.scaffolding_kinds,
        items: body.scaffolding_kinds.items.map((item) => ({ ...item, origin: 'fallback' })),
      },
    }
    expect(schema.safeParse(retired).success).toBe(false)
  })

  test('configured: the operator values are attributed to the operator, the built-in stays built-in', async () => {
    process.env.WIKIKIT_SCAFFOLDING_KINDS = 'acme-relation-import, acme-legacy-stub'
    const config = loadConfig()
    const { body } = await readReport(config)

    expect(body.scaffolding_kinds.configured).toBe(true)
    expect(body.scaffolding_kinds.items).toEqual([
      { kind: BUILT_IN, origin: 'built_in' },
      { kind: 'acme-relation-import', origin: 'configured' },
      { kind: 'acme-legacy-stub', origin: 'configured' },
    ])
    expect(body.scaffolding_kinds.items.map((item) => item.kind)).toEqual([...config.scaffoldingKinds!])
  })

  test('configuring exactly the built-in still reports that the variable was written', async () => {
    // The case a flat list cannot express: the effective markers are
    // indistinguishable from an installation that configured nothing, and only
    // `configured` separates them.
    process.env.WIKIKIT_SCAFFOLDING_KINDS = BUILT_IN
    const { body } = await readReport(loadConfig())

    expect(body.scaffolding_kinds.items).toEqual([{ kind: BUILT_IN, origin: 'built_in' }])
    expect(body.scaffolding_kinds.configured).toBe(true)
  })

  test('a config carrying no markers reports what the reads then actually use', async () => {
    // Config.scaffoldingKinds is optional and the domain reads default to the
    // built-in set when it is absent. The report must agree with the behaviour
    // it describes rather than claim the installation recognises nothing.
    const { body } = await readReport({ version: '0.0.0-test' } as Config)
    expect(body.scaffolding_kinds.items).toEqual([{ kind: BUILT_IN, origin: 'built_in' }])
    expect(body.scaffolding_kinds.configured).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// What may ever be reported

describe('the reported field set is closed', () => {
  /**
   * The allowlist IS the rule (stated in full on zKnowledgeConfigResponse in
   * src/http/schemas.ts): a value may be reported only if it is
   * knowledge-shaping AND is not a secret, key material, a connection string,
   * or anything DERIVED from one — a length, a prefix, a fingerprint, a hash,
   * and a plain is-it-set boolean all being derived.
   *
   * Asserted against the ACTUAL response keys and not only against the schema,
   * because the schema is what a contributor edits in the same commit as the
   * field. Adding a leaky field turns this red and forces the rule to be read
   * before it is broken.
   */
  const ALLOWED_TOP_LEVEL = ['schema_version', 'scaffolding_kinds', 'version']
  const ALLOWED_SCAFFOLDING = ['configured', 'env', 'items']
  const ALLOWED_ITEM = ['kind', 'origin']

  test('the response carries exactly the allowlisted keys, at every level', async () => {
    const { body } = await readReport(loadConfig())
    expect(Object.keys(body).sort()).toEqual([...ALLOWED_TOP_LEVEL].sort())
    expect(Object.keys(body.scaffolding_kinds).sort()).toEqual([...ALLOWED_SCAFFOLDING].sort())
    expect(body.scaffolding_kinds.items.length).toBeGreaterThan(0)
    for (const item of body.scaffolding_kinds.items) {
      expect(Object.keys(item).sort()).toEqual([...ALLOWED_ITEM].sort())
    }
  })

  test('no secret-bearing config field reaches the response, whatever the config holds', async () => {
    // Every secret in the config is a marked, findable string here: if any of
    // them — or any value spread out of the config wholesale — reaches the
    // body, the serialized response carries the marker.
    const SECRET = 'MUST-NOT-APPEAR-IN-A-CONFIG-REPORT'
    const config = {
      ...loadConfig(),
      keyPepper: `pepper-${SECRET}`,
      bootstrapApiKey: `wk_${SECRET}`,
      databaseUrl: `postgresql://user:${SECRET}@db.internal:5432/wikikit`,
      llmApiKey: `sk-${SECRET}`,
      embeddingApiKey: `sk-${SECRET}`,
      usageHmacSecret: `hmac-${SECRET}`,
    } as unknown as Config

    const serialized = JSON.stringify((await readReport(config)).body)
    expect(serialized).not.toContain(SECRET)
    // Not merely absent as a substring — nothing shaped like key material or a
    // connection string is reported at all, which is what the key allowlist
    // above is there to keep true.
    expect(serialized).not.toContain('postgresql://')
    expect(serialized).not.toContain('sk-')
  })

  test('the response schema is strict, so an undeclared field cannot ride along', async () => {
    const schema = SCHEMAS.zKnowledgeConfigResponse!
    const { body } = await readReport(loadConfig())
    expect(schema.safeParse(body).success).toBe(true)
    expect(schema.safeParse({ ...body, llm_api_key: 'sk-leak' }).success).toBe(false)
    expect(
      schema.safeParse({
        ...body,
        scaffolding_kinds: { ...body.scaffolding_kinds, database_url: 'postgresql://leak' },
      }).success,
    ).toBe(false)
  })
})
