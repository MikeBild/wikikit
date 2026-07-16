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
  // WIKIKIT_SKIP_DOTENV=1 ignores the on-disk .env overrides (not
  // .env.defaults). Ops escape hatch for a stray .env, and what the config
  // tests set so a developer's local .env cannot leak into env-sensitive cases.
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
  /** LLM provider the AI SDK routes to (WIKIKIT_LLM_PROVIDER). */
  readonly llmProvider: 'anthropic' | 'openai' | 'google'
  /** API key for the selected provider (the ANTHROPIC/OPENAI/GOOGLE key). */
  readonly llmApiKey: string
  /** Anthropic API base override (test stubs/proxies); honored when provider=anthropic. */
  readonly anthropicBaseUrl: string
  readonly modelSynthesis: string
  readonly modelClassify: string
  readonly modelAnswer: string
  readonly maxBodyBytes: number
  readonly maxIngestTokens: number
  readonly ingestConcurrency: number
  readonly webhookPollMs: number
  readonly webhookTimeoutMs: number
  readonly webhookMaxAttempts: number
  readonly webhookCircuitThreshold: number
  readonly webhookAllowPrivateTargets: boolean
  readonly trustProxy: boolean
  readonly mcpSessionTtlMs: number
  readonly mcpMaxSessions: number
  readonly logLevel: string
  readonly version: string
  /** True when the selected provider's key is configured — gates ingest/query (503 llm_not_configured otherwise). */
  readonly llmConfigured: boolean
}

const LLM_PROVIDERS = ['anthropic', 'openai', 'google'] as const
type LlmProviderName = (typeof LLM_PROVIDERS)[number]

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

  const config: Config = Object.freeze({
    root: moduleRoot,
    production,
    host: str('HOST', '127.0.0.1'),
    port: integer('PORT', 4060, { min: 1, max: 65535 }),
    publicUrl: str('WIKIKIT_PUBLIC_URL', 'http://127.0.0.1:4060').replace(/\/$/, ''),
    databaseUrl: str('DATABASE_URL'),
    keyPepper: str('WIKIKIT_KEY_PEPPER'),
    bootstrapApiKey: str('WIKIKIT_BOOTSTRAP_API_KEY'),
    llmProvider,
    llmApiKey,
    // Surfaced so the AI SDK anthropic provider (and the e2e stub) can point at
    // a non-default base URL; honored only when provider=anthropic.
    anthropicBaseUrl: str('ANTHROPIC_BASE_URL').replace(/\/$/, ''),
    modelSynthesis: str('WIKIKIT_MODEL_SYNTHESIS', 'claude-sonnet-5'),
    modelClassify: str('WIKIKIT_MODEL_CLASSIFY', 'claude-haiku-4-5'),
    modelAnswer: str('WIKIKIT_MODEL_ANSWER', 'claude-sonnet-5'),
    maxBodyBytes: integer('WIKIKIT_MAX_BODY_BYTES', 10 * 1024 * 1024, { min: 1024, max: 250 * 1024 * 1024 }),
    maxIngestTokens: integer('WIKIKIT_MAX_INGEST_TOKENS', 100_000, { min: 1000, max: 1_000_000 }),
    ingestConcurrency: integer('WIKIKIT_INGEST_CONCURRENCY', 2, { min: 1, max: 16 }),
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
    logLevel: str('LOG_LEVEL', 'info'),
    version: VERSION,
    llmConfigured: llmApiKey.length > 0,
  })

  // Production guards (principle: no boot without secrets). Only
  // the two hard secrets are enforced — everything else has a safe default,
  // and ANTHROPIC_API_KEY is deliberately optional so LLM-free deployments
  // (search/read/lint/export) remain first-class.
  if (production) {
    const required: Record<string, string> = {
      WIKIKIT_KEY_PEPPER: config.keyPepper,
      DATABASE_URL: config.databaseUrl,
    }
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name)
    if (missing.length) throw new Error(`missing production configuration: ${missing.join(', ')}`)
  }

  return config
}
