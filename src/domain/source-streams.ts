// wk_source_streams — the connector-facing source-sync contract (migration
// 0019). A stream is the MUTABLE identity of one external document
// (external_source_id, e.g. "gdrive:file123"); every version the connector
// pushes lands as an immutable wk_sources row, and the stream's head pointer
// carries current truth.
//
// Invariants:
//   * wk_sources stays append-only — this module's only UPDATEs touch
//     wk_source_streams (head pointer, latest_version, tombstone).
//   * Content-hash dedup is untouched: a REVERT (v3 byte-identical to v1)
//     moves the head pointer back to the old row; per-row version columns
//     record the version under which content was FIRST observed.
//   * A tombstone is a soft flag; a later push resurrects the stream (the
//     connector says the document exists again). Cited archived bytes remain
//     citable evidence forever (wk_citations RESTRICT).
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import { ConflictError, NotFoundError } from './errors.ts'
import { clampLimit, createSource, isoString, type CreateSourceArgs, type Source } from './sources.ts'

export interface SourceStream {
  id: string
  external_source_id: string
  latest_source_id: string | null
  latest_version: string | null
  latest_observed_at: string | null
  metadata: Record<string, unknown>
  deleted_at: string | null
  created_at: string
  updated_at: string
}

interface StreamRow {
  id: string
  external_source_id: string
  latest_source_id: string | null
  latest_version: string | null
  latest_observed_at: Date | string | null
  metadata: Record<string, unknown>
  deleted_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

function toStream(row: StreamRow): SourceStream {
  return {
    id: row.id,
    external_source_id: row.external_source_id,
    latest_source_id: row.latest_source_id,
    latest_version: row.latest_version,
    latest_observed_at: row.latest_observed_at === null ? null : isoString(row.latest_observed_at),
    metadata: row.metadata,
    deleted_at: row.deleted_at === null ? null : isoString(row.deleted_at),
    created_at: isoString(row.created_at),
    updated_at: isoString(row.updated_at),
  }
}

const zRecordArgs = z.object({
  externalSourceId: z.string().min(1).max(500),
  sourceVersion: z.string().min(1).max(200).nullable().default(null),
  observedAt: z.iso.datetime().optional(),
  effectiveAt: z.iso.datetime().optional(),
})

export type RecordStreamVersionArgs = z.input<typeof zRecordArgs> & { source: CreateSourceArgs }

export type StreamOutcome = 'new_version' | 'unchanged' | 'reverted'

/**
 * Record one connector push in ONE transaction: lock-or-create the stream
 * (FOR UPDATE serializes concurrent pushes per external id), archive the
 * content through the normal createSource dedup path (write-once version
 * columns set at insert), enforce the version contract, then advance the
 * head pointer. A push to a tombstoned stream resurrects it.
 *
 * Throws ConflictError 'sync_version_conflict' when the connector re-uses a
 * version marker for DIFFERENT content — a connector bug that must be loud,
 * not a silent fork.
 */
export async function recordStreamVersion(
  db: Db,
  spaceId: string,
  args: RecordStreamVersionArgs,
): Promise<{ stream: SourceStream; source: Source; created: boolean; outcome: StreamOutcome }> {
  const input = zRecordArgs.parse(args)
  return db.tx(async (tx) => {
    let [row] = (
      await tx.query<StreamRow>(
        `SELECT * FROM wk_source_streams WHERE space_id = $1 AND external_source_id = $2 FOR UPDATE`,
        [spaceId, input.externalSourceId],
      )
    ).rows
    if (!row) {
      try {
        const [inserted] = await tx.insert<StreamRow>('wk_source_streams', {
          space_id: spaceId,
          external_source_id: input.externalSourceId,
        })
        row = inserted!
      } catch (error) {
        // Concurrent first-push race: converge on the winner's stream row.
        if ((error as { code?: string }).code !== '23505') throw error
        const { rows } = await tx.query<StreamRow>(
          `SELECT * FROM wk_source_streams WHERE space_id = $1 AND external_source_id = $2 FOR UPDATE`,
          [spaceId, input.externalSourceId],
        )
        row = rows[0]!
      }
    }

    const { source, created } = await createSource(tx, spaceId, {
      ...args.source,
      streamId: row.id,
      sourceVersion: input.sourceVersion ?? undefined,
      observedAt: input.observedAt,
      effectiveAt: input.effectiveAt,
      // Points at the PREVIOUS head; only meaningful (and only persisted) on
      // the insert path — a dedup hit keeps the existing row untouched.
      supersedesSourceId: row.latest_source_id ?? undefined,
    })

    // Version contract: the same marker must always mean the same bytes.
    if (
      input.sourceVersion !== null &&
      row.latest_version === input.sourceVersion &&
      row.latest_source_id !== null &&
      row.latest_source_id !== source.id
    ) {
      throw new ConflictError(
        'sync_version_conflict',
        `source_version '${input.sourceVersion}' of ${input.externalSourceId} was already recorded with different content`,
        { nextBestActions: ['bump source_version for changed content — versions are immutable markers'] },
      )
    }

    const outcome: StreamOutcome = created
      ? 'new_version'
      : row.latest_source_id === source.id
        ? 'unchanged'
        : 'reverted'

    const [updated] = await tx.update<StreamRow>(
      'wk_source_streams',
      { id: `eq.${row.id}` },
      {
        latest_source_id: source.id,
        latest_version: input.sourceVersion,
        latest_observed_at: input.observedAt ?? new Date(),
        // Any push resurrects a tombstoned stream.
        deleted_at: null,
      },
    )
    return { stream: toStream(updated!), source, created, outcome }
  })
}

/** Connector polling surface: streams by external id, newest-updated first. */
export async function listStreams(
  db: Db,
  spaceId: string,
  args: { external_source_id?: string; include_deleted?: boolean; limit?: number } = {},
): Promise<{ items: SourceStream[] }> {
  const limit = clampLimit(args.limit, 50, 200)
  const filters: Record<string, unknown> = { space_id: `eq.${spaceId}`, order: 'updated_at.desc', limit }
  if (args.external_source_id) filters.external_source_id = `eq.${args.external_source_id}`
  if (!args.include_deleted) filters.deleted_at = 'is.null'
  const rows = await db.select<StreamRow>('wk_source_streams', filters)
  return { items: rows.map(toStream) }
}

/**
 * Soft-delete a stream (idempotent): the connector reports the upstream
 * document is gone. Never touches wk_sources — archived bytes stay citable;
 * the lint rule 'tombstoned-sources' surfaces affected visible claims for a
 * human to act on. Emits wikikit.source.tombstoned in the same transaction.
 */
export async function tombstoneStream(
  db: Db,
  spaceId: string,
  args: { externalSourceId: string },
): Promise<{ stream_id: string; already_tombstoned: boolean }> {
  return db.tx(async (tx) => {
    const { rows } = await tx.query<StreamRow>(
      `SELECT * FROM wk_source_streams WHERE space_id = $1 AND external_source_id = $2 FOR UPDATE`,
      [spaceId, args.externalSourceId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError(`source stream '${args.externalSourceId}' not found`)
    if (row.deleted_at !== null) return { stream_id: row.id, already_tombstoned: true }
    await tx.update('wk_source_streams', { id: `eq.${row.id}` }, { deleted_at: new Date() }, { returning: false })
    const [space] = await tx.select<{ slug: string }>('wk_spaces', { id: `eq.${spaceId}`, limit: 1 })
    await tx.emitEvent(spaceId, 'wikikit.source.tombstoned', {
      space: space?.slug ?? '',
      external_source_id: row.external_source_id,
      stream_id: row.id,
      source_id: row.latest_source_id,
    })
    return { stream_id: row.id, already_tombstoned: false }
  })
}
