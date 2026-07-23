// Environment loader.
//
// Precedence (highest wins):
//   1. real process environment (external env always wins — deploys set it)
//   2. .env                     (local overrides, git-ignored)
//   3. .env.defaults            (committed dev defaults — NEVER read in production)
//
// WHY this exact order: production must be fully explicit — .env.defaults is
// skipped when NODE_ENV=production so a stray dev database URL or dev pepper
// can never leak into a real deployment. Conversely dev is zero-config:
// `bun run dev` boots against the committed defaults without any setup.
//
// WHY the loader mutates process.env instead of returning a map: downstream
// libraries (pg, @anthropic-ai/sdk with ANTHROPIC_BASE_URL/API_KEY) read
// process.env directly; loading into a private map would silently bypass them.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.ts'

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readDotEnv(path: string): Record<string, string> {
  const values: Record<string, string> = {}
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*?)\s*$/)
      if (!match) continue
      let value = match[2]!
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      values[match[1]!] = value
    }
  } catch {
    // Missing file is the normal case (.env is optional; .env.defaults absent
    // inside the compiled binary). Best-effort by design.
  }
  return values
}

// WHY cwd-then-moduleRoot: in dev both are the repo root. In the compiled
// binary import.meta.url points into the virtual bunfs where no .env exists,
// so the operator's working directory is the only sensible location.
function resolveEnvFile(name: string): string | undefined {
  for (const dir of [process.cwd(), moduleRoot]) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function loadEnvironment(): void {
  const external = new Set(Object.keys(process.env))
  // Test-harness internal, deliberately undocumented: the config tests delete
  // the vars they drive out of process.env, and this stops the layering pass
  // below from reading a developer's .env straight back in. NOT an ops switch —
  // Bun auto-loads a neighbouring .env before we run (compiled binary too), so
  // it cannot keep a stray file out anyway; remove the file for that.
  const skipDotEnv = process.env.WIKIKIT_SKIP_DOTENV === '1'
  const envPath = skipDotEnv ? undefined : resolveEnvFile('.env')
  const overrides = envPath ? readDotEnv(envPath) : {}
  const production = (process.env.NODE_ENV ?? overrides.NODE_ENV) === 'production'
  if (!production) {
    const defaultsPath = resolveEnvFile('.env.defaults')
    if (defaultsPath) {
      for (const [name, value] of Object.entries(readDotEnv(defaultsPath))) {
        if (process.env[name] === undefined) process.env[name] = value
      }
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    // .env never overrides an externally-set variable (external Set snapshot
    // taken before defaults were applied) — deploy env always wins.
    if (!external.has(name)) process.env[name] = value
  }
}

function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

function integer(name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) {
    // Fail the boot, not the request: a mistyped limit should never produce a
    // half-configured server.
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

export interface Config {
  readonly root: string
  readonly production: boolean
  readonly host: string
  readonly port: number
  readonly publicUrl: string
  readonly databaseUrl: string
  readonly keyPepper: string
  readonly bootstrapApiKey: string
  /** Deployment identity used in structured telemetry. */
  readonly environment?: string
  /** LLM provider the AI SDK routes to (WIKIKIT_LLM_PROVIDER). */
  readonly llmProvider: 'anthropic' | 'openai' | 'google'
  /** API key for the selected provider (the ANTHROPIC/OPENAI/GOOGLE key). */
  readonly llmApiKey: string
  /** Env var name holding the selected provider's key — so a 503 names the key the operator must actually set. */
  readonly llmApiKeyEnv: string
  /** Anthropic API base override (test stubs/proxies); honored when provider=anthropic. */
  readonly anthropicBaseUrl: string
  readonly modelSynthesis: string
  readonly modelClassify: string
  readonly modelAnswer: string
  readonly maxBodyBytes: number
  readonly maxIngestTokens: number
  readonly ingestConcurrency: number
  /** Duration of an ingest worker lease before another worker may reap it. */
  readonly ingestLeaseMs: number
  /** Cadence at which a live worker extends its ingest lease. */
  readonly ingestHeartbeatMs: number
  readonly webhookPollMs: number
  readonly webhookTimeoutMs: number
  readonly webhookMaxAttempts: number
  readonly webhookCircuitThreshold: number
  readonly webhookAllowPrivateTargets: boolean
  readonly trustProxy: boolean
  readonly mcpSessionTtlMs: number
  readonly mcpMaxSessions: number
  /** Maximum time a synchronous native MCP review form may remain open. */
  readonly mcpElicitationTimeoutMs?: number
  /** Privacy-bounded, product-local usage ledger; disabled unless explicitly enabled. */
  readonly usageTelemetryEnabled?: boolean
  /** Secret used only for product-local actor/session HMACs; required when telemetry is enabled. */
  readonly usageHmacSecret?: string
  /** Raw event retention; aggregate report artifacts may live longer downstream. */
  readonly usageRetentionDays?: number
  /** OAuth authorization-code lifetime; optional on injected test configs. */
  readonly oauthAuthorizationCodeTtlMs?: number
  /** OAuth access-token lifetime; optional on injected test configs. */
  readonly oauthAccessTokenTtlMs?: number
  /** OAuth refresh-token lifetime; optional on injected test configs. */
  readonly oauthRefreshTokenTtlMs?: number
  /** Allow RFC 7591 dynamic client registration for remote MCP clients. */
  readonly oauthDynamicRegistrationEnabled?: boolean
  /** Provider-neutral browser login definitions exposed by the MCP OAuth flow. */
  readonly oauthProviders?: OAuthProviderConfig[]
  /** Maximum permissions that an interactive identity can receive. */
  readonly oauthAllowedScopes?: Array<'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve'>
  readonly logLevel: string
  readonly version: string
  /** True when the selected provider's key is configured — gates ingest/query (503 llm_not_configured otherwise). */
  readonly llmConfigured: boolean
}

const LLM_PROVIDERS = ['anthropic', 'openai', 'google'] as const
type LlmProviderName = (typeof LLM_PROVIDERS)[number]

export interface ApiKeyOAuthProviderConfig {
  readonly protocol: 'api_key'
  readonly id: string
  readonly label: string
}

export interface OidcProviderConfig {
  readonly protocol: 'oidc'
  readonly id: string
  readonly label: string
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret?: string
  readonly scopes: string
  readonly allowedEmails: string[]
  readonly allowedSubjects: string[]
  readonly allowedScopes: Array<'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve'>
}

export type OAuthProviderConfig = ApiKeyOAuthProviderConfig | OidcProviderConfig

const IDENTITY_SCOPES = ['knowledge:read', 'knowledge:propose', 'knowledge:review', 'knowledge:approve'] as const
type IdentityScope = (typeof IDENTITY_SCOPES)[number]

function parseIdentityScopes(raw: string, name: string, fallback: IdentityScope[]): IdentityScope[] {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const scopes = values.length ? values : fallback
  if (!scopes.length || scopes.some((scope) => !(IDENTITY_SCOPES as readonly string[]).includes(scope))) {
    throw new Error(`${name} must be a comma-separated subset of ${IDENTITY_SCOPES.join(', ')}`)
  }
  return [...new Set(scopes)] as IdentityScope[]
}

function parseOAuthProviders(raw: string, globalScopes: IdentityScope[]): OAuthProviderConfig[] {
  if (!raw.trim()) return [{ protocol: 'api_key', id: 'api-key', label: 'WikiKit API key' }]
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('WIKIKIT_OAUTH_PROVIDERS must be valid JSON')
  }
  if (!Array.isArray(parsed) || !parsed.length)
    throw new Error('WIKIKIT_OAUTH_PROVIDERS must be a non-empty JSON array')
  const ids = new Set<string>()
  let apiKeyConfigured = false
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`WIKIKIT_OAUTH_PROVIDERS[${index}] must be an object`)
    }
    const item = value as Record<string, unknown>
    const protocol = typeof item.protocol === 'string' ? item.protocol.trim() : ''
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id
    if (!['api_key', 'oidc'].includes(protocol)) {
      throw new Error(`WIKIKIT_OAUTH_PROVIDERS[${index}].protocol must be api_key or oidc`)
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) || ids.has(id) || !label || label.length > 120) {
      throw new Error(`WIKIKIT_OAUTH_PROVIDERS[${index}] has an invalid or duplicate id or label`)
    }
    ids.add(id)
    if (protocol === 'api_key') {
      if (apiKeyConfigured) throw new Error('WIKIKIT_OAUTH_PROVIDERS may contain only one api_key provider')
      apiKeyConfigured = true
      return { protocol, id, label }
    }

    const emails = Array.isArray(item.allowed_emails)
      ? item.allowed_emails
          .filter((email): email is string => typeof email === 'string')
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean)
      : []
    const subjects = Array.isArray(item.allowed_subjects)
      ? item.allowed_subjects
          .filter((subject): subject is string => typeof subject === 'string')
          .map((subject) => subject.trim())
          .filter(Boolean)
      : []
    const scopes = Array.isArray(item.allowed_scopes)
      ? parseIdentityScopes(
          item.allowed_scopes.join(','),
          `WIKIKIT_OAUTH_PROVIDERS[${index}].allowed_scopes`,
          globalScopes,
        )
      : globalScopes
    if (!emails.length && !subjects.length) {
      throw new Error(`WIKIKIT_OAUTH_PROVIDERS[${index}] must configure allowed_emails, allowed_subjects, or both`)
    }

    const issuer = typeof item.issuer_url === 'string' ? item.issuer_url.trim().replace(/\/$/, '') : ''
    const clientId = typeof item.client_id === 'string' ? item.client_id.trim() : ''
    let issuerUrl: URL
    try {
      issuerUrl = new URL(issuer)
    } catch {
      throw new Error(`WIKIKIT_OAUTH_PROVIDERS[${index}].issuer_url must be an HTTPS URL`)
    }
    if (issuerUrl.protocol !== 'https:' || !clientId) {
      throw new Error(`WIKIKIT_OAUTH_PROVIDERS[${index}] OIDC issuer_url and client_id are required`)
    }
    const requestedScopes =
      typeof item.scopes === 'string' && item.scopes.trim() ? item.scopes.trim() : 'openid profile email'
    if (!requestedScopes.split(/\s+/).includes('openid')) {
      throw new Error(`WIKIKIT_OAUTH_PROVIDERS[${index}].scopes must include openid`)
    }
    return {
      protocol: 'oidc',
      id,
      label,
      issuer: issuerUrl.toString().replace(/\/$/, ''),
      clientId,
      clientSecret: typeof item.client_secret === 'string' && item.client_secret ? item.client_secret : undefined,
      scopes: requestedScopes,
      allowedEmails: [...new Set(emails)],
      allowedSubjects: [...new Set(subjects)],
      allowedScopes: scopes,
    }
  })
}

/**
 * Which env var holds each provider's key. Exported because the 503
 * llm_not_configured path must name the key for the SELECTED provider — a
 * deployment on WIKIKIT_LLM_PROVIDER=openai told to "set ANTHROPIC_API_KEY"
 * is being sent to fix the wrong thing.
 *
 * Kept in sync with the str() literals below by the docs-drift test — the
 * literals must stay literal, they are what the test scans for.
 */
export const LLM_PROVIDER_KEY_ENV: Record<LlmProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

export function loadConfig(): Config {
  loadEnvironment()
  const production = process.env.NODE_ENV === 'production'

  // Provider selection (WIKIKIT_LLM_PROVIDER) → which key gates the LLM. A
  // mistyped provider fails the boot, not the first request.
  const llmProvider = str('WIKIKIT_LLM_PROVIDER', 'anthropic') as LlmProviderName
  if (!LLM_PROVIDERS.includes(llmProvider)) {
    throw new Error(`WIKIKIT_LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(', ')}`)
  }
  // Read all three key vars with literals (the drift test scans these) — the
  // selected provider's key gates the LLM features.
  const providerKeys: Record<LlmProviderName, string> = {
    anthropic: str('ANTHROPIC_API_KEY'),
    openai: str('OPENAI_API_KEY'),
    google: str('GOOGLE_GENERATIVE_AI_API_KEY'),
  }
  const llmApiKey = providerKeys[llmProvider]

  const ingestLeaseMs = integer('WIKIKIT_INGEST_LEASE_MS', 15 * 60 * 1000, { min: 10_000, max: 24 * 3600 * 1000 })
  const ingestHeartbeatMs = integer('WIKIKIT_INGEST_HEARTBEAT_MS', 30_000, { min: 1000, max: 3600 * 1000 })
  if (ingestHeartbeatMs * 2 >= ingestLeaseMs) {
    throw new Error('WIKIKIT_INGEST_HEARTBEAT_MS must be less than half of WIKIKIT_INGEST_LEASE_MS')
  }
  const oauthAllowedScopes = parseIdentityScopes(str('WIKIKIT_OAUTH_ALLOWED_SCOPES'), 'WIKIKIT_OAUTH_ALLOWED_SCOPES', [
    'knowledge:read',
    'knowledge:propose',
  ])
  const oauthProviders = parseOAuthProviders(str('WIKIKIT_OAUTH_PROVIDERS'), oauthAllowedScopes)

  const config: Config = Object.freeze({
    root: moduleRoot,
    production,
    host: str('HOST', '127.0.0.1'),
    port: integer('PORT', 4060, { min: 1, max: 65535 }),
    publicUrl: str('WIKIKIT_PUBLIC_URL', 'http://127.0.0.1:4060').replace(/\/$/, ''),
    databaseUrl: str('DATABASE_URL'),
    keyPepper: str('WIKIKIT_KEY_PEPPER'),
    bootstrapApiKey: str('WIKIKIT_BOOTSTRAP_API_KEY'),
    environment: str('DEPLOYMENT_ENVIRONMENT', production ? 'production' : 'development'),
    llmProvider,
    llmApiKey,
    llmApiKeyEnv: LLM_PROVIDER_KEY_ENV[llmProvider],
    // Surfaced so the AI SDK anthropic provider (and the e2e stub) can point at
    // a non-default base URL; honored only when provider=anthropic.
    anthropicBaseUrl: str('ANTHROPIC_BASE_URL').replace(/\/$/, ''),
    modelSynthesis: str('WIKIKIT_MODEL_SYNTHESIS', 'claude-sonnet-5'),
    modelClassify: str('WIKIKIT_MODEL_CLASSIFY', 'claude-haiku-4-5'),
    modelAnswer: str('WIKIKIT_MODEL_ANSWER', 'claude-sonnet-5'),
    maxBodyBytes: integer('WIKIKIT_MAX_BODY_BYTES', 10 * 1024 * 1024, { min: 1024, max: 250 * 1024 * 1024 }),
    maxIngestTokens: integer('WIKIKIT_MAX_INGEST_TOKENS', 100_000, { min: 1000, max: 1_000_000 }),
    ingestConcurrency: integer('WIKIKIT_INGEST_CONCURRENCY', 2, { min: 1, max: 16 }),
    ingestLeaseMs,
    ingestHeartbeatMs,
    webhookPollMs: integer('WIKIKIT_WEBHOOK_POLL_MS', 5000, { min: 250, max: 300_000 }),
    webhookTimeoutMs: integer('WIKIKIT_WEBHOOK_TIMEOUT_MS', 10_000, { min: 1000, max: 60_000 }),
    webhookMaxAttempts: integer('WIKIKIT_WEBHOOK_MAX_ATTEMPTS', 10, { min: 1, max: 20 }),
    webhookCircuitThreshold: integer('WIKIKIT_WEBHOOK_CIRCUIT_THRESHOLD', 5, { min: 1, max: 100 }),
    // Private/loopback webhook targets are an SSRF vector in production but
    // essential in dev (deliver to localhost stubs).
    webhookAllowPrivateTargets: bool('WIKIKIT_WEBHOOK_ALLOW_PRIVATE', !production),
    trustProxy: bool('WIKIKIT_TRUST_PROXY', false),
    mcpSessionTtlMs: integer('WIKIKIT_MCP_SESSION_TTL_MS', 30 * 60 * 1000, { min: 10_000, max: 24 * 3600 * 1000 }),
    mcpMaxSessions: integer('WIKIKIT_MCP_MAX_SESSIONS', 200, { min: 1, max: 10_000 }),
    mcpElicitationTimeoutMs: integer('WIKIKIT_MCP_ELICITATION_TIMEOUT_MS', 5 * 60 * 1000, {
      min: 10_000,
      max: 30 * 60 * 1000,
    }),
    usageTelemetryEnabled: bool('WIKIKIT_USAGE_TELEMETRY_ENABLED', false),
    usageHmacSecret: str('WIKIKIT_USAGE_HMAC_SECRET'),
    usageRetentionDays: integer('WIKIKIT_USAGE_RETENTION_DAYS', 90, { min: 31, max: 365 }),
    oauthAuthorizationCodeTtlMs: integer('WIKIKIT_OAUTH_CODE_TTL_MS', 10 * 60 * 1000, {
      min: 60_000,
      max: 15 * 60 * 1000,
    }),
    oauthAccessTokenTtlMs: integer('WIKIKIT_OAUTH_ACCESS_TOKEN_TTL_MS', 60 * 60 * 1000, {
      min: 5 * 60 * 1000,
      max: 24 * 60 * 60 * 1000,
    }),
    oauthRefreshTokenTtlMs: integer('WIKIKIT_OAUTH_REFRESH_TOKEN_TTL_MS', 30 * 24 * 60 * 60 * 1000, {
      min: 60 * 60 * 1000,
      max: 90 * 24 * 60 * 60 * 1000,
    }),
    oauthDynamicRegistrationEnabled: bool('WIKIKIT_OAUTH_DCR_ENABLED', true),
    oauthProviders,
    oauthAllowedScopes,
    logLevel: str('LOG_LEVEL', 'info'),
    version: VERSION,
    llmConfigured: llmApiKey.length > 0,
  })

  if (config.usageTelemetryEnabled && !config.usageHmacSecret) {
    throw new Error('WIKIKIT_USAGE_HMAC_SECRET is required when usage telemetry is enabled')
  }

  // Production guards (principle: no boot without secrets). Only
  // the two hard secrets are enforced — everything else has a safe default,
  // and the provider API key is deliberately optional so LLM-free deployments
  // (search/read/lint/export) remain first-class.
  if (production) {
    const required: Record<string, string> = {
      WIKIKIT_KEY_PEPPER: config.keyPepper,
      DATABASE_URL: config.databaseUrl,
      WIKIKIT_OAUTH_PROVIDERS: process.env.WIKIKIT_OAUTH_PROVIDERS ?? '',
    }
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name)
    if (missing.length) throw new Error(`missing production configuration: ${missing.join(', ')}`)
    if (new URL(config.publicUrl).protocol !== 'https:') {
      throw new Error('WIKIKIT_PUBLIC_URL must use https in production (OAuth redirect and issuer security)')
    }
  }

  return config
}
