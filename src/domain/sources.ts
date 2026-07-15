// wk_sources — original sources archived verbatim (CONTRACTS §1.2, §4).
//
// The idempotency anchor of the whole ingest pipeline lives here:
// content_hash = sha256(raw_content) and unique(space_id, content_hash) mean
// re-submitting identical content NEVER creates a second row. createSource
// reports the collision as `created: false` instead of throwing, because the
// right reaction differs by caller: HTTP ingest answers 409 already_ingested,
// the import path silently reuses the existing source.
//
// Every function takes an explicit spaceId — space scoping is non-negotiable
// and never ambient (CONTRACTS §4 convention).
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import { NotFoundError, ValidationError } from './errors.ts'

/** sha256 hex — the content-hash function for sources AND proposal input hashes. */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Normalize a pg timestamptz (Date in node-postgres) to an ISO-8601 string. */
export function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

// ---------------------------------------------------------------------------
// Keyset cursors, shared by the list endpoints (concepts imports these).
// Opaque by design: base64url("<part>|<part>") so clients can never build one
// by hand and depend on the internal sort — the format may change freely.
export function encodeCursor(...parts: string[]): string {
  return Buffer.from(parts.join('|')).toString('base64url')
}

export function decodeCursor(value: string, expectedParts: number): string[] {
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  const parts = decoded.split('|')
  if (parts.length !== expectedParts || parts.some((part) => !part)) {
    throw new ValidationError('cursor is invalid')
  }
  return parts
}

/** Clamp a caller-supplied page size into [1, max] with a default. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback
  if (!Number.isInteger(limit) || limit < 1) throw new ValidationError('limit must be a positive integer')
  return Math.min(limit, max)
}

// ---------------------------------------------------------------------------

export type SourceKind = 'markdown' | 'text' | 'url' | 'import'

export interface SourceSummary {
  id: string
  kind: SourceKind
  url: string | null
  title: string | null
  content_hash: string
  created_at: string
}

export interface Source extends SourceSummary {
  raw_content: string
  markdown: string
  metadata: Record<string, unknown>
}

interface SourceRow {
  id: string
  kind: SourceKind
  url: string | null
  title: string | null
  content_hash: string
  raw_content: string
  markdown: string
  metadata: Record<string, unknown>
  created_at: Date | string
}

function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    kind: row.kind,
    url: row.url,
    title: row.title,
    content_hash: row.content_hash,
    raw_content: row.raw_content,
    markdown: row.markdown,
    metadata: row.metadata,
    created_at: isoString(row.created_at),
  }
}

// zod at the boundary (house rule): domain functions are called by REST, MCP
// and the ingest worker — validating here means no transport can slip an
// unchecked shape into SQL.
const zCreateSourceArgs = z.object({
  kind: z.enum(['markdown', 'text', 'url', 'import']),
  url: z.url().optional(),
  title: z.string().max(500).optional(),
  raw: z.string().min(1),
  markdown: z.string().min(1),
  // What the source IS (meeting/article/note), distinct from `kind` (its
  // transport). Stored on metadata, not a column: it is an optional hint that
  // steers synthesis, not an identity or index key. Absent → not recorded.
  sourceKind: z.enum(['meeting', 'article', 'note']).optional(),
})

export type CreateSourceArgs = z.input<typeof zCreateSourceArgs>

/**
 * Archive a source. Idempotent on sha256(raw): a hash hit returns the
 * EXISTING row with `created: false` (HTTP layer answers 409 already_ingested
 * with that source_id). raw_content is never mutated after this insert.
 */
export async function createSource(
  db: Db,
  spaceId: string,
  args: CreateSourceArgs,
): Promise<{ source: Source; created: boolean }> {
  const input = zCreateSourceArgs.parse(args)
  const contentHash = sha256Hex(input.raw)

  // Fast path: the common re-ingest case answers from the unique index
  // without an exception. The insert below still handles the race.
  const existing = await db.select<SourceRow>('wk_sources', {
    space_id: `eq.${spaceId}`,
    content_hash: `eq.${contentHash}`,
    limit: 1,
  })
  if (existing[0]) return { source: toSource(existing[0]), created: false }

  try {
    const [row] = await db.insert<SourceRow>('wk_sources', {
      space_id: spaceId,
      content_hash: contentHash,
      kind: input.kind,
      url: input.url ?? null,
      title: input.title ?? null,
      raw_content: input.raw,
      markdown: input.markdown,
      metadata: JSON.stringify(input.sourceKind ? { source_kind: input.sourceKind } : {}),
    })
    return { source: toSource(row!), created: true }
  } catch (error) {
    // Two concurrent ingests of the same content: the loser hits the
    // unique(space_id, content_hash) index (23505) and converges on the
    // winner's row — the idempotency contract, not an error.
    if ((error as { code?: string }).code !== '23505') throw error
    const [winner] = await db.select<SourceRow>('wk_sources', {
      space_id: `eq.${spaceId}`,
      content_hash: `eq.${contentHash}`,
      limit: 1,
    })
    if (!winner) throw error
    return { source: toSource(winner), created: false }
  }
}

/**
 * List sources newest-first with keyset pagination (`before` walks backwards
 * in time — the natural direction for an archive). Summaries only: raw
 * content can be megabytes and belongs behind getSource.
 */
export async function listSources(
  db: Db,
  spaceId: string,
  args: { limit?: number; before?: string } = {},
): Promise<{ items: SourceSummary[]; next_before: string | null }> {
  const limit = clampLimit(args.limit, 50, 200)
  const values: unknown[] = [spaceId]
  let keyset = ''
  if (args.before) {
    const [id] = decodeCursor(args.before, 1)
    values.push(id)
    // The cursor carries ONLY the boundary row's id; its created_at is
    // re-read in SQL. WHY: serializing the timestamp through JS would
    // truncate Postgres's microsecond timestamptz to Date's milliseconds,
    // making the row-value comparison strictly smaller than the real
    // boundary — every row sharing the boundary's millisecond (a burst
    // insert, e.g. a bundle import) would become unreachable on any page.
    // Row-value comparison keeps the keyset correct when two sources share a
    // created_at (id DESC is the tiebreak, mirroring the ORDER BY). A cursor
    // whose row vanished compares against NULL and yields an empty page —
    // acceptable for an append-only archive.
    keyset = ' AND (created_at, id) < (SELECT created_at, id FROM wk_sources WHERE id = $2::uuid)'
  }
  values.push(limit + 1)
  const { rows } = await db.query<SourceRow>(
    `SELECT id, kind, url, title, content_hash, created_at
       FROM wk_sources
      WHERE space_id = $1${keyset}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  )
  // limit+1 over-fetch: the presence of an extra row IS the has-more signal,
  // so no COUNT(*) query is ever needed.
  const page = rows.slice(0, limit)
  const items = page.map((row) => ({
    id: row.id,
    kind: row.kind,
    url: row.url,
    title: row.title,
    content_hash: row.content_hash,
    created_at: isoString(row.created_at),
  }))
  const last = page.at(-1)
  const nextBefore = rows.length > limit && last ? encodeCursor(last.id) : null
  return { items, next_before: nextBefore }
}

/** Full source (raw + normalized markdown). Space-scoped: a foreign id 404s. */
export async function getSource(db: Db, spaceId: string, args: { id: string }): Promise<Source> {
  const [row] = await db.select<SourceRow>('wk_sources', {
    id: `eq.${args.id}`,
    space_id: `eq.${spaceId}`,
    limit: 1,
  })
  if (!row) throw new NotFoundError(`source ${args.id} not found`)
  return toSource(row)
}
