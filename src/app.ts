// Composition root — createApp wires config → db → domain → llm → pipeline →
// webhooks worker → http (a server composition in factory-DI
// form). Everything is injectable for tests; production takes the defaults.
//
// WHY a separate createApp/start split: createApp builds a fully wired but
// INERT app (nothing listening, no workers) so tests can drive the HTTP
// handler and workers deterministically; start() adds the runtime concerns —
// migrations, dev bootstrap, listen, worker start, signal-driven drain.
import type { Server } from 'node:http'
import { loadConfig, type Config } from './config.ts'
import { createPostgres, type Database } from './db/postgres.ts'
import { runMigrations } from './db/migrate.ts'
import { createIngestPipeline, type IngestPipeline } from './ingest/pipeline.ts'
import { createLlmProvider } from './llm/aisdk.ts'
import type { LlmProvider } from './llm/provider.ts'
import { createLogger, type Logger } from './logger.ts'
import { createMetrics, type Metrics } from './metrics.ts'
import { createOutboxWorker, type OutboxWorker } from './webhooks.ts'
import { createAuth, type Auth } from './http/auth.ts'
import { createSpace, type HttpDeps } from './http/routes.ts'
import { createHttpServer, type RawHandler } from './http/server.ts'
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
  usage: UsageTelemetry
}

export interface App {
  server: Server
  state: { draining: boolean }
  outbox: OutboxWorker
  ingest: IngestPipeline
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
  mountRawHandler(path: string, handler: RawHandler): void
  /** In-process request entry (tests drive the server without a socket). */
  handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
  /** Stop workers, close server + pool. Idempotent. */
  close(): Promise<void>
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
  const usage = deps.usage ?? createUsageTelemetry(config, db, logger)
  const state = { draining: false }

  const httpDeps: HttpDeps = { config, logger, db, auth, llm, ingest, metrics, usage, state }
  const http = createHttpServer(httpDeps)

  // Mount the MCP Streamable-HTTP transport at /mcp — the composition-root
  // wiring the McpMount contract describes. Without it the binary answers
  // `no route for POST /mcp` even though the mount itself is unit/integration
  // tested in isolation: /mcp lives OUTSIDE the ROUTES registry (§5.2), so only
  // this raw mount attaches it. The regression is guarded by an initialize
  // check in test/integration/http.test.ts against the real createApp server.
  const mcp: McpMount = createMcpMount(config, { config, db, ingest, auth, logger, usage })
  http.mountRawHandler('/mcp', toNodeRawHandler(mcp, { maxBodyBytes: config.maxBodyBytes }))

  // ChatGPT and other remote MCP clients discover and complete OAuth without
  // ever seeing an operator API key. One raw handler owns the OAuth wire
  // formats (JSON, form posts and the consent HTML); exact mounts keep the
  // ordinary REST registry and OpenAPI surface unchanged.
  const oauth = createOAuthMount(config, { db, auth, logger })
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/v1/oauth/register',
    '/v1/oauth/authorize',
    '/v1/oauth/authorize/decision',
    '/v1/oauth/token',
    '/v1/oauth/revoke',
    '/v1/identity/login/start',
    '/v1/identity/login/callback',
    '/v1/identity/logout',
  ]) {
    http.mountRawHandler(path, oauth.handler)
  }

  let closed = false
  return {
    server: http.server,
    state,
    outbox,
    ingest,
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
      outbox.stop()
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
    await createSpace(app.database.db, { slug: 'default', name: 'Default Space' })
    app.logger.info('dev bootstrap: created default space', { slug: 'default' })
  }
  await app.auth.ensureDevBootstrapKey(app.logger)
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
  app.outbox.start()
  app.ingest.start()
  app.usage.start()
  logger.info('wikikit listening', {
    url: `http://${config.host}:${config.port}`,
    version: config.version,
    llm_configured: config.llmConfigured,
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
