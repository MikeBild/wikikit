// Composition root — createApp wires config → db → domain → llm → pipeline →
// webhooks worker → http (a server composition in factory-DI
// form). Everything is injectable for tests; production takes the defaults.
//
// WHY a separate createApp/start split: createApp builds a fully wired but
// INERT app (nothing listening, no workers) so tests can drive the HTTP
// handler and workers deterministically; start() adds the runtime concerns —
// migrations, dev bootstrap, listen, worker start, signal-driven drain.
import type { Server } from 'node:http'
import { DEFAULT_OUTPUT_RETENTION_DAYS, DEFAULT_SOURCE_INDEX_DAYS, loadConfig, type Config } from './config.ts'
import { createPostgres, type Database } from './db/postgres.ts'
import { runMigrations } from './db/migrate.ts'
import { createChunkBackfill, type ChunkBackfill } from './ingest/chunker.ts'
import { createEmbedder, probeVectorSupport, type Embedder } from './ingest/embedder.ts'
import { createIngestPipeline, type IngestPipeline } from './ingest/pipeline.ts'
import { createLlmProvider } from './llm/aisdk.ts'
import type { LlmProvider } from './llm/provider.ts'
import { createLogger, type Logger } from './logger.ts'
import { createMetrics, type Metrics } from './metrics.ts'
import { cleanupOutputs } from './domain/outputs.ts'
import { unindexAgedSources } from './domain/sources.ts'
import { createScheduler, type Scheduler } from './schedule.ts'
import type { Db } from './db/postgres.ts'
import { createOutboxWorker, type OutboxWorker } from './webhooks.ts'
import { createCockpit, COCKPIT_PREFIX } from './cockpit.ts'
import { createAuth, type Auth } from './http/auth.ts'
import type { HttpDeps } from './http/routes.ts'
import { createSpace } from './domain/spaces.ts'
import { createHttpServer, refuseWithDrainingEnvelope, type DrainPolicy, type RawHandler } from './http/server.ts'
import { createElicitationRegistry } from './mcp/elicitation-registry.ts'
import { createMcpMount, toNodeRawHandler, type McpMount } from './mcp/server.ts'
import { createOAuthMount } from './oauth/server.ts'
import { createUsageTelemetry, type UsageTelemetry } from './usage.ts'

export interface AppDeps {
  logger: Logger
  database: Database
  llm: LlmProvider
  auth: Auth
  metrics: Metrics
  outbox: OutboxWorker
  ingest: IngestPipeline
  chunker: ChunkBackfill
  embedder: Embedder
  usage: UsageTelemetry
  scheduler: Scheduler
}

/**
 * The output retention sweep, on its own hourly timer.
 *
 * WHY NOT hung off the usage telemetry timer, which is the existing hourly
 * sweeper: that one only exists when WIKIKIT_USAGE_TELEMETRY_ENABLED is on
 * (start() returns immediately otherwise), and telemetry is off by default. An
 * installation that never enabled it would have accumulated /query outputs
 * forever while docs/CONFIGURATION.md promised a 365-day window — a retention
 * promise conditional on an unrelated feature flag is not a retention promise.
 *
 * WHY it lives in the composition root rather than in src/domain/outputs.ts: the
 * domain owns the DELETE (cleanupOutputs, global across spaces like
 * cleanupCoverageGaps) and app.ts owns when anything runs. Failures are logged and
 * swallowed the way usage.ts swallows its own — a sweep that cannot run must never
 * take the timer, or the process, with it.
 */
interface RetentionSweeper {
  start(): void
  stop(): void
  /** One sweep now; returns rows deleted. The deterministic handle for tests. */
  sweep(): Promise<number>
}

function createRetentionSweeper(deps: { db: Db; logger: Logger; config: Config }): RetentionSweeper {
  let timer: ReturnType<typeof setInterval> | undefined
  // An absent field falls back to the shipped window, not to "keep everything":
  // only an explicit 0 is the operator's opt-out (see Config.outputRetentionDays).
  const retentionDays = deps.config.outputRetentionDays ?? DEFAULT_OUTPUT_RETENTION_DAYS
  async function sweep(): Promise<number> {
    try {
      const deleted = await cleanupOutputs(deps.db, retentionDays)
      if (deleted > 0) {
        deps.logger.info('collected expired outputs', { deleted, retention_days: retentionDays })
      }
      return deleted
    } catch (error) {
      deps.logger.warn('output retention sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return 0
    }
  }
  return {
    sweep,
    start() {
      // 0 = keep forever: no timer at all rather than an hourly no-op.
      if (timer || retentionDays <= 0) return
      void sweep()
      timer = setInterval(() => void sweep(), 60 * 60 * 1000)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}

/**
 * The source index window, on its own hourly timer.
 *
 * A literal sibling of the sweeper above rather than a shared abstraction: the
 * two collect different things under different windows with different defaults
 * (a year vs. forever), and the one argument that matters is the same one — a
 * sweep must not hang off another feature's timer. Hanging this on the retention
 * sweeper would silently make the index window conditional on
 * WIKIKIT_OUTPUT_RETENTION_DAYS being non-zero, which is exactly the class of
 * bug the comment above records.
 *
 * The domain owns the DELETE (unindexAgedSources, global across spaces) and this
 * file owns when it runs; a failed sweep is warned and swallowed, never allowed
 * to take the timer with it.
 */
interface SourceIndexSweeper {
  start(): void
  stop(): void
  /** One sweep now; returns chunk rows deleted. The deterministic handle for tests. */
  sweep(): Promise<number>
}

function createSourceIndexSweeper(deps: { db: Db; logger: Logger; config: Config }): SourceIndexSweeper {
  let timer: ReturnType<typeof setInterval> | undefined
  // Absent falls back to DEFAULT_SOURCE_INDEX_DAYS, which is 0 — the inversion
  // against the retention window above: no window until an operator sets one
  // (see Config.sourceIndexDays).
  const indexDays = deps.config.sourceIndexDays ?? DEFAULT_SOURCE_INDEX_DAYS
  async function sweep(): Promise<number> {
    try {
      const deleted = await unindexAgedSources(deps.db, indexDays)
      if (deleted > 0) {
        deps.logger.info('unindexed aged sources', { chunks_deleted: deleted, index_days: indexDays })
      }
      return deleted
    } catch (error) {
      deps.logger.warn('source index sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return 0
    }
  }
  return {
    sweep,
    start() {
      // 0 = indexed forever: no timer at all rather than an hourly no-op.
      if (timer || indexDays <= 0) return
      void sweep()
      timer = setInterval(() => void sweep(), 60 * 60 * 1000)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}

export interface App {
  server: Server
  state: { draining: boolean }
  /** pgvector capability, probed by start() after migrations. Hybrid search keys off it. */
  vector: { available: boolean }
  outbox: OutboxWorker
  ingest: IngestPipeline
  chunker: ChunkBackfill
  embedder: Embedder
  /** The briefing/health worker — self-guards on WIKIKIT_SCHEDULER_ENABLED. */
  scheduler: Scheduler
  /** Hourly wk_outputs retention sweep (see createRetentionSweeper). */
  retention: RetentionSweeper
  /** Hourly wk_source_chunks index sweep (see createSourceIndexSweeper). */
  sourceIndex: SourceIndexSweeper
  database: Database
  auth: Auth
  logger: Logger
  metrics: Metrics
  usage: UsageTelemetry
  config: Config
  /**
   * MCP mounting hook: src/mcp attaches its Streamable-HTTP transport at
   * POST /mcp through this — the path stays outside ROUTES/OpenAPI (§5.2)
   * while sharing the process, auth factory and DB pool.
   */
  mountRawHandler(path: string, handler: RawHandler, whileDraining: DrainPolicy): void
  /** In-process request entry (tests drive the server without a socket). */
  handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
  /** Stop workers, close server + pool. Idempotent. */
  close(): Promise<void>
}

/**
 * How /mcp refuses while the process is draining.
 *
 * WHY refuse at all: /mcp is mounted raw, ahead of the ROUTES drain gate, so
 * for the whole drain window an agent could open a session or start a tool
 * call on an instance that was seconds from tearing it down — while the same
 * operation over REST got a clean 503 and retried against an instance that was
 * staying up. Of the two outcomes available to a request that arrives during a
 * drain, a session that dies mid-call is strictly the worse one: the agent
 * cannot tell it from a fault, and a fault is not something it retries
 * elsewhere.
 *
 * WHY a JSON-RPC frame rather than the §8.1 HTTP envelope: an MCP client reads
 * this body as a JSON-RPC message. Handed `{error, code, request_id}` where a
 * message belongs, it reports a parse error — "the server is broken" — which
 * is the one thing this refusal exists not to say. The shape below is the same
 * one src/mcp/server.ts's own transport guards use for an invalid Origin and
 * an unsupported protocol version (server-defined code range -32000..-32099),
 * so a client that already handles those handles this. The HTTP status stays
 * 503 for the load balancer, which reads statuses and never reads bodies: both
 * audiences are told the truth in their own language. The next step rides in
 * the message because JSON-RPC has nowhere to put next_best_actions.
 *
 * WHY every method, DELETE included: a DELETE only releases a session, and
 * close() releases every session anyway a moment later — so refusing it loses
 * nothing, and "re-initialize somewhere else" is the correct next step for all
 * three verbs. A carve-out would buy a marginally tidier teardown at the price
 * of a second rule to remember.
 */
const refuseMcpWhileDraining: RawHandler = (_req, res) => {
  const frame = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'server is draining — re-run initialize against another instance' },
    id: null,
  })
  res.writeHead(503, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(frame)) })
  res.end(frame)
}

export function createApp(config: Config = loadConfig(), deps: Partial<AppDeps> = {}): App {
  const logger =
    deps.logger ??
    createLogger({
      level: config.logLevel,
      base: {
        'service.name': 'wikikit',
        'service.version': config.version,
        'deployment.environment.name': config.environment ?? (config.production ? 'production' : 'development'),
      },
    })
  const database = deps.database ?? createPostgres(config)
  const db = database.db
  // The provider self-reports configured:false without a key — ingest/query
  // then answer 503 llm_not_configured while every LLM-free route keeps working
  // (zero-config principle). Provider is config-selected (WIKIKIT_LLM_PROVIDER).
  const metrics = deps.metrics ?? createMetrics()
  const llm = deps.llm ?? createLlmProvider(config, { logger, metrics })
  const auth = deps.auth ?? createAuth(config, db)
  const outbox = deps.outbox ?? createOutboxWorker(config, db, logger, { metrics })
  const ingest = deps.ingest ?? createIngestPipeline(config, db, llm, logger, { metrics })
  const chunker = deps.chunker ?? createChunkBackfill(db, logger)
  const embedder = deps.embedder ?? createEmbedder(db, llm, config, logger)
  const usage = deps.usage ?? createUsageTelemetry(config, db, logger)
  // Durable in Postgres like every other worker here: due rows are claimed with
  // FOR UPDATE SKIP LOCKED, so N binaries produce exactly one report per window
  // and a restart loses nothing but the poll it was in.
  const scheduler = deps.scheduler ?? createScheduler({ db, logger }, config)
  const retention = createRetentionSweeper({ db, logger, config })
  const sourceIndex = createSourceIndexSweeper({ db, logger, config })
  const state = { draining: false }
  // Filled by start() after migrations (createApp is inert and sync); until
  // probed, retrieval behaves lexically — the safe floor.
  const vector = { available: false }

  // Shared between the REST review endpoints and the MCP mount: URL-mode
  // review elicitations register here, and the terminal review (which always
  // lands over REST — the review page is a thin REST client) fires the
  // pending notifications/elicitation/complete on the originating session.
  const reviewElicitations = createElicitationRegistry({ logger })

  // ChatGPT and other remote MCP clients discover and complete OAuth without
  // ever seeing an operator API key. One raw handler owns the OAuth wire
  // formats (JSON, form posts and the browser HTML); exact mounts keep the
  // ordinary REST registry and OpenAPI surface unchanged.
  //
  // Constructed BEFORE the HTTP server because it also owns the browser
  // operator session, and the REST plane consults that as its credential of
  // last resort for the cockpit's same-origin calls.
  const oauth = createOAuthMount(config, { db, auth, logger })

  const httpDeps: HttpDeps = {
    config,
    logger,
    db,
    auth,
    llm,
    ingest,
    metrics,
    usage,
    state,
    vector,
    reviewElicitations,
    sessionAuth: oauth,
  }
  const http = createHttpServer(httpDeps)

  // Mount the MCP Streamable-HTTP transport at /mcp — the composition-root
  // wiring the McpMount contract describes. Without it the binary answers
  // `no route for POST /mcp` even though the mount itself is unit/integration
  // tested in isolation: /mcp lives OUTSIDE the ROUTES registry (§5.2), so only
  // this raw mount attaches it. The regression is guarded by an initialize
  // check in test/integration/http.test.ts against the real createApp server.
  const mcp: McpMount = createMcpMount(config, {
    config,
    db,
    ingest,
    auth,
    logger,
    usage,
    llm,
    vector,
    reviewElicitations,
  })
  http.mountRawHandler('/mcp', toNodeRawHandler(mcp, { maxBodyBytes: config.maxBodyBytes }), refuseMcpWhileDraining)

  // The ENV allowlist is a bootstrap-only path since 0028: real access
  // management lives on wk_oauth_identities via the admin REST
  // (/v1/identities). A growing allowlist means grants are being managed in
  // the wrong place — say so once at boot.
  const allowlisted = (config.oauthProviders ?? []).reduce(
    (count, provider) =>
      provider.protocol === 'oidc' ? count + provider.allowedEmails.length + provider.allowedSubjects.length : count,
    0,
  )
  if (allowlisted > 2) {
    logger.warn('oidc ENV allowlist is bootstrap-only — manage identity grants via PUT /v1/identities instead', {
      allowlisted_entries: allowlisted,
    })
  }
  // One handler, two drain policies. The line between them is NOT
  // browser-versus-machine — it is who can act on the refusal.
  //
  // A program that gets a 503 retries, the load balancer hands it an instance
  // that is staying up, and every artifact the flow depends on — the DCR
  // client row, the authorization code, the identity grant — lives in the
  // Postgres all the instances share, so the retry RESUMES the flow rather
  // than restarting it. The caller loses a round trip.
  //
  // A human halfway through a redirect chain cannot retry. The login state
  // they are carrying is single-use and is marked consumed before the redirect
  // is built, so a 503 at the callback does not mean "try again", it means
  // "sign in again from the start" — announced by a blank error page, to the
  // operator most likely to be watching the very deploy that caused it. The
  // funnel therefore finishes what it started.
  //
  // The two halves compose because of that shared database: a browser that
  // completes consent HERE hands its authorization code to a client whose
  // token exchange is refused, retried, and completed against a live instance
  // reading the same row. Refusing the mint while serving the consent throws
  // nobody's work away.
  for (const path of [
    '/v1/identity/cockpit-login',
    '/v1/identity/login/start',
    '/v1/identity/login/callback',
    '/v1/identity/logout',
    '/v1/session',
    '/v1/oauth/authorize',
    '/v1/oauth/authorize/decision',
  ]) {
    http.mountRawHandler(path, oauth.handler, 'serve')
  }
  // The machine credential plane: discovery, dynamic client registration, the
  // identity-assertion exchange that mints an API key, the token mint and its
  // revocation. Each is called by a program, answers JSON, and is repeatable
  // against another instance — so the ordinary §8.1 'draining' envelope IS the
  // refusal a caller here will act on; there is no second wire format to
  // speak, which is exactly what makes /mcp the different case.
  //
  // Discovery is refused with the rest rather than served like the console's
  // static bundle, and the difference is not that one is static: it is that
  // discovery is the FIRST call of the flow — the cheapest possible place to
  // send a client to a healthy instance, before it has registered anything —
  // and that nobody is looking at it. The console is the screen an operator
  // watches the drain on; a well-known document is a step an agent takes.
  //
  // Revocation refuses too, though it destroys rather than creates: it is
  // idempotent and the token it revokes is a row every instance can see, so a
  // refused revoke is a retried revoke, not a token left alive.
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/v1/identity/providers',
    '/v1/identity/sessions',
    '/v1/oauth/register',
    '/v1/oauth/token',
    '/v1/oauth/revoke',
  ]) {
    http.mountRawHandler(path, oauth.handler, refuseWithDrainingEnvelope)
  }

  // The cockpit — WikiKit's one human surface, served from this same process at
  // /cockpit (CUI-MOUNT-1). A prefix mount rather than exact paths: a built SPA
  // is a directory of fingerprinted filenames plus a client-side router, and
  // enumerating either would be a list that goes stale on the next build.
  //
  // It keeps serving while the process drains, and that is the easy half of
  // the drain decision: the bundle is static and holds no knowledge, so there
  // is no work to refuse — only a file read — and the console is the one
  // screen an operator watches a deploy on. A page that goes blank halfway
  // through reports nothing; it just looks broken, at the moment the operator
  // most needs to be told what is happening. The API calls that page makes are
  // ordinary ROUTES and do hit the drain gate, so the console degrades to
  // saying "the server is draining", which is the true answer, instead of
  // vanishing and saying nothing.
  const cockpit = createCockpit({ logger })
  http.mountRawPrefix(COCKPIT_PREFIX, cockpit.handler, 'serve')

  let closed = false
  return {
    server: http.server,
    state,
    vector,
    outbox,
    ingest,
    chunker,
    embedder,
    scheduler,
    retention,
    sourceIndex,
    database,
    auth,
    logger,
    metrics,
    usage,
    config,
    mountRawHandler: http.mountRawHandler,
    handle: http.handle,
    async close() {
      if (closed) return
      closed = true
      state.draining = true
      oauth.stop()
      mcp.stop() // stop the session sweeper + close live MCP sessions
      usage.stop()
      retention.stop()
      sourceIndex.stop()
      outbox.stop()
      chunker.stop()
      embedder.stop()
      // Awaited beside the ingest worker, for the same reason: both may be inside
      // a job, and stop() waits for the loop so the drain does not tear the pool
      // out from under a half-written report.
      await scheduler.stop()
      await ingest.stop()
      // Bounded drain: server.close() alone waits for keep-alive sockets
      // that client fetch pools may idle for minutes (and Bun's node:http
      // compat does not reliably sever them via closeIdleConnections). New
      // requests are already refused (draining=true) and the workers are
      // stopped, so after a short grace for in-flight responses we sever the
      // remaining sockets and move on — a drain must never hang the process.
      await new Promise<void>((resolve) => {
        const guard = setTimeout(() => {
          http.server.closeAllConnections?.()
          resolve()
        }, 5000)
        guard.unref()
        http.server.close(() => {
          clearTimeout(guard)
          resolve()
        })
        http.server.closeIdleConnections?.()
      })
      await database.close().catch(() => {})
    },
  }
}

/**
 * Zero-config dev bootstrap (plan §8): ensure a default space exists and a
 * one-time-printed `*` API key when the database is empty. Idempotent, and a
 * no-op in production — deployments provision explicitly.
 */
async function devBootstrap(app: App): Promise<void> {
  if (app.config.production) return
  const spaces = await app.database.db.select<{ id: string }>('wk_spaces', { limit: 1 })
  if (!spaces.length) {
    await createSpace(
      app.database.db,
      { slug: 'default', name: 'Default Space' },
      app.config.defaultBriefing,
      app.logger,
    )
    app.logger.info('dev bootstrap: created default space', { slug: 'default' })
  }
  await app.auth.ensureDevBootstrapKey(app.logger)
}

/**
 * Startup report for the optional hybrid ranker. Neither half gates boot —
 * availability must never decide whether the server comes up. The one
 * combination that earns a warning is a configured embedding provider with no
 * extension to write into: that deployment looks fully equipped from its
 * environment and degrades to lexical retrieval in silence.
 */
export function reportVectorCapability(
  logger: Logger,
  state: { embeddingConfigured: boolean; available: boolean },
): void {
  if (state.available) {
    // Hybrid needs both halves; the flag says which one this probe just secured.
    logger.info('pgvector available', { hybrid_retrieval: state.embeddingConfigured })
    return
  }
  if (!state.embeddingConfigured) return
  logger.warn(
    'an embedding provider is configured but pgvector is absent; retrieval stays lexical and no embeddings are produced',
    { remedy: 'install pgvector as an OS package, then run migrations — 0041 creates the objects 0018 skipped' },
  )
}

/** runMigrations → createApp → dev bootstrap → listen → workers → signal-driven graceful drain. */
export async function start(config: Config = loadConfig()): Promise<App> {
  const logger = createLogger({
    level: config.logLevel,
    base: {
      'service.name': 'wikikit',
      'service.version': config.version,
      'deployment.environment.name': config.environment ?? (config.production ? 'production' : 'development'),
    },
  })
  // Migrations run BEFORE the app exists (advisory-locked, idempotent): a
  // process that cannot reach its schema must fail its deploy health gate,
  // not serve half-migrated requests.
  const report = await runMigrations(config, logger)

  const app = createApp(config, { logger })
  try {
    await devBootstrap(app)
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject)
      app.server.listen(config.port, config.host, resolve)
    })
  } catch (error) {
    await app.close().catch(() => {})
    throw error
  }
  // pgvector capability probe — after migrations (0018 may have just created
  // the extension), before workers. Failure means "no hybrid", never "no boot".
  try {
    app.vector.available = await probeVectorSupport(app.database.db)
  } catch {
    app.vector.available = false
  }
  reportVectorCapability(logger, {
    embeddingConfigured: config.embeddingConfigured === true,
    available: app.vector.available,
  })
  app.outbox.start()
  app.ingest.start()
  app.chunker.start()
  // The embedder needs both halves: a configured embedding provider AND the
  // pgvector schema objects to write into.
  if (config.embeddingConfigured && app.vector.available) app.embedder.start()
  app.usage.start()
  // No config conditional on any of the three: start() self-guards on
  // WIKIKIT_SCHEDULER_ENABLED, and each sweeper skips its timer when its own
  // window is 0 — the decision belongs next to the flag it reads, not here.
  app.scheduler.start()
  app.retention.start()
  app.sourceIndex.start()
  logger.info('wikikit listening', {
    url: `http://${config.host}:${config.port}`,
    version: config.version,
    llm_configured: config.llmConfigured,
    vector_available: app.vector.available,
    migrations_applied: report.applied.length,
  })

  let stopping = false
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return
    stopping = true
    logger.info('draining', { signal })
    // draining flips /ready to 503 immediately; close() then stops workers
    // and waits for in-flight requests. The 30s guard covers a hung LLM call.
    app.state.draining = true
    const guard = setTimeout(() => process.exit(1), 30_000)
    guard.unref()
    await app.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  return app
}
