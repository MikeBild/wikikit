// wk_audit_events — the audit.v1 trail (Cockpit convention §15.5).
//
// The four records this product already kept (page revisions, guideline
// revisions, decisions, agent runs) each answer "what does this thing look
// like now, and what did it look like before". None of them answers the two
// questions an audit trail exists for: WHO, and WHAT WAS REFUSED. This module
// is the only write path to the answer.
//
// Three rules live here rather than at the call sites, because a rule that
// lives at call sites is a rule with as many versions as callers:
//
//   1. THE ACTOR IS DERIVED FROM THE CREDENTIAL, never passed in. A caller
//      cannot name itself: `actorFromPrincipal` reads the authenticated
//      Principal, and an unauthenticated request is recorded as 'anonymous',
//      not as a guess.
//   2. PAYLOADS ARE REDACTED BEFORE THEY LEAVE THIS PROCESS. Anything whose
//      key looks like a credential is replaced by a marker, long strings are
//      truncated, and the whole payload is size-capped. An audit row that
//      leaks a token is a worse leak than no row, because it is retained
//      forever by design.
//   3. THE APPEND MUST RUN ON A TRANSACTION-BOUND Db. Passing the pool makes
//      the entry independent of the change it describes, which is precisely
//      the failure mode §15.5 forbids. `auditedTx` is the shape that cannot
//      get this wrong.
import type { Db } from '../db/postgres.ts'
import { ValidationError } from './errors.ts'
import type { Principal } from '../http/auth.ts'

export const AUDIT_RESULTS = ['success', 'denied', 'error', 'cancelled'] as const
export type AuditResult = (typeof AUDIT_RESULTS)[number]

export const AUDIT_TRANSPORTS = [
  'http',
  'mcp',
  'a2a',
  'cockpit',
  'cli',
  'worker',
  'webhook',
  'channel',
  'tick',
  'system',
] as const
export type AuditTransport = (typeof AUDIT_TRANSPORTS)[number]

export const AUDIT_ACTOR_KINDS = ['identity', 'api_key', 'operator_session', 'system', 'anonymous'] as const
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number]

export interface AuditActor {
  kind: AuditActorKind
  /** Stable id of the principal. Null only for 'system' and 'anonymous'. */
  id: string | null
  /** Human-readable name where the credential carries one — never inferred. */
  label: string | null
}

export const SYSTEM_ACTOR: AuditActor = { kind: 'system', id: null, label: null }
export const ANONYMOUS_ACTOR: AuditActor = { kind: 'anonymous', id: null, label: null }

/**
 * The trustworthy half of the contract. `Principal.keyId` is minted by the
 * authenticator and its prefix IS the credential class (auth.ts mints
 * `oauth:<id>` for an SSO identity, oauth/server.ts mints `session:<id>` for a
 * cockpit browser session, everything else is a wk_api_keys row id or the
 * literal 'bootstrap'). Reading the class off the id keeps the derivation in
 * one place instead of asking every call site what it thinks it is.
 */
export function actorFromPrincipal(principal: Principal | null | undefined): AuditActor {
  if (!principal) return ANONYMOUS_ACTOR
  if (principal.keyId.startsWith('session:')) {
    return { kind: 'operator_session', id: principal.keyId.slice('session:'.length), label: principal.name || null }
  }
  if (principal.keyId.startsWith('oauth:')) {
    return { kind: 'identity', id: principal.keyId.slice('oauth:'.length), label: principal.name || null }
  }
  return { kind: 'api_key', id: principal.keyId, label: principal.name || null }
}

/** A cockpit session and an API key both arrive over HTTP; §15 separates them. */
export function transportForPrincipal(principal: Principal | null | undefined): AuditTransport {
  return principal?.keyId.startsWith('session:') ? 'cockpit' : 'http'
}

export interface AuditEventInput {
  action: string
  resourceType: string
  resourceId?: string | null
  resourceRevision?: string | number | null
  result: AuditResult
  transport: AuditTransport
  actor: AuditActor
  spaceId?: string | null
  requestId?: string | null
  traceId?: string | null
  occurredAt?: string | Date | null
  before?: unknown
  after?: unknown
  metadata?: Record<string, unknown> | null
}

export interface AuditReceipt {
  id: string
  seq: number
  sha256: string
  prev_sha256: string
}

const ACTION_PATTERN = /^[a-z][a-z0-9_.]{0,79}$/
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

// Key names that must never reach a row that is retained forever. Matched on
// the key, not the value: a value-based scanner produces false negatives on
// every credential format nobody thought of.
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|api[-_]?key|authorization|credential|cookie|private[-_]?key|signature|bearer|salt|nonce)/i
const REDACTED = '[redacted]'
const MAX_STRING = 2_000
const MAX_DEPTH = 6
const MAX_PAYLOAD_BYTES = 32_000

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= MAX_DEPTH) return '[depth-capped]'
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitizeValue(entry, depth + 1))
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : sanitizeValue(entry, depth + 1)
    }
    return out
  }
  return String(value)
}

/** Exported for the tests that pin rule 2 — redaction is a contract, not a detail. */
export function sanitizeAuditPayload(value: unknown): unknown {
  if (value === undefined || value === null) return null
  const cleaned = sanitizeValue(value, 0)
  const encoded = JSON.stringify(cleaned)
  if (encoded && encoded.length > MAX_PAYLOAD_BYTES) {
    return { _dropped: 'payload exceeded the audit size cap', bytes: encoded.length }
  }
  return cleaned
}

function isoInstant(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new ValidationError('audit occurred_at is not a valid instant')
  return date.toISOString()
}

/**
 * Append one event. Runs `wk_append_audit_event`, which takes the chain-head
 * lock, derives seq and sha256 from the predecessor, inserts and advances the
 * head — inside whatever transaction `db` is bound to.
 */
export async function appendAuditEvent(db: Db, event: AuditEventInput): Promise<AuditReceipt> {
  if (!ACTION_PATTERN.test(event.action)) throw new ValidationError(`invalid audit action: ${event.action}`)
  if (!RESOURCE_TYPE_PATTERN.test(event.resourceType)) {
    throw new ValidationError(`invalid audit resource_type: ${event.resourceType}`)
  }
  if (!AUDIT_RESULTS.includes(event.result)) throw new ValidationError(`invalid audit result: ${event.result}`)
  if (!AUDIT_TRANSPORTS.includes(event.transport))
    throw new ValidationError(`invalid audit transport: ${event.transport}`)
  if (!AUDIT_ACTOR_KINDS.includes(event.actor.kind)) {
    throw new ValidationError(`invalid audit actor kind: ${event.actor.kind}`)
  }

  const payload = {
    schema_version: 'audit.v1',
    occurred_at: isoInstant(event.occurredAt) ?? new Date().toISOString(),
    space_id: event.spaceId ?? null,
    actor_kind: event.actor.kind,
    actor_id: event.actor.id ?? null,
    actor_label: event.actor.label ?? null,
    action: event.action,
    resource_type: event.resourceType,
    resource_id: event.resourceId == null ? null : String(event.resourceId),
    resource_revision: event.resourceRevision == null ? null : String(event.resourceRevision),
    result: event.result,
    transport: event.transport,
    request_id: event.requestId ?? null,
    trace_id: event.traceId ?? null,
    before: sanitizeAuditPayload(event.before),
    after: sanitizeAuditPayload(event.after),
    metadata: (sanitizeAuditPayload(event.metadata) as Record<string, unknown> | null) ?? {},
  }
  const [receipt] = await db.call<AuditReceipt>('wk_append_audit_event', [JSON.stringify(payload)])
  return { ...receipt!, seq: Number(receipt!.seq) }
}

/**
 * The shape the coupling rule cannot escape: the change and its entry share
 * one transaction. `fn` returns the value AND the event describing it, so a
 * caller physically cannot commit the change without producing an entry — and
 * if the append throws (a broken chain, a revoked privilege, a bad action
 * name), the change rolls back with it.
 */
export async function auditedTx<T>(db: Db, fn: (tx: Db) => Promise<{ value: T; event: AuditEventInput }>): Promise<T> {
  return await db.tx(async (tx) => {
    const { value, event } = await fn(tx)
    await appendAuditEvent(tx, event)
    return value
  })
}

/**
 * Record an attempt that did NOT change anything (a refusal, a validation
 * error, a cancel). Its own transaction on purpose: there is no business write
 * to couple it to, and a failed append must not swallow the original error —
 * so the caller decides what to do with a throw from here.
 */
export async function appendAuditFailure(db: Db, event: AuditEventInput): Promise<AuditReceipt> {
  if (event.result === 'success') throw new ValidationError('appendAuditFailure records non-success results only')
  return await appendAuditEvent(db, event)
}

// ---------------------------------------------------------------------------
// Reading

export interface AuditEvent {
  id: string
  seq: number
  schema_version: string
  occurred_at: string
  space_id: string | null
  actor_kind: AuditActorKind
  actor_id: string | null
  actor_label: string | null
  action: string
  resource_type: string
  resource_id: string | null
  resource_revision: string | null
  result: AuditResult
  transport: AuditTransport
  request_id: string | null
  trace_id: string | null
  before: unknown
  after: unknown
  metadata: Record<string, unknown>
  prev_sha256: string
  sha256: string
}

export interface AuditPage {
  items: AuditEvent[]
  page: {
    next_cursor: string | null
    has_more: boolean
    /** Rows matching the filter, counted up to the cap below. */
    total: number
    /** False when the count hit the cap — §2 forbids presenting an estimate as a fact. */
    total_exact: boolean
  }
}

export interface ListAuditArgs {
  spaceId?: string | null
  /** Restricts to these wikis. Empty array means "nothing is visible". */
  visibleSpaceIds?: readonly string[] | null
  action?: string
  resourceType?: string
  resourceId?: string
  actorId?: string
  actorKind?: AuditActorKind
  result?: AuditResult
  transport?: AuditTransport
  requestId?: string
  traceId?: string
  from?: string
  to?: string
  limit?: number
  cursor?: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
// Counting every row of a trail that never expires is a table scan that gets
// slower every day. The cap keeps the count bounded and `total_exact` keeps
// the answer honest once it bites.
const COUNT_CAP = 5_000

function encodeSeqCursor(seq: number): string {
  return Buffer.from(`seq:${seq}`).toString('base64url')
}

function decodeSeqCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const match = /^seq:(\d+)$/.exec(decoded)
  if (!match) throw new ValidationError('cursor is invalid')
  return Number(match[1])
}

function auditFilters(args: ListAuditArgs, values: unknown[]): string {
  const clauses: string[] = []
  const eq = (column: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    values.push(value)
    clauses.push(`${column} = $${values.length}`)
  }
  eq('space_id', args.spaceId ? args.spaceId : undefined)
  eq('action', args.action)
  eq('resource_type', args.resourceType)
  eq('resource_id', args.resourceId)
  eq('actor_id', args.actorId)
  eq('actor_kind', args.actorKind)
  eq('result', args.result)
  eq('transport', args.transport)
  eq('request_id', args.requestId)
  eq('trace_id', args.traceId)
  if (args.from) {
    values.push(new Date(args.from).toISOString())
    clauses.push(`occurred_at >= $${values.length}`)
  }
  if (args.to) {
    values.push(new Date(args.to).toISOString())
    clauses.push(`occurred_at <= $${values.length}`)
  }
  if (args.visibleSpaceIds) {
    if (!args.visibleSpaceIds.length) clauses.push('FALSE')
    else {
      // Deployment-wide events (space_id IS NULL) belong to whoever may read
      // the trail at all — dropping them would hide exactly the rows that
      // describe the installation rather than one wiki.
      values.push(args.visibleSpaceIds as unknown)
      clauses.push(`(space_id IS NULL OR space_id = ANY($${values.length}::uuid[]))`)
    }
  }
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
}

const SELECT_COLUMNS = `id, seq, schema_version, occurred_at, space_id, actor_kind, actor_id, actor_label,
  action, resource_type, resource_id, resource_revision, result, transport, request_id, trace_id,
  before, after, metadata, prev_sha256, sha256`

interface AuditRow extends Omit<AuditEvent, 'seq' | 'occurred_at'> {
  seq: string | number
  occurred_at: Date | string
}

function toEvent(row: AuditRow): AuditEvent {
  return {
    ...row,
    seq: Number(row.seq),
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    metadata: row.metadata ?? {},
  }
}

/**
 * Newest first, keyset on `seq`. `seq` is unique, monotone and assigned under
 * the chain lock, so it is the one column in this product that gives a stable
 * total order without a tiebreaker — a timestamp keyset would need one.
 */
export async function listAuditEvents(db: Db, args: ListAuditArgs = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const values: unknown[] = []
  let where = auditFilters(args, values)
  if (args.cursor) {
    values.push(decodeSeqCursor(args.cursor))
    const clause = `seq < $${values.length}`
    where = where ? `${where} AND ${clause}` : ` WHERE ${clause}`
  }
  values.push(limit + 1)
  const { rows } = await db.query<AuditRow>(
    `SELECT ${SELECT_COLUMNS} FROM wk_audit_events${where} ORDER BY seq DESC LIMIT $${values.length}`,
    values,
  )
  const items = rows.slice(0, limit).map(toEvent)
  const hasMore = rows.length > limit
  const last = items.at(-1)

  // The count re-runs the filter WITHOUT the cursor clause: `total` is the size
  // of the result set, not of the remainder.
  const countValues: unknown[] = []
  const countWhere = auditFilters(args, countValues)
  countValues.push(COUNT_CAP + 1)
  const counted = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (SELECT 1 FROM wk_audit_events${countWhere} LIMIT $${countValues.length}) capped`,
    countValues,
  )
  const rawTotal = Number(counted.rows[0]?.n ?? 0)

  return {
    items,
    page: {
      next_cursor: hasMore && last ? encodeSeqCursor(last.seq) : null,
      has_more: hasMore,
      total: Math.min(rawTotal, COUNT_CAP),
      total_exact: rawTotal <= COUNT_CAP,
    },
  }
}
