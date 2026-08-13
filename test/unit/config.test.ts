// Config loader tests: precedence, dev defaults, production guards, freezing.
// Env manipulation is snapshot/restore per test — loadConfig() mutates
// process.env by design (downstream libs read it), so isolation matters.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../../src/config.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'

// Deleted (and restored) per test. Isolation needs BOTH this list and
// WIKIKIT_SKIP_DOTENV below: deleting a name here clears what Bun auto-loaded
// from the developer's .env, and the flag stops loadEnvironment() from reading
// that same file back off disk. Either alone leaks a real ANTHROPIC_API_KEY
// into the precedence/guard cases.
const MANAGED = [
  'WIKIKIT_SKIP_DOTENV',
  'NODE_ENV',
  'HOST',
  'PORT',
  'WIKIKIT_PUBLIC_URL',
  'DATABASE_URL',
  'WIKIKIT_KEY_PEPPER',
  'WIKIKIT_BOOTSTRAP_API_KEY',
  'DEPLOYMENT_ENVIRONMENT',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'WIKIKIT_MODEL_SYNTHESIS',
  'WIKIKIT_MODEL_CLASSIFY',
  'WIKIKIT_MODEL_ANSWER',
  'WIKIKIT_MAX_BODY_BYTES',
  'WIKIKIT_MAX_INGEST_TOKENS',
  'WIKIKIT_INGEST_CONCURRENCY',
  'WIKIKIT_INGEST_LEASE_MS',
  'WIKIKIT_INGEST_HEARTBEAT_MS',
  'WIKIKIT_INGEST_MAX_RUNTIME_MS',
  'WIKIKIT_WEBHOOK_POLL_MS',
  'WIKIKIT_WEBHOOK_TIMEOUT_MS',
  'WIKIKIT_WEBHOOK_MAX_ATTEMPTS',
  'WIKIKIT_WEBHOOK_CIRCUIT_THRESHOLD',
  'WIKIKIT_WEBHOOK_ALLOW_PRIVATE',
  'WIKIKIT_TRUST_PROXY',
  'WIKIKIT_MCP_SESSION_TTL_MS',
  'WIKIKIT_MCP_MAX_SESSIONS',
  'WIKIKIT_MCP_ELICITATION_TIMEOUT_MS',
  'WIKIKIT_USAGE_TELEMETRY_ENABLED',
  'WIKIKIT_USAGE_HMAC_SECRET',
  'WIKIKIT_USAGE_RETENTION_DAYS',
  'WIKIKIT_OAUTH_PROVIDERS',
  'WIKIKIT_OAUTH_ALLOWED_SCOPES',
  'WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS',
  'WIKIKIT_SCAFFOLDING_KINDS',
  'LOG_LEVEL',
]

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

describe('zero-config dev defaults', () => {
  test('boots with sensible defaults and no env at all', () => {
    const config = loadConfig()
    expect(config.port).toBe(4060)
    expect(config.host).toBe('127.0.0.1')
    expect(config.production).toBe(false)
    expect(config.modelSynthesis).toBe('claude-sonnet-5')
    expect(config.modelClassify).toBe('claude-haiku-4-5')
    expect(config.modelAnswer).toBe('claude-sonnet-5')
    // .env.defaults provides a dev database URL and pepper — zero-config boot.
    expect(config.databaseUrl).toContain('postgresql://')
    expect(config.keyPepper.length).toBeGreaterThan(0)
  })

  test('ANTHROPIC_API_KEY has no default; llmConfigured reflects it', () => {
    const without = loadConfig()
    expect(without.llmApiKey).toBe('')
    expect(without.llmConfigured).toBe(false)

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const withKey = loadConfig()
    expect(withKey.llmConfigured).toBe(true)
  })

  test('webhook private targets allowed by default in dev', () => {
    expect(loadConfig().webhookAllowPrivateTargets).toBe(true)
  })

  test('usage telemetry is opt-in with a bounded default retention', () => {
    const config = loadConfig()
    expect(config.usageTelemetryEnabled).toBe(false)
    expect(config.usageRetentionDays).toBe(90)
    expect(config.mcpElicitationTimeoutMs).toBe(300_000)
  })
})

describe('precedence', () => {
  test('process env wins over .env.defaults', () => {
    process.env.PORT = '5099'
    process.env.WIKIKIT_MODEL_SYNTHESIS = 'claude-opus-4-8'
    const config = loadConfig()
    expect(config.port).toBe(5099)
    expect(config.modelSynthesis).toBe('claude-opus-4-8')
  })

  test('trailing slashes are stripped from URLs', () => {
    process.env.WIKIKIT_PUBLIC_URL = 'https://wiki.example.com/'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9999/'
    const config = loadConfig()
    expect(config.publicUrl).toBe('https://wiki.example.com')
    expect(config.anthropicBaseUrl).toBe('http://127.0.0.1:9999')
  })
})

describe('validation', () => {
  test('usage telemetry requires its independent HMAC secret when enabled', () => {
    process.env.WIKIKIT_USAGE_TELEMETRY_ENABLED = 'true'
    expect(() => loadConfig()).toThrow(/WIKIKIT_USAGE_HMAC_SECRET/)
    process.env.WIKIKIT_USAGE_HMAC_SECRET = 'local-only-secret'
    expect(loadConfig().usageTelemetryEnabled).toBe(true)
  })
  test('rejects out-of-range integers', () => {
    process.env.PORT = '99999'
    expect(() => loadConfig()).toThrow(/PORT must be an integer/)
  })

  test('rejects non-numeric integers', () => {
    process.env.WIKIKIT_MAX_BODY_BYTES = 'lots'
    expect(() => loadConfig()).toThrow(/WIKIKIT_MAX_BODY_BYTES/)
  })

  test('bounds the MCP human review window', () => {
    process.env.WIKIKIT_MCP_ELICITATION_TIMEOUT_MS = '45000'
    expect(loadConfig().mcpElicitationTimeoutMs).toBe(45_000)
    process.env.WIKIKIT_MCP_ELICITATION_TIMEOUT_MS = '9999'
    expect(() => loadConfig()).toThrow(/WIKIKIT_MCP_ELICITATION_TIMEOUT_MS/)
  })

  test('requires enough lease headroom for two heartbeat intervals', () => {
    process.env.WIKIKIT_INGEST_LEASE_MS = '10000'
    process.env.WIKIKIT_INGEST_HEARTBEAT_MS = '5000'
    expect(() => loadConfig()).toThrow(/HEARTBEAT_MS must be less than half/)
  })

  test('the ingest runtime ceiling sits well above real work, and is tunable', () => {
    // It bounds a HANG, not slow work: the largest observed production job ran
    // 31 concepts in 31 minutes, one synthesis call each. A ceiling near that
    // would fail ingests that were progressing normally.
    expect(loadConfig().ingestMaxRuntimeMs).toBe(90 * 60 * 1000)
    process.env.WIKIKIT_INGEST_MAX_RUNTIME_MS = '600000'
    expect(loadConfig().ingestMaxRuntimeMs).toBe(600_000)
    process.env.WIKIKIT_INGEST_MAX_RUNTIME_MS = '1000'
    expect(() => loadConfig()).toThrow(/WIKIKIT_INGEST_MAX_RUNTIME_MS/)
  })

  test('bool parsing accepts 1/true/yes/on', () => {
    for (const raw of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.WIKIKIT_TRUST_PROXY = raw
      expect(loadConfig().trustProxy).toBe(true)
    }
    process.env.WIKIKIT_TRUST_PROXY = '0'
    expect(loadConfig().trustProxy).toBe(false)
  })

  test('supports one product-local provider list with API key and OIDC', () => {
    process.env.WIKIKIT_OAUTH_PROVIDERS = JSON.stringify([
      { protocol: 'api_key', id: 'api-key', label: 'WikiKit API key' },
      {
        protocol: 'oidc',
        id: 'workforce-oidc',
        label: 'Workforce OIDC',
        issuer_url: 'https://identity.example.test',
        client_id: 'wikikit',
        allowed_emails: ['mike@example.com'],
      },
    ])
    const concurrent = loadConfig()
    expect(concurrent.oauthProviders?.map((provider) => provider.id)).toEqual(['api-key', 'workforce-oidc'])
    expect(concurrent.oauthProviders?.[1]).toMatchObject({
      protocol: 'oidc',
      issuer: 'https://identity.example.test',
      clientId: 'wikikit',
      allowedEmails: ['mike@example.com'],
      allowedSubjects: [],
    })
  })

  test('accepts a subject-only OIDC allow-list and preserves opaque subject case', () => {
    process.env.WIKIKIT_OAUTH_PROVIDERS = JSON.stringify([
      {
        protocol: 'oidc',
        id: 'workforce-oidc',
        issuer_url: 'https://identity.example.test',
        client_id: 'wikikit',
        allowed_subjects: ['User-ABC', 'User-ABC'],
      },
    ])
    expect(loadConfig().oauthProviders?.[0]).toMatchObject({
      allowedEmails: [],
      allowedSubjects: ['User-ABC'],
    })
  })

  test('rejects an OIDC provider without an explicit email or subject allow-list', () => {
    process.env.WIKIKIT_OAUTH_PROVIDERS = JSON.stringify([
      {
        protocol: 'oidc',
        id: 'workforce-oidc',
        issuer_url: 'https://identity.example.test',
        client_id: 'wikikit',
      },
    ])
    expect(() => loadConfig()).toThrow(/allowed_emails, allowed_subjects, or both/)
  })

  test('rejects the removed provider type discriminator', () => {
    process.env.WIKIKIT_OAUTH_PROVIDERS = '[{"type":"api_key","id":"api-key","label":"WikiKit API key"}]'
    expect(() => loadConfig()).toThrow(/protocol/)
  })
})

/**
 * What an SSO identity may be granted. Three rules, and each one is the whole
 * point of the other two.
 */
describe('the identity scope ceiling', () => {
  function oidc(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify([
      {
        protocol: 'oidc',
        id: 'workforce-oidc',
        issuer_url: 'https://identity.example.test',
        client_id: 'wikikit',
        allowed_emails: ['mike@example.com'],
        ...overrides,
      },
    ])
  }

  test('admin is grantable, because the console has an Installation half', () => {
    // Identities were capped at the knowledge scopes, which cost nothing while
    // WikiKit had no console. With one, an operator signing in through SSO met
    // an interface whose administrative half was simply absent on the
    // installation they own.
    process.env.WIKIKIT_OAUTH_PROVIDERS = oidc({ allowed_scopes: ['knowledge:read', 'admin'] })
    expect(loadConfig().oauthProviders?.[0]).toMatchObject({ allowedScopes: ['knowledge:read', 'admin'] })
  })

  test('admin is grantable globally too, when an operator writes it down', () => {
    process.env.WIKIKIT_OAUTH_ALLOWED_SCOPES = 'knowledge:read,admin'
    expect(loadConfig().oauthAllowedScopes).toEqual(['knowledge:read', 'admin'])
  })

  test('no default ever carries admin — administrative SSO has to be written down', () => {
    // The rule that keeps it opt-in. Without it, a future edit that widened a
    // default would hand administrative SSO to every deployment on upgrade,
    // silently, and nothing would say so.
    delete process.env.WIKIKIT_OAUTH_ALLOWED_SCOPES
    expect(loadConfig().oauthAllowedScopes).toEqual(['knowledge:read', 'knowledge:propose'])

    // And a provider that declares nothing inherits that default, not more.
    process.env.WIKIKIT_OAUTH_PROVIDERS = oidc()
    expect(loadConfig().oauthProviders?.[0]).toMatchObject({
      allowedScopes: ['knowledge:read', 'knowledge:propose'],
    })
  })

  test("'*' is refused, and the message says why", () => {
    // `admin` is an authority somebody can enumerate; `*` is "everything,
    // including whatever is added later" — a grant whose contents are not
    // written anywhere and grow with the product.
    process.env.WIKIKIT_OAUTH_ALLOWED_SCOPES = 'knowledge:read,*'
    expect(() => loadConfig()).toThrow(/may not contain '\*'/)

    delete process.env.WIKIKIT_OAUTH_ALLOWED_SCOPES
    process.env.WIKIKIT_OAUTH_PROVIDERS = oidc({ allowed_scopes: ['*'] })
    expect(() => loadConfig()).toThrow(/unrestricted authority/)
  })

  test('an unknown scope is still refused', () => {
    process.env.WIKIKIT_OAUTH_ALLOWED_SCOPES = 'knowledge:invent'
    expect(() => loadConfig()).toThrow(/comma-separated subset/)
  })

  test('a remote MCP client can never hold admin, however wide the identity is', () => {
    // The safety property that does NOT depend on any of the above:
    // OAUTH_SCOPES has no `admin`, so consent cannot offer it and a token
    // cannot carry it. Asserted here because this is the file where somebody
    // widening the identity ceiling will be reading.
    process.env.WIKIKIT_OAUTH_PROVIDERS = oidc({ allowed_scopes: ['admin'] })
    expect(loadConfig().oauthProviders?.[0]).toMatchObject({ allowedScopes: ['admin'] })
    const server = readFileSync(new URL('../../src/oauth/server.ts', import.meta.url), 'utf8')
    const alphabet = server.match(/const OAUTH_SCOPES = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    expect(alphabet).not.toContain("'admin'")
    expect(alphabet).toContain("'knowledge:approve'")
  })
})

describe('WIKIKIT_SCAFFOLDING_KINDS', () => {
  // Read from the product, so every case below describes whatever this build
  // actually ships rather than a literal that can drift from it.
  const builtIn = BUILT_IN_SCAFFOLDING_KINDS[0]!

  test('the built-in marker is the string it has always been', () => {
    // THE ONE PLACE the value is written twice, deliberately. Everything else
    // reads `BUILT_IN_SCAFFOLDING_KINDS`, which is what stops the parser and the
    // attribution from disagreeing — but a single source is only a guarantee
    // that they MOVE TOGETHER, never that they are still right. Renaming the
    // constant would rename it everywhere consistently and silently, and the
    // installations whose pages carry the old marker would stop having reference
    // targets: their evidence would come back as three zeros and the linter's
    // fault rules would start reporting them.
    //
    // So this test is the second copy, and it is the whole of the pin. Changing
    // the marker is allowed; doing it without noticing is not.
    expect(BUILT_IN_SCAFFOLDING_KINDS).toEqual(['structural-reference'])
  })

  test('unset is the built-in marker and nothing else', () => {
    // This assertion is the inverse of the one it replaces. Two releases
    // shipped a second, deployment-specific marker in the default, and the test
    // here demanded it: one installation's 49 pages reported their evidence as
    // ABSENT only because that marker was recognised, and an empty default
    // would have turned those absences into measured zeros on upgrade. That
    // installation now declares the marker itself, so the default is gone and
    // the product names no deployment. What has to hold from here is that the
    // shipped set is exactly WikiKit's own marker — anything else in it would
    // be a fact about somebody's database creeping back into the product.
    expect(loadConfig().scaffoldingKinds).toEqual([builtIn])
    expect(loadConfig().scaffoldingKindsDeclared).toBe(false)
  })

  test('configured markers are added to the built-in one, and nothing else comes along', () => {
    process.env.WIKIKIT_SCAFFOLDING_KINDS = 'acme-relation-import'
    const kinds = loadConfig().scaffoldingKinds
    expect(kinds).toEqual([builtIn, 'acme-relation-import'])
    expect(loadConfig().scaffoldingKindsDeclared).toBe(true)
  })

  test("'structural-reference' is WikiKit's own and is never configurable away", () => {
    // It is the marker the product itself writes and reads back, so it is not
    // an installation's to withdraw — naming other kinds adds to it, and naming
    // it explicitly does not duplicate it.
    process.env.WIKIKIT_SCAFFOLDING_KINDS = 'acme-relation-import,other-import'
    expect(loadConfig().scaffoldingKinds).toEqual([builtIn, 'acme-relation-import', 'other-import'])

    process.env.WIKIKIT_SCAFFOLDING_KINDS = `acme-relation-import,${builtIn}`
    expect(loadConfig().scaffoldingKinds).toEqual([builtIn, 'acme-relation-import'])
  })

  test('empty and whitespace-only read as "nothing was written", exactly like the neighbouring lists', () => {
    // Same rule WIKIKIT_OAUTH_ALLOWED_SCOPES follows: an operator who leaves the
    // line in the template with no value has not declared an empty set, they
    // have declared nothing. `.env.defaults` ships exactly that empty line.
    // With no fallback left the two readings produce the same list, so
    // `declared` is what still separates them — and it is what the installation
    // report answers "did I set that?" from.
    process.env.WIKIKIT_SCAFFOLDING_KINDS = ''
    expect(loadConfig().scaffoldingKinds).toEqual([builtIn])
    expect(loadConfig().scaffoldingKindsDeclared).toBe(false)

    process.env.WIKIKIT_SCAFFOLDING_KINDS = '   ,  ,'
    expect(loadConfig().scaffoldingKinds).toEqual([builtIn])
    expect(loadConfig().scaffoldingKindsDeclared).toBe(false)

    // Surrounding whitespace on a real entry is trimmed, not treated as part of
    // the marker — the value is compared against a database column.
    process.env.WIKIKIT_SCAFFOLDING_KINDS = ' acme-relation-import , other-import '
    expect(loadConfig().scaffoldingKinds).toEqual([builtIn, 'acme-relation-import', 'other-import'])
  })

  test('a marker that could not survive SQL interpolation fails the boot', () => {
    // These are interpolated into a SQL literal rather than bound. The builder
    // escapes quotes regardless; this is what turns a typo into a refused boot
    // naming the operator's own value, instead of a query that behaves oddly.
    process.env.WIKIKIT_SCAFFOLDING_KINDS = "acme','anything"
    expect(() => loadConfig()).toThrow(/WIKIKIT_SCAFFOLDING_KINDS/)
  })
})

/**
 * How long a browser operator session may live at the very most.
 *
 * The reason this is configuration and not a constant: 0.26.0 made the idle
 * window slide on every authenticated read, so a console tab left VISIBLE on an
 * unattended machine renews itself right up to this ceiling. Detecting whether
 * a human is actually there was considered and rejected — presence inferred
 * from input events is brittle and invasive — which leaves a risk judgement
 * about a room that only the operator can make.
 */
describe('the operator session ceiling', () => {
  const IDLE_MS = 8 * 60 * 60 * 1000

  test('defaults to 24 hours, so no deployment moves on upgrade', () => {
    // The whole point of shipping this as configuration was that nobody's
    // sessions change length until somebody asks. A different default here is a
    // silent behaviour change on every installation at once.
    //
    // Asserted in PRODUCTION mode, which is the only mode that skips
    // .env.defaults. That file restates this number for dev, so the obvious
    // version of this test — delete the variable, call loadConfig() — reads the
    // template straight back in and passes however the code's own default is
    // changed. The guarantee is about a real deployment that configured
    // nothing, and production is where that deployment lives.
    process.env.NODE_ENV = 'production'
    process.env.WIKIKIT_KEY_PEPPER = 'prod-pepper'
    process.env.DATABASE_URL = 'postgresql://prod/wikikit'
    process.env.WIKIKIT_PUBLIC_URL = 'https://wikikit.example.com'
    process.env.WIKIKIT_OAUTH_PROVIDERS = '[{"protocol":"api_key","id":"api-key","label":"WikiKit API key"}]'
    expect(loadConfig().oauthOperatorSessionAbsoluteTtlMs).toBe(24 * 60 * 60 * 1000)
  })

  test('and the shipped templates state the same number, so dev cannot drift from it', () => {
    // .env.defaults is what a dev boot actually loads and .env.example is what
    // an operator copies. Either one carrying a different number would mean two
    // answers to "how long is a session", with the code's answer reachable only
    // in production.
    for (const file of ['.env.defaults', '.env.example']) {
      const template = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
      expect(template, file).toContain(`WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS=${24 * 60 * 60 * 1000}`)
    }
  })

  test('a set value is honoured', () => {
    process.env.WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS = String(12 * 60 * 60 * 1000)
    expect(loadConfig().oauthOperatorSessionAbsoluteTtlMs).toBe(12 * 60 * 60 * 1000)
  })

  test('refuses a ceiling below the idle window, naming both numbers', () => {
    // Below the idle window the session expires before it can ever go idle: the
    // eight-hour limit becomes unreachable and every deadline the operator was
    // told to expect is silently replaced by this one. Refusing at boot with
    // both numbers in the message is the difference between a configuration
    // mistake and a mystery.
    process.env.WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS = String(60 * 60 * 1000)
    expect(() => loadConfig()).toThrow(/WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS/)
    expect(() => loadConfig()).toThrow(new RegExp(`${60 * 60 * 1000} ms`))
    expect(() => loadConfig()).toThrow(new RegExp(`${IDLE_MS} ms idle window`))
  })

  test('exactly the idle window is allowed — a session that never renews is coherent', () => {
    process.env.WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS = String(IDLE_MS)
    expect(loadConfig().oauthOperatorSessionAbsoluteTtlMs).toBe(IDLE_MS)
  })

  test('refuses a ceiling past thirty days, and refuses a value that is not a number', () => {
    // An absolute cap that can be set to a year is not a cap. Thirty days is
    // the default rotating refresh-token lifetime: a browser cookie has no
    // business outliving the longest-lived credential WikiKit mints.
    process.env.WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS = String(31 * 24 * 60 * 60 * 1000)
    expect(() => loadConfig()).toThrow(/WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS must be an integer/)
    // Same treatment every other duration in this file gets for garbage: the
    // boot fails rather than the first request.
    process.env.WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS = 'a day or so'
    expect(() => loadConfig()).toThrow(/WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS must be an integer/)
  })

  test('the idle window this bound is stated against is the one the renewal actually uses', () => {
    // OPERATOR_SESSION_IDLE_MS lives in src/config.ts because the bound above
    // is stated in terms of it; the renewing UPDATE states the same window a
    // second time as a SQL literal, because the console's cadence test reads
    // that statement's source text. Two copies of a number need an assertion
    // holding them together, or the bound quietly starts refusing ceilings that
    // are perfectly reachable.
    const server = readFileSync(new URL('../../src/oauth/server.ts', import.meta.url), 'utf8')
    const hours = /least\(absolute_expires_at, now\(\) \+ interval '(\d+) hours'\)/.exec(server)?.[1]
    expect(hours, 'the renewing UPDATE no longer states its idle window as an hours interval').toBeDefined()
    expect(Number(hours) * 60 * 60 * 1000).toBe(IDLE_MS)
  })
})

describe('production guards', () => {
  test('refuses to boot without WIKIKIT_KEY_PEPPER and DATABASE_URL', () => {
    process.env.NODE_ENV = 'production'
    expect(() => loadConfig()).toThrow(/missing production configuration/)
    expect(() => loadConfig()).toThrow(/WIKIKIT_KEY_PEPPER/)
    expect(() => loadConfig()).toThrow(/DATABASE_URL/)
  })

  test('boots in production when required secrets are set; defaults file is ignored', () => {
    process.env.NODE_ENV = 'production'
    process.env.WIKIKIT_KEY_PEPPER = 'prod-pepper'
    process.env.DATABASE_URL = 'postgresql://prod/wikikit'
    process.env.WIKIKIT_PUBLIC_URL = 'https://wikikit.example.com'
    process.env.WIKIKIT_OAUTH_PROVIDERS = '[{"protocol":"api_key","id":"api-key","label":"WikiKit API key"}]'
    const config = loadConfig()
    expect(config.production).toBe(true)
    expect(config.keyPepper).toBe('prod-pepper')
    // .env.defaults must NOT have leaked the dev pepper/database in.
    expect(config.databaseUrl).toBe('postgresql://prod/wikikit')
    // Private webhook targets are denied by default in production.
    expect(config.webhookAllowPrivateTargets).toBe(false)
  })

  test('ANTHROPIC_API_KEY is NOT required in production (LLM-free deploys)', () => {
    process.env.NODE_ENV = 'production'
    process.env.WIKIKIT_KEY_PEPPER = 'prod-pepper'
    process.env.DATABASE_URL = 'postgresql://prod/wikikit'
    process.env.WIKIKIT_PUBLIC_URL = 'https://wikikit.example.com'
    process.env.WIKIKIT_OAUTH_PROVIDERS = '[{"protocol":"api_key","id":"api-key","label":"WikiKit API key"}]'
    const config = loadConfig()
    expect(config.llmConfigured).toBe(false)
  })
})

describe('shape', () => {
  test('config object is frozen', () => {
    const config = loadConfig()
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('version is a semver-ish string sourced from package.json', () => {
    const config = loadConfig()
    expect(config.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
