// Safe query layer — a PostgREST-style builder extended with the CONTRACTS.md
// §2.1 Db surface (query/tx/call/emitEvent). No ORM by design: every SQL
// shape is either pinned here or written explicitly by a domain module —
// nothing generates SQL from user input.
//
// Three defense layers, all throwing before any SQL reaches Postgres:
//   1. Table allowlist — builder methods only touch known wk_ tables, and
//      raw query() text is scanned so an unknown wk_* identifier (including
//      the SQL functions!) can never be smuggled in.
//   2. Function whitelist — call() is the ONLY path to wk_apply_proposal /
//      wk_reject_proposal / wk_search. Each entry pins the exact statement
//      and parameter order, so callers can never influence the SQL shape.
//   3. Filter encoding — PostgREST-style operators (eq./lte./in.()/is.null)
//      are parsed into parameterized clauses; anything unrecognized throws.
import pg from 'pg'
import type { Config } from '../config.ts'

const { Pool } = pg

// Every persisted WikiKit table. migrate.ts owns wk_migrations separately (it
// runs on its own client before the app layer exists), so it is deliberately
// NOT listed — application code has no business reading the journal.
export const TABLES: ReadonlySet<string> = new Set([
  'wk_spaces',
  'wk_sources',
  'wk_concepts',
  'wk_concept_revisions',
  'wk_claims',
  'wk_citations',
  'wk_relations',
  'wk_decisions',
  'wk_change_proposals',
  'wk_api_keys',
  'wk_outbox_events',
  'wk_webhook_endpoints',
  'wk_webhook_deliveries',
  'wk_ingest_jobs',
  'wk_agent_runs',
])

/** Whitelisted SQL function names — the ONLY write path for review decisions. */
export type WhitelistedFn = 'wk_apply_proposal' | 'wk_reject_proposal' | 'wk_search'

/** Outbox event names (CONTRACTS §6.1) — the payload `type` field and wk_outbox_events.event_type. */
export type WebhookEventType =
  | 'wikikit.proposal.created'
  | 'wikikit.proposal.approved'
  | 'wikikit.proposal.rejected'
  | 'wikikit.concept.updated'
  | 'wikikit.ingest.failed'

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'wikikit.proposal.created',
  'wikikit.proposal.approved',
  'wikikit.proposal.rejected',
  'wikikit.concept.updated',
  'wikikit.ingest.failed',
])

interface QueryResultLike {
  rows: Record<string, unknown>[]
  rowCount: number | null
}
type Exec = (sql: string, values: unknown[]) => Promise<QueryResultLike>

// Whitelisted SQL function registry. Each entry pins the exact statement and
// normalizes positional args (validating arity, filling declared defaults) —
// an unknown name throws exactly like an unknown table. `result` unwraps the
// jsonb-returning functions so callers get the payload rows directly.
interface FnSpec {
  sql: string
  normalize: (args: unknown[]) => unknown[]
  result: (response: QueryResultLike) => Record<string, unknown>[]
}

function reviewArgs(fn: string, args: unknown[]): unknown[] {
  if (args.length < 2 || args.length > 3) {
    throw new Error(`${fn} expects [proposal_id, reviewer, note?] — got ${args.length} args`)
  }
  return [args[0], args[1], args[2] ?? null]
}

const FUNCTIONS: Record<WhitelistedFn, FnSpec> = {
  wk_apply_proposal: {
    sql: 'SELECT public.wk_apply_proposal($1, $2, $3) AS result',
    normalize: (args) => reviewArgs('wk_apply_proposal', args),
    result: (response) => response.rows.map((row) => row.result as Record<string, unknown>),
  },
  wk_reject_proposal: {
    sql: 'SELECT public.wk_reject_proposal($1, $2, $3) AS result',
    normalize: (args) => reviewArgs('wk_reject_proposal', args),
    result: (response) => response.rows.map((row) => row.result as Record<string, unknown>),
  },
  wk_search: {
    sql: 'SELECT * FROM public.wk_search($1, $2, $3, $4)',
    normalize: (args) => {
      if (args.length < 2 || args.length > 4) {
        throw new Error(`wk_search expects [space_id, query, kind?, limit?] — got ${args.length} args`)
      }
      // WHY the explicit limit default: `LIMIT NULL` in Postgres means "no
      // limit" — padding a missing arg with null would silently disable the
      // cap, so the SQL default (20) is mirrored here.
      return [args[0], args[1], args[2] ?? null, args[3] ?? 20]
    },
    result: (response) => response.rows,
  },
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`invalid SQL identifier: ${value}`)
  return `"${value}"`
}

function tableName(value: string): string {
  if (!TABLES.has(value)) throw new Error(`unknown WikiKit table: ${value}`)
  return `"public".${identifier(value)}`
}

// Raw query() guard: every wk_-prefixed identifier in the SQL text must be a
// known table. This blocks typo'd tables AND direct calls to the SQL
// functions (call() is the only RPC path — CONTRACTS §1.15).
function assertKnownWkIdentifiers(text: string): void {
  for (const match of text.matchAll(/\bwk_[a-z0-9_]*/g)) {
    if (!TABLES.has(match[0])) {
      throw new Error(`unknown WikiKit table in query: ${match[0]} (SQL functions go through db.call)`)
    }
  }
}

/** PostgREST-style filter/option map: `{ slug: 'eq.foo', order: 'created_at.desc', limit: 10 }`. */
export interface SelectQuery {
  [column: string]: unknown
  order?: string
  limit?: number
}

export interface InsertOptions {
  returning?: boolean
  upsert?: boolean
  onConflict?: string
}

function whereClause(filters: SelectQuery | undefined, values: unknown[]): string {
  const clauses: string[] = []
  for (const [column, raw] of Object.entries(filters || {})) {
    if (column === 'order' || column === 'limit' || raw === undefined) continue
    const name = identifier(column)
    const expression = String(raw)
    if (expression === 'is.null') clauses.push(`${name} IS NULL`)
    else if (expression === 'not.is.null') clauses.push(`${name} IS NOT NULL`)
    else if (expression.startsWith('eq.')) {
      values.push(expression.slice(3))
      clauses.push(`${name} = $${values.length}`)
    } else if (expression.startsWith('lte.')) {
      values.push(expression.slice(4))
      clauses.push(`${name} <= $${values.length}`)
    } else if (expression.startsWith('in.(') && expression.endsWith(')')) {
      const entries = expression.slice(4, -1).split(',').filter(Boolean)
      // Empty IN list matches nothing — FALSE keeps that semantic instead of
      // generating invalid `IN ()` SQL.
      if (!entries.length) clauses.push('FALSE')
      else {
        const parameters = entries.map((entry) => {
          values.push(entry)
          return `$${values.length}`
        })
        clauses.push(`${name} IN (${parameters.join(', ')})`)
      }
    } else {
      throw new Error(`unsupported database filter for ${column}`)
    }
  }
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
}

function orderClause(order: string | undefined): string {
  if (!order) return ''
  const [column, direction = 'asc'] = String(order).split('.')
  if (!column || !['asc', 'desc'].includes(direction.toLowerCase())) {
    throw new Error('invalid database sort direction')
  }
  return ` ORDER BY ${identifier(column)} ${direction.toUpperCase()}`
}

function limitClause(limit: number | undefined, values: unknown[]): string {
  if (limit === undefined) return ''
  const parsed = Number(limit)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) throw new Error('invalid database limit')
  values.push(parsed)
  return ` LIMIT $${values.length}`
}

/**
 * The Db surface everything downstream codes against (CONTRACTS §2.1) plus
 * the PostgREST-style builder helpers. The builders
 * exist so simple CRUD never hand-writes SQL; anything with joins uses
 * query() (raw but allowlist-scanned and always parameterized).
 */
export interface Db {
  /** Parameterized query. Every wk_* identifier in the text must be a known table. */
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>
  /**
   * Run fn inside a single transaction; the passed Db is transaction-bound so
   * a business write and its outbox event commit atomically. Nested tx is an
   * ERROR by choice (no savepoints): a hidden savepoint would let a partial
   * failure commit silently, and no WikiKit flow needs one.
   */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  /** Whitelisted SQL function call — the ONLY path to the review functions and wk_search. */
  call<R = Record<string, unknown>>(fn: WhitelistedFn, args: unknown[]): Promise<R[]>
  /**
   * Insert an outbox event. For the transactional-outbox guarantee this must
   * be called on a tx-bound Db alongside the state change it describes; on
   * the pool it still works but is not atomic with anything.
   */
  emitEvent(spaceId: string, eventType: WebhookEventType, payload: Record<string, unknown>): Promise<void>

  /** `SELECT *` with PostgREST-style filters, order and limit. */
  select<R = Record<string, unknown>>(table: string, query?: SelectQuery): Promise<R[]>
  /** Insert one row or a homogeneous batch; optional upsert via onConflict columns. */
  insert<R = Record<string, unknown>>(
    table: string,
    body: Record<string, unknown> | Record<string, unknown>[],
    options?: InsertOptions,
  ): Promise<R[]>
  /** Filtered update; refuses to run without a WHERE clause. */
  update<R = Record<string, unknown>>(
    table: string,
    filters: SelectQuery,
    body: Record<string, unknown>,
    options?: { returning?: boolean },
  ): Promise<R[]>
  /** Filtered delete; refuses to run without a WHERE clause. */
  remove(table: string, filters: SelectQuery): Promise<void>
}

export interface Database {
  db: Db
  close(): Promise<void>
}

// Builds the Db API bound to a single executor (the pool for autocommit
// calls, or a checked-out client inside db.tx). Every method is
// executor-agnostic so the same domain code runs transactionally or not.
function makeApi(exec: Exec): Db {
  const db: Db = {
    async query(text, params = []) {
      assertKnownWkIdentifiers(text)
      const result = await exec(text, params)
      return { rows: result.rows as never[], rowCount: result.rowCount ?? 0 }
    },

    // Overridden by createPostgres for the pool-bound instance; the tx-bound
    // default refuses nesting (documented choice — see interface docs).
    async tx() {
      throw new Error('nested transactions are not supported — pass the tx-bound db down instead')
    },

    async call(fn, args) {
      const spec = FUNCTIONS[fn] as FnSpec | undefined
      if (!spec) throw new Error(`unknown WikiKit function: ${String(fn)}`)
      return spec.result(await exec(spec.sql, spec.normalize(args))) as never[]
    },

    async emitEvent(spaceId, eventType, payload) {
      // Runtime guard in addition to the type: event names are a wire
      // contract (webhook consumers switch on them), so a typo must fail the
      // write, not fan out to subscribers.
      if (!EVENT_TYPES.has(eventType)) throw new Error(`unknown webhook event type: ${eventType}`)
      await exec('INSERT INTO "public"."wk_outbox_events" (space_id, event_type, payload) VALUES ($1, $2, $3)', [
        spaceId,
        eventType,
        JSON.stringify(payload),
      ])
    },

    async select(table, query = {}) {
      const values: unknown[] = []
      const sql = `SELECT * FROM ${tableName(table)}${whereClause(query, values)}${orderClause(query.order)}${limitClause(query.limit, values)}`
      return (await exec(sql, values)).rows as never[]
    },

    async insert(table, body, { returning = true, upsert = false, onConflict }: InsertOptions = {}) {
      const rows = Array.isArray(body) ? body : [body]
      if (!rows.length) return []
      const columns = Object.keys(rows[0]!)
      if (!columns.length || rows.some((row) => columns.some((column) => !(column in row)))) {
        throw new Error('database insert rows must have the same non-empty shape')
      }
      const values: unknown[] = []
      const groups = rows.map(
        (row) =>
          `(${columns
            .map((column) => {
              values.push(row[column])
              return `$${values.length}`
            })
            .join(', ')})`,
      )
      let conflict = ''
      if (upsert) {
        const targets = String(onConflict || '')
          .split(',')
          .filter(Boolean)
        if (!targets.length) throw new Error('upsert requires onConflict')
        const targetSql = targets.map(identifier).join(', ')
        const updates = columns
          .filter((column) => !targets.includes(column))
          .map((column) => `${identifier(column)} = EXCLUDED.${identifier(column)}`)
        conflict = ` ON CONFLICT (${targetSql}) ${updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING'}`
      }
      const sql = `INSERT INTO ${tableName(table)} (${columns.map(identifier).join(', ')}) VALUES ${groups.join(', ')}${conflict}${returning ? ' RETURNING *' : ''}`
      const result = await exec(sql, values)
      return (returning ? result.rows : []) as never[]
    },

    async update(table, filters, body, { returning = true } = {}) {
      const columns = Object.keys(body)
      if (!columns.length) return []
      const values: unknown[] = columns.map((column) => body[column])
      const set = columns.map((column, index) => `${identifier(column)} = $${index + 1}`).join(', ')
      const where = whereClause(filters, values)
      if (!where) throw new Error('refusing unfiltered database update')
      const sql = `UPDATE ${tableName(table)} SET ${set}${where}${returning ? ' RETURNING *' : ''}`
      const result = await exec(sql, values)
      return (returning ? result.rows : []) as never[]
    },

    async remove(table, filters) {
      const values: unknown[] = []
      const where = whereClause(filters, values)
      if (!where) throw new Error('refusing unfiltered database delete')
      await exec(`DELETE FROM ${tableName(table)}${where}`, values)
    },
  }
  return db
}

// Minimal structural pool contract so tests inject fakes without pg types.
export interface PoolLike {
  query(sql: string, values?: unknown[]): Promise<QueryResultLike>
  connect(): Promise<{
    query(sql: string, values?: unknown[]): Promise<QueryResultLike>
    release(): void
  }>
  end(): Promise<void>
}

export interface CreatePostgresOptions {
  /** Injected pool (tests). When provided, close() will NOT end it. */
  pool?: PoolLike
  /** Pool size for the default pg Pool. */
  max?: number
}

export function createPostgres(config: Config, options: CreatePostgresOptions = {}): Database {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required')
  const pool: PoolLike =
    options.pool || (new Pool({ connectionString: config.databaseUrl, max: options.max || 10 }) as unknown as PoolLike)

  const db = makeApi((sql, values) => pool.query(sql, values))

  // Runs fn inside a single transaction. fn receives a Db bound to the
  // transaction's client, so a business write and its outbox enqueue commit
  // atomically (transactional outbox).
  db.tx = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const txApi = makeApi((sql, values) => client.query(sql, values))
      const result = await fn(txApi)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  return {
    db,
    async close() {
      if (!options.pool) await pool.end()
    },
  }
}
