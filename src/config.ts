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
import { BUILT_IN_SCAFFOLDING_KINDS } from './domain/concepts.ts'
import { parseDefaultBriefing } from './schedule.ts'
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

export interface ModelPrice {
  /** USD per one million measured tokens. */
  readonly input: number
  readonly output: number
  readonly cache_read: number
}

export type ModelPrices = Readonly<Record<string, ModelPrice>>

export function parseModelPrices(raw: string): ModelPrices {
  if (!raw.trim()) return Object.freeze({})
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('WIKIKIT_MODEL_PRICES must be a JSON object')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WIKIKIT_MODEL_PRICES must be a JSON object')
  }
  const prices: Record<string, ModelPrice> = {}
  for (const [model, value] of Object.entries(parsed)) {
    if (!model.trim() || value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`WIKIKIT_MODEL_PRICES.${model || '(empty)'} must be an object`)
    }
    const rate = value as Record<string, unknown>
    const keys = Object.keys(rate)
    if (keys.length !== 3 || !['input', 'output', 'cache_read'].every((key) => keys.includes(key))) {
      throw new Error(`WIKIKIT_MODEL_PRICES.${model} must contain exactly input, output and cache_read`)
    }
    for (const key of keys) {
      if (!['input', 'output', 'cache_read'].includes(key)) {
        throw new Error(`WIKIKIT_MODEL_PRICES.${model}.${key} is not supported`)
      }
      if (typeof rate[key] !== 'number' || !Number.isFinite(rate[key]) || Number(rate[key]) < 0) {
        throw new Error(`WIKIKIT_MODEL_PRICES.${model}.${key} must be a finite non-negative number`)
      }
    }
    prices[model] = { input: Number(rate.input), output: Number(rate.output), cache_read: Number(rate.cache_read) }
  }
  return Object.freeze(prices)
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
  /** Configured USD rates per million measured tokens; an absent model stays explicitly unpriced. */
  readonly modelPrices?: ModelPrices
  /** Global evidence budget for one grounded answer. */
  readonly answerTokenBudget?: number
  readonly maxBodyBytes: number
  readonly maxIngestTokens: number
  readonly ingestConcurrency: number
  /** Duration of an ingest worker lease before another worker may reap it. */
  readonly ingestLeaseMs: number
  /** Cadence at which a live worker extends its ingest lease. */
  readonly ingestHeartbeatMs: number
  /**
   * Wall-clock ceiling for ONE ingest job. The lease answers "is a worker
   * alive"; a live worker renews it forever, so a job hung inside an LLM call
   * had no bound at all. This is that bound.
   */
  readonly ingestMaxRuntimeMs: number
  /**
   * How many ingest jobs one space may have WAITING (queued or parked on a
   * provider quota) before enqueue refuses with 429 `ingest_queue_full` — see
   * IngestQueueFullError for what the number protects.
   *
   * Optional only because every unit test builds a Config by hand (the same
   * reason `usageRetentionDays` is optional), and NOT because an installation may
   * run without a ceiling: the reader falls back to the shared
   * DEFAULT_INGEST_MAX_QUEUED_PER_SPACE below rather than to "no cap", so an
   * absent field cannot quietly remove the guard.
   */
  readonly ingestMaxQueuedPerSpace?: number
  /**
   * How long an UNPROMOTED output (an answer, a briefing, a health report) is
   * kept before the hourly sweep collects it; 0 keeps them forever. Promoted
   * outputs are never collected — their text lives on as an archived source and
   * the row is the link back to the answer it came from.
   *
   * Optional for the same reason as the field above, with the same treatment: the
   * sweeper falls back to DEFAULT_OUTPUT_RETENTION_DAYS, never to "unbounded".
   */
  readonly outputRetentionDays?: number
  /**
   * How long an archived source stays in the RETRIEVAL INDEX (wk_source_chunks)
   * before the hourly sweep drops its chunks; 0 keeps every source indexed
   * forever. The archived bytes are never touched — wk_sources is verbatim and
   * forever — so a swept source can be re-indexed at any time.
   *
   * Optional like the two fields above, but the fallback is INVERTED: an absent
   * field means "indexed forever", not the shipped number. There is no shipped
   * number to fall back to — DEFAULT_SOURCE_INDEX_DAYS is 0 — because narrowing
   * what a wiki can find is an operator's decision, and a default that silently
   * made evidence unfindable would be the one kind of default this product
   * cannot ship.
   */
  readonly sourceIndexDays?: number
  /**
   * Whether the in-process schedule worker claims due briefing/health runs.
   * Default true, and an absent value counts as true: a wiki nobody has given a
   * schedule to has no due rows, so the loop is a cheap poll, and an operator who
   * wants the reports has to configure a schedule either way. Turning it off is
   * for the deployment that wants exactly one of several binaries producing
   * reports — although it does not need to: the claim is
   * `FOR UPDATE SKIP LOCKED`, so N instances already produce one per window.
   */
  readonly schedulerEnabled?: boolean
  /**
   * The briefing a newly created wiki is armed with (`WIKIKIT_DEFAULT_BRIEFING`),
   * already parsed; null means seed nothing.
   *
   * Parsed at boot rather than at space creation so a typo refuses to start the
   * binary instead of surfacing weeks later as a report that fires at a time
   * nobody chose — and so the value can never be half-valid on one code path.
   */
  readonly defaultBriefing?: { at_time: string; timezone: string } | null
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
  /** Opt-in: store stemmed lexemes (never text) of unanswered questions for coverage-gap topics. */
  readonly coverageGapTopicsEnabled?: boolean
  /** OAuth authorization-code lifetime; optional on injected test configs. */
  readonly oauthAuthorizationCodeTtlMs?: number
  /** OAuth access-token lifetime; optional on injected test configs. */
  readonly oauthAccessTokenTtlMs?: number
  /** OAuth refresh-token lifetime; optional on injected test configs. */
  readonly oauthRefreshTokenTtlMs?: number
  /**
   * Absolute deadline stamped on a browser operator session at login: the
   * moment it ends however continuously somebody has been using it. Optional on
   * injected test configs, where the mint falls back to the same 24 hours this
   * loader defaults to.
   */
  readonly oauthOperatorSessionAbsoluteTtlMs?: number
  /** Allow RFC 7591 dynamic client registration for remote MCP clients. */
  readonly oauthDynamicRegistrationEnabled?: boolean
  /** Provider-neutral browser login definitions exposed by the MCP OAuth flow. */
  readonly oauthProviders?: OAuthProviderConfig[]
  /** Maximum permissions that an interactive identity can receive. */
  readonly oauthAllowedScopes?: Array<
    'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve' | 'admin'
  >
  /**
   * Positively named signup switch (WIKIKIT_OAUTH_ENABLE_SIGNUP, default
   * false): when true, an unknown OIDC identity that authenticates at the
   * SSO callback is auto-admitted and registered with the MINIMAL
   * knowledge:read ceiling. When false, unknown identities are rejected
   * exactly as before. Allowlist entries and already-registered identities
   * are unaffected — the switch governs only unknown identities.
   */
  readonly oauthSignupEnabled?: boolean
  readonly logLevel: string
  readonly version: string
  /** True when the selected provider's key is configured — gates ingest/query (503 llm_not_configured otherwise). */
  readonly llmConfigured: boolean
  /**
   * Embedding provider for the OPTIONAL hybrid retrieval ranker. 'none'
   * (default) keeps retrieval purely lexical — embeddings only ever ADD a
   * ranker, they never gate a feature (search must not 503). Anthropic has
   * no embeddings API, so this is independent of WIKIKIT_LLM_PROVIDER.
   */
  readonly embeddingProvider?: 'none' | 'openai' | 'google'
  readonly modelEmbedding?: string
  /** The embedding provider's API key ('' when provider is 'none'). */
  readonly embeddingApiKey?: string
  /** Env var name for the embedding key — the fail-fast/error messages name it. */
  readonly embeddingApiKeyEnv?: string
  /** True when embeddingProvider is set and its key is present — starts the embedder worker. */
  readonly embeddingConfigured?: boolean
  /**
   * Revision kinds (`agent_meta->>'kind'`) whose pages are structural
   * scaffolding rather than knowledge — see WIKIKIT_SCAFFOLDING_KINDS below.
   * Always contains WikiKit's own `structural-reference`.
   *
   * REQUIRED, unlike most of the optional fields above, and it is the first
   * link in the chain that makes forgetting these markers a type error rather
   * than a convention (ScaffoldingOptions in src/domain/concepts.ts is the
   * second). The reads take `readonly string[]`, so a boundary that forwards
   * `deps.config.scaffoldingKinds` only compiles while this field cannot be
   * undefined — the moment it becomes optional again, every forward is a type
   * error and the compiler says so at the boundary rather than a default
   * quietly answering for the installation. The parse always produces a value
   * (WikiKit's own marker at minimum), so requiring it costs nothing true.
   */
  readonly scaffoldingKinds: readonly string[]
  /**
   * True when the operator WROTE WIKIKIT_SCAFFOLDING_KINDS, false when nothing
   * was written and the built-in marker stands alone. `scaffoldingKinds` alone
   * cannot say which: an installation that configured exactly the built-in
   * marker produces the identical list to one that configured nothing at all.
   *
   * It exists because the report at GET /v1/installation/knowledge-config has
   * to answer "did I set that, or did it come with the product" — the first
   * question an operator asks about an unexpected value — and only the parse
   * knows.
   *
   * Required for the same reason as the list beside it: the two come out of one
   * parse, and an optional boolean read as `=== true` is a default wearing a
   * comparison — an absent value would report "you configured nothing" about an
   * installation nobody asked.
   */
  readonly scaffoldingKindsDeclared: boolean
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
  readonly allowedScopes: Array<
    'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve' | 'admin'
  >
}

export type OAuthProviderConfig = ApiKeyOAuthProviderConfig | OidcProviderConfig

/**
 * What an SSO identity may be granted.
 *
 * `admin` is in this list and `*` is not, and the difference is the whole
 * decision.
 *
 * It was not always here. Identities were capped at the knowledge scopes on the
 * reasoning that an identity provider should not be a path to administration —
 * which cost nothing while WikiKit had no console, because administration was
 * curl with a key either way. The cockpit changed that: an operator who signs
 * in through SSO meets an interface whose Installation half is simply absent,
 * on the installation they own. A product whose own interface is mostly
 * forbidden to the person who signed into it is not secure, it is broken.
 *
 * So `admin` is reachable — but only through an EXPLICIT declaration, never
 * through a default (see below). A deployment that declares it is making a
 * trade it should say out loud: an account takeover at the identity provider
 * then reaches credential management, with no second factor anywhere in
 * WikiKit's own chain. That is defensible when the provider enforces MFA and
 * the allowlist is short — the shape a self-hosted installation usually has —
 * and indefensible otherwise. WikiKit cannot tell which one it is in, so it
 * takes the operator's word.
 *
 * `*` stays refused, and the distinction from `admin` is not squeamishness:
 * `admin` is an authority somebody can enumerate, and what it reaches today it
 * reaches tomorrow. `*` is "everything, including whatever is added later" — a
 * grant whose contents are not written anywhere and grow with the product.
 * That belongs to a key somebody minted on the host with a shell, where the act
 * itself is the record.
 *
 * Note what does NOT change: `OAUTH_SCOPES` in src/oauth/server.ts has no
 * `admin`, so a remote MCP client can never request or hold it however wide the
 * identity behind the consent is.
 */
const IDENTITY_SCOPES = [
  'knowledge:read',
  'knowledge:propose',
  'knowledge:review',
  'knowledge:approve',
  'admin',
] as const
type IdentityScope = (typeof IDENTITY_SCOPES)[number]

/**
 * `declared` separates "the operator wrote this" from "nothing was written, so
 * here is the fallback" — which is what keeps `admin` opt-in. Without it, a
 * future edit that starts feeding a wider default through here would grant
 * administrative SSO to every deployment on upgrade, silently.
 */
function parseIdentityScopes(raw: string, name: string, fallback: IdentityScope[]): IdentityScope[] {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const declared = values.length > 0
  const scopes = declared ? values : fallback
  if (!scopes.length) {
    throw new Error(`${name} must be a comma-separated subset of ${IDENTITY_SCOPES.join(', ')}`)
  }
  for (const scope of scopes) {
    if (scope === '*') {
      throw new Error(`${name} may not contain '*' — an SSO identity cannot hold unrestricted authority`)
    }
    if (!(IDENTITY_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(`${name} must be a comma-separated subset of ${IDENTITY_SCOPES.join(', ')}`)
    }
    if (scope === 'admin' && !declared) {
      throw new Error(`${name} may not default to 'admin' — administrative SSO has to be written down`)
    }
  }
  return [...new Set(scopes)] as IdentityScope[]
}

/**
 * The idle window of a browser operator session: how long a session survives
 * with nobody using it. Eight hours, and NOT configurable — the console renews
 * on a cadence deliberately chosen to sit well inside it (apps/cockpit's
 * session gate), so moving this number is a code change that has to move that
 * one in the same commit.
 *
 * It is declared in this file, and spent in src/oauth/server.ts, because the
 * bound on WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS below is stated in
 * terms of it. A validation that retyped `8 * 60 * 60 * 1000` would keep
 * passing after somebody shortened the window and would then be refusing
 * ceilings that are perfectly reachable — the one failure a bound like that
 * exists to prevent.
 *
 * The renewing UPDATE states the same window a second time, as the SQL literal
 * `interval '8 hours'`, and deliberately keeps it a literal: the console's
 * cadence test reads that statement's source text to learn the deadline it is
 * racing, and a template expression there would leave it with nothing to read.
 * The two copies are held together by an assertion in test/unit/config.test.ts
 * rather than by a shared expression.
 */
export const OPERATOR_SESSION_IDLE_MS = 8 * 60 * 60 * 1000

/**
 * The absolute ceiling a session gets when nobody configured one — the shipped
 * 24 hours, unchanged since it was a constant in src/oauth/server.ts.
 *
 * It is a named export for the same reason the idle window above is, and the
 * reason is worth stating because the two cases differ. `oauthOperatorSessionAbsoluteTtlMs`
 * is optional on the Config interface (every unit test injects a Config by
 * hand), so the mint has to say what an absent field means — and if it said it
 * by retyping `24 * 60 * 60 * 1000`, this file's default and that one would be
 * two independent numbers held together only by two tests that pin them
 * separately. Somebody moving the shipped default would see the config test go
 * red, fix the number here, and ship a build whose loader says one thing and
 * whose mint says another for every caller that omits the field. One constant,
 * spent in both places, is the only version of this that cannot drift.
 */
export const OPERATOR_SESSION_ABSOLUTE_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000

/**
 * The shipped ingest queue ceiling, spent BOTH by the loader default below and by
 * the reader (assertQueueHasRoom in src/ingest/pipeline.ts) when the field is
 * absent — a named constant for the reason the session ceiling above is one: two
 * independently typed numbers would let a build whose loader says 200 refuse at
 * some other figure, and the field is optional precisely so hand-built Configs
 * exist to hit that path.
 *
 * 200 waiting jobs is roughly a working week of review at a rate a human
 * sustains: high enough that an ordinary bulk drop (a folder, a vault export)
 * goes straight through, low enough that a misconfigured automatic feeder is
 * stopped while somebody can still read the queue.
 */
export const DEFAULT_INGEST_MAX_QUEUED_PER_SPACE = 200

/**
 * The shipped output retention window, spent by the loader default and by the
 * hourly sweeper in src/app.ts when the field is absent — same argument as above.
 * A year: long enough that "what did we ask last quarter" is answerable, bounded
 * so a busy /query surface does not grow a table forever.
 */
export const DEFAULT_OUTPUT_RETENTION_DAYS = 365

/**
 * The shipped source INDEX window, spent by the loader default and by the hourly
 * sweeper in src/app.ts when the field is absent — the same named-constant
 * argument as the two above, with the opposite value.
 *
 * 0, and 0 means indexed forever: the feature is off until an operator asks for
 * it. Outputs default to a year because an output is regenerable; a source is
 * evidence somebody archived on purpose, and a window that started running the
 * day a wiki was upgraded would take material out of retrieval that nobody
 * chose to lose. An operator who sets a number has decided which of their
 * evidence stays findable.
 */
export const DEFAULT_SOURCE_INDEX_DAYS = 0

/**
 * What a new wiki's briefing is armed with unless the operator says otherwise.
 *
 * Seven in the morning, UTC. The hour is dull on purpose — a suggested time
 * somebody has to think about is a form they close — and the zone is UTC because
 * the server has no other zone to know; shipping the author's zone would be
 * wrong for every other deployment, and silently. `off` disables the seed.
 */
export const DEFAULT_BRIEFING_AT = '07:00'

/**
 * The revision kinds an installation stamps on pages that are STRUCTURE rather
 * than knowledge — the rows an import creates so a reviewed relation has
 * somewhere to land. WikiKit declines to measure such a page's evidence and its
 * linter suppresses fault reports about it (src/domain/concepts.ts holds that
 * reasoning); this is only the question of which markers say so.
 *
 * `structural-reference` is WikiKit's own name for the shape — the product
 * writes that revision and the product reads it back — so it is not
 * configurable, it is prepended unconditionally below. Everything else is a fact
 * about ONE database: the tag whoever ran an import happened to choose. A
 * product that claims to know nothing about where it runs cannot hold a list of
 * those, so they belong here, in the environment, where the installation that
 * knows them declares them.
 *
 * WHY there is no second default any more, and why the absence is the point.
 * For two releases this constant had a sibling: one deployment's historical
 * import marker, applied whenever the variable was unset. It was not a purity
 * failure at the time — 49 pages across 5 wikis on that installation reported
 * their evidence as ABSENT (the honest answer for a page that holds no
 * knowledge) only because that marker was recognised, and shipping an empty
 * default would have turned those absences into `{claims: 0, uncited_claims:
 * 0, sources: 0}` on upgrade: a measured zero, which is the sentence "this page
 * rests on nothing", said about pages that rest on nothing BY DESIGN.
 *
 * That installation now declares the marker itself — verified against the
 * running instance, whose GET /v1/installation/knowledge-config reports it with
 * origin `configured` rather than `fallback`. The fallback therefore protects
 * nobody, and it was the last place in this repository where the product named
 * a particular deployment. A knowledge base that claims to know nothing about
 * where it runs cannot ship one installation's import history as a constant a
 * day longer than it has to.
 *
 * The consequence for anyone else still relying on it is real and worth saying
 * plainly: with WIKIKIT_SCAFFOLDING_KINDS unset, pages carrying that marker
 * stop being reference targets — their evidence comes back as three zeros and
 * the linter's fault rules start reporting them. The repair is one line of
 * configuration, which is exactly what this variable is for.
 */
// Imported rather than retyped. The domain owns what a scaffolding marker IS —
// it is the layer that reads the column and decides the row is furniture — and
// this file owns only how an operator adds to that set. A second literal here
// would be a second answer to "what does this build ship with": the parser would
// honour one marker and `BUILT_IN_SCAFFOLDING_KINDS` would attribute another,
// each pinned by its own test, so moving it would redden one suite and ship a
// build disagreeing with itself. That is the exact shape of the duplicated
// session ceiling 0.31.0 removed, and it is not worth repeating for the sake of
// keeping this module import-free.
//
// The direction is safe: src/domain/concepts.ts imports nothing from here, by
// design — it receives the markers as an argument rather than reading config.

/**
 * Same shape as parseIdentityScopes above — split on commas, trim, drop empties,
 * and read "nothing was written" (unset OR empty OR all-whitespace) as no
 * declaration rather than as an empty list.
 *
 * Validated because these strings are interpolated into SQL literals, not bound
 * as parameters (the fragment they build is a module-level string, and the kinds
 * are a small closed set the planner benefits from seeing literally). The
 * builder in domain/concepts.ts escapes quotes regardless; this is what turns a
 * typo into a refused boot with the operator's own value in the message instead
 * of a query that behaves oddly at runtime.
 *
 * `declared` is carried out the same way parseIdentityScopes carries it, and it
 * survives the deletion of the fallback because the merged list still cannot
 * answer the question: an installation that declared exactly the built-in
 * marker produces the identical array to one that declared nothing. The reads
 * do not care; the operator asking why a page is measured the way it is cares
 * about nothing else, and only the parse knows.
 */
function parseScaffoldingKinds(raw: string, name: string): { kinds: readonly string[]; declared: boolean } {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  for (const kind of values) {
    if (!/^[a-z0-9][a-z0-9._-]{0,126}$/i.test(kind)) {
      throw new Error(`${name} entries must be alphanumeric revision-kind markers ('.', '_' and '-' allowed): ${kind}`)
    }
  }
  return { kinds: [...new Set([...BUILT_IN_SCAFFOLDING_KINDS, ...values])], declared: values.length > 0 }
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

/**
 * Which provider a model id names, or undefined when the id has a shape this
 * build does not recognise.
 *
 * A heuristic, and the asymmetry is deliberate: a recognised FOREIGN id refuses
 * the boot, an unrecognised id passes. WikiKit ships as a binary an operator
 * runs for months, so a guard holding a list of valid model names would reject
 * the first id released after the build — costing more boots than the mismatch
 * it prevents. This catches an obvious mismatch; it is not a model registry and
 * it never rules on whether a model exists.
 *
 * Anchored at the start of the id so a namespaced routing id (`anthropic.claude-…`,
 * a gateway prefix) reads as unrecognised rather than as a claim about a
 * provider WikiKit does not itself route to.
 */
const MODEL_ID_PROVIDERS: readonly (readonly [RegExp, LlmProviderName])[] = [
  [/^claude-/i, 'anthropic'],
  [/^(gpt-|o[0-9])/i, 'openai'],
  [/^gemini-/i, 'google'],
]

function providerNamedByModelId(model: string): LlmProviderName | undefined {
  const id = model.trim()
  return MODEL_ID_PROVIDERS.find(([shape]) => shape.test(id))?.[1]
}

/**
 * Model ids do not carry across providers: the selected provider 404s an id
 * belonging to another one. Nothing before this made that a boot failure, so
 * the mistake was accepted by config, reported healthy by /ready, and paid for
 * by the first caller whose request had already been accepted.
 *
 * Only settings whose model is actually READ are checked — an unused default
 * must not refuse a boot for a call that will never be made.
 */
function requireModelMatchesProvider(
  setting: string,
  model: string,
  provider: LlmProviderName,
  providerSetting: string,
): void {
  const named = providerNamedByModelId(model)
  if (named === undefined || named === provider) return
  throw new Error(
    `${setting}=${model} is a model id for ${named}, but ${providerSetting}=${provider} — set ${setting} to a model id for ${provider}, or set ${providerSetting}=${named}`,
  )
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

  // The three call kinds each name their own model, and each is read on a live
  // request — so each is checked against the selected provider at boot.
  const modelSynthesis = str('WIKIKIT_MODEL_SYNTHESIS', 'claude-sonnet-5')
  const modelClassify = str('WIKIKIT_MODEL_CLASSIFY', 'claude-haiku-4-5')
  const modelAnswer = str('WIKIKIT_MODEL_ANSWER', 'claude-sonnet-5')
  for (const [setting, model] of [
    ['WIKIKIT_MODEL_SYNTHESIS', modelSynthesis],
    ['WIKIKIT_MODEL_CLASSIFY', modelClassify],
    ['WIKIKIT_MODEL_ANSWER', modelAnswer],
  ] as const) {
    requireModelMatchesProvider(setting, model, llmProvider, 'WIKIKIT_LLM_PROVIDER')
  }

  // Embedding provider (hybrid retrieval ranker). Separate knob from the LLM
  // provider: anthropic cannot embed, and lexical-only deployments are
  // first-class ('none' default). A named provider without its key fails the
  // boot — a half-configured ranker would silently never embed anything.
  const EMBEDDING_PROVIDERS = ['none', 'openai', 'google'] as const
  const embeddingProvider = str('WIKIKIT_EMBEDDING_PROVIDER', 'none') as 'none' | 'openai' | 'google'
  if (!EMBEDDING_PROVIDERS.includes(embeddingProvider)) {
    throw new Error(`WIKIKIT_EMBEDDING_PROVIDER must be one of ${EMBEDDING_PROVIDERS.join(', ')}`)
  }
  if (embeddingProvider !== 'none' && !providerKeys[embeddingProvider]) {
    throw new Error(
      `WIKIKIT_EMBEDDING_PROVIDER=${embeddingProvider} requires ${LLM_PROVIDER_KEY_ENV[embeddingProvider]}`,
    )
  }
  // 1536 dimensions is pinned in the wk_embeddings schema — both defaults
  // produce (or are configured to produce) 1536-dim vectors.
  const modelEmbedding = str(
    'WIKIKIT_MODEL_EMBEDDING',
    embeddingProvider === 'google' ? 'gemini-embedding-001' : 'text-embedding-3-small',
  )
  // Same mismatch, quieter failure: the embedder is a background worker, so a
  // foreign id shows up as retrying errors in the log rather than as a 500 a
  // caller can see. Checked only when a provider is selected — with 'none' the
  // value is carried but never sent anywhere.
  if (embeddingProvider !== 'none') {
    requireModelMatchesProvider(
      'WIKIKIT_MODEL_EMBEDDING',
      modelEmbedding,
      embeddingProvider,
      'WIKIKIT_EMBEDDING_PROVIDER',
    )
  }

  const ingestLeaseMs = integer('WIKIKIT_INGEST_LEASE_MS', 15 * 60 * 1000, { min: 10_000, max: 24 * 3600 * 1000 })
  const ingestHeartbeatMs = integer('WIKIKIT_INGEST_HEARTBEAT_MS', 30_000, { min: 1000, max: 3600 * 1000 })
  if (ingestHeartbeatMs * 2 >= ingestLeaseMs) {
    throw new Error('WIKIKIT_INGEST_HEARTBEAT_MS must be less than half of WIKIKIT_INGEST_LEASE_MS')
  }
  // 90 minutes. The ceiling exists to bound a HANG, whose duration is
  // unbounded — not to bound slow work, whose duration is roughly one
  // synthesis call per affected concept. The slowest legitimate production job
  // observed ran 31 concepts in 31 minutes, so a 45-minute ceiling would sit
  // barely above real work and would eventually kill an ingest that was
  // progressing normally. That failure costs the whole run's LLM spend and
  // hands the operator a `timeout` that means nothing was wrong.
  //
  // Overshooting costs far less now that a running job publishes phase and
  // progress: a stalled job is visible within a heartbeat, long before the
  // ceiling, and the ceiling is only the last resort that stops an
  // indefinitely blocked call from holding a worker forever.
  const ingestMaxRuntimeMs = integer('WIKIKIT_INGEST_MAX_RUNTIME_MS', 90 * 60 * 1000, {
    min: 60_000,
    max: 24 * 3600 * 1000,
  })
  const oauthAllowedScopes = parseIdentityScopes(str('WIKIKIT_OAUTH_ALLOWED_SCOPES'), 'WIKIKIT_OAUTH_ALLOWED_SCOPES', [
    'knowledge:read',
    'knowledge:propose',
  ])
  const oauthProviders = parseOAuthProviders(str('WIKIKIT_OAUTH_PROVIDERS'), oauthAllowedScopes)
  const scaffolding = parseScaffoldingKinds(str('WIKIKIT_SCAFFOLDING_KINDS'), 'WIKIKIT_SCAFFOLDING_KINDS')

  // The absolute deadline of a browser operator session: the moment it ends
  // however continuously somebody has been using it.
  //
  // WHY it is configuration at all. 0.26.0 made the idle window slide on every
  // authenticated read, and shipped the consequence under Known: a tab left
  // VISIBLE on an unattended machine renews itself right up to this number
  // instead of dying on the eight-hour idle window. The alternative considered
  // then — inferring whether a human is in the room from input events — was
  // rejected, and that rejection stands: presence detection is brittle and
  // invasive, and every wrong guess either signs out a reviewer mid-edit or
  // blesses an empty desk. What is left is a risk judgement, and it is not
  // WikiKit's to make. A laptop in a locked office and a shared terminal on an
  // open-plan floor do not want the same number, and the product knows which
  // one it is running on exactly never. The default is unchanged at 24 hours,
  // so no deployment's behaviour moves unless somebody asks for it.
  //
  // WHY the floor is the idle window rather than a round number. A ceiling
  // below it describes a session that expires before it can ever go idle: the
  // idle limit becomes unreachable, every deadline the operator was told to
  // expect is silently replaced by this one, and nothing in the running system
  // says so. That is a configuration mistake, and refusing it — naming both
  // numbers, so the message is the explanation — beats honouring it and leaving
  // somebody to work out months later why sessions die early. Exactly equal is
  // allowed and coherent: it means a fixed-length session that renewal can
  // never extend.
  //
  // WHY there is a roof at all. An absolute cap that can be set to a year is
  // not a cap, it is decoration — the point of the second deadline is that it
  // is reached. Thirty days is the rotating refresh token's default lifetime
  // above, and a browser cookie has no business outliving the longest-lived
  // credential WikiKit mints without being asked.
  const oauthOperatorSessionAbsoluteTtlMs = integer(
    'WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS',
    OPERATOR_SESSION_ABSOLUTE_TTL_DEFAULT_MS,
    { max: 30 * 24 * 60 * 60 * 1000 },
  )
  if (oauthOperatorSessionAbsoluteTtlMs < OPERATOR_SESSION_IDLE_MS) {
    throw new Error(
      `WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS is ${oauthOperatorSessionAbsoluteTtlMs} ms, below the ${OPERATOR_SESSION_IDLE_MS} ms idle window — a session would expire before it could ever go idle`,
    )
  }

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
    modelSynthesis,
    modelClassify,
    modelAnswer,
    modelPrices: parseModelPrices(str('WIKIKIT_MODEL_PRICES')),
    answerTokenBudget: integer('WIKIKIT_ANSWER_TOKEN_BUDGET', 36_000, { min: 1000, max: 200_000 }),
    maxBodyBytes: integer('WIKIKIT_MAX_BODY_BYTES', 10 * 1024 * 1024, { min: 1024, max: 250 * 1024 * 1024 }),
    maxIngestTokens: integer('WIKIKIT_MAX_INGEST_TOKENS', 100_000, { min: 1000, max: 1_000_000 }),
    ingestConcurrency: integer('WIKIKIT_INGEST_CONCURRENCY', 2, { min: 1, max: 16 }),
    ingestLeaseMs,
    ingestHeartbeatMs,
    ingestMaxRuntimeMs,
    // The floor is 1 and not 0: there is no spelling for "unlimited" on purpose,
    // because a deployment that wants more work in flight should say how much
    // more (a cap of 0 would refuse every ingest instead).
    ingestMaxQueuedPerSpace: integer('WIKIKIT_INGEST_MAX_QUEUED_PER_SPACE', DEFAULT_INGEST_MAX_QUEUED_PER_SPACE, {
      min: 1,
      max: 100_000,
    }),
    // 0 = keep forever, which is the operator's opt-out and the reason the floor
    // is 0 rather than 1 (cleanupOutputs refuses to compute a zero-day window,
    // so 0 can never be read as "delete everything").
    outputRetentionDays: integer('WIKIKIT_OUTPUT_RETENTION_DAYS', DEFAULT_OUTPUT_RETENTION_DAYS, {
      min: 0,
      max: 3650,
    }),
    // Same floor and ceiling as the retention window above, and 0 is again the
    // "keep everything" spelling — but here 0 is also the DEFAULT: an
    // installation nobody configured indexes every source forever.
    sourceIndexDays: integer('WIKIKIT_SOURCE_INDEX_DAYS', DEFAULT_SOURCE_INDEX_DAYS, {
      min: 0,
      max: 3650,
    }),
    schedulerEnabled: bool('WIKIKIT_SCHEDULER_ENABLED', true),
    defaultBriefing: parseDefaultBriefing(str('WIKIKIT_DEFAULT_BRIEFING', DEFAULT_BRIEFING_AT)),
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
    coverageGapTopicsEnabled: bool('WIKIKIT_COVERAGE_GAP_TOPICS_ENABLED', false),
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
    oauthOperatorSessionAbsoluteTtlMs,
    oauthDynamicRegistrationEnabled: bool('WIKIKIT_OAUTH_DCR_ENABLED', true),
    oauthProviders,
    oauthAllowedScopes,
    oauthSignupEnabled: bool('WIKIKIT_OAUTH_ENABLE_SIGNUP', false),
    logLevel: str('LOG_LEVEL', 'info'),
    version: VERSION,
    llmConfigured: llmApiKey.length > 0,
    embeddingProvider,
    modelEmbedding,
    embeddingApiKey: embeddingProvider === 'none' ? '' : providerKeys[embeddingProvider],
    embeddingApiKeyEnv:
      embeddingProvider === 'none' ? 'WIKIKIT_EMBEDDING_PROVIDER' : LLM_PROVIDER_KEY_ENV[embeddingProvider],
    embeddingConfigured: embeddingProvider !== 'none' && providerKeys[embeddingProvider].length > 0,
    scaffoldingKinds: scaffolding.kinds,
    scaffoldingKindsDeclared: scaffolding.declared,
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
