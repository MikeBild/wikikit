// wk_charter_revisions — the per-space Charter as a versioned virtual document.
//
// The Charter is WikiKit's answer to llm-wiki's CLAUDE.md: human-owned free
// markdown that (a) steers synthesis + classification and (b) renders as a
// virtual document = the authored text PLUS a KB-derived overview.
//
// Two ownership rules everything here relies on:
//   1. The AUTHORED charter is human-owned configuration, not synthesized
//      knowledge. Writing it is a DIRECT, auto-versioned admin edit — no review
//      gate. Each write supersedes the old `current` row and inserts rev+1 as
//      the new `current` (the `latest` pointer).
//   2. The DERIVED overview is read-only projection. When a human edits the
//      overview block and writes the document back, that edit is routed through
//      the SAME review gate as any knowledge change (enqueued as an ingest →
//      classify → synthesize → ChangeProposal), never applied directly. This is
//      the bidirectional half: document → internal structure, garantie-erhaltend.
import type { Db } from '../db/postgres.ts'
import { NotFoundError, ValidationError } from './errors.ts'
import { getConceptIndex } from './concepts.ts'
import { inlineText } from '../export/markdown.ts'
import { isoString } from './sources.ts'

/** Hard cap on the authored charter markdown — it flows into classify + synthesize prompts. */
export const CHARTER_MAX_CHARS = 8000

// Section markers delimit the two halves of the virtual document so a full
// round-trip write can tell authored text from the derived overview. Kept as
// HTML comments so they render invisibly in any markdown viewer.
export const CHARTER_OPEN = '<!-- wikikit:charter -->'
export const CHARTER_CLOSE = '<!-- /wikikit:charter -->'
export const OVERVIEW_OPEN = '<!-- wikikit:overview -->'
export const OVERVIEW_CLOSE = '<!-- /wikikit:overview -->'

export interface CharterOverview {
  concepts: number
  decisions: number
  sources: number
  /** Compact concept index (slug + summary) — the "…of the KB" half. */
  index: { slug: string; summary: string }[]
}

/**
 * Full charter read. `rev`/`markdown`/`updated_at` describe the latest authored
 * revision (rev null + empty markdown when a space has no charter yet, or after
 * a delete). `overview` is always freshly derived from current knowledge.
 */
export interface CharterDetail {
  space: string
  space_name: string
  rev: number | null
  markdown: string
  updated_at: string | null
  overview: CharterOverview
}

export interface CharterRevisionSummary {
  rev: number
  status: 'current' | 'superseded'
  created_by: string | null
  created_at: string
  agent_meta: Record<string, unknown>
}

interface SpaceRow {
  id: string
  slug: string
  name: string
}

interface CharterRow {
  id: string
  rev: number
  markdown: string
  created_at: Date | string
}

async function loadSpace(db: Db, spaceId: string): Promise<SpaceRow> {
  const [space] = await db.select<SpaceRow>('wk_spaces', { id: `eq.${spaceId}`, limit: 1 })
  if (!space) throw new NotFoundError('space not found')
  return space
}

/** The single `current` charter row for a space, or null when none is set. */
async function currentRevision(db: Db, spaceId: string): Promise<CharterRow | null> {
  const [row] = await db.select<CharterRow>('wk_charter_revisions', {
    space_id: `eq.${spaceId}`,
    status: 'eq.current',
    limit: 1,
  })
  return row ?? null
}

/** Derive the compact KB overview: counts + concept index (readable concepts only). */
async function loadOverview(db: Db, spaceId: string): Promise<CharterOverview> {
  const index = await getConceptIndex(db, spaceId)
  const decisionsRes = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM wk_decisions WHERE space_id = $1 AND status = 'active'`,
    [spaceId],
  )
  const sourcesRes = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM wk_sources WHERE space_id = $1`,
    [spaceId],
  )
  const decisions = decisionsRes.rows[0]?.count ?? 0
  const sources = sourcesRes.rows[0]?.count ?? 0
  return {
    concepts: index.length,
    decisions,
    sources,
    index: index.map((entry) => ({ slug: entry.slug, summary: entry.summary || entry.title })),
  }
}

/**
 * Load the charter document. `rev` selects a specific historical revision (for
 * `?rev=N` reads); omitted → the `latest` (current) authored revision. The
 * overview always reflects CURRENT knowledge regardless of which authored
 * revision is shown.
 */
export async function getCharter(db: Db, spaceId: string, opts: { rev?: number } = {}): Promise<CharterDetail> {
  const space = await loadSpace(db, spaceId)
  const row =
    opts.rev === undefined
      ? await currentRevision(db, spaceId)
      : ((
          await db.select<CharterRow>('wk_charter_revisions', {
            space_id: `eq.${spaceId}`,
            rev: `eq.${opts.rev}`,
            limit: 1,
          })
        )[0] ?? null)
  if (opts.rev !== undefined && !row) throw new NotFoundError(`charter revision ${opts.rev} not found`)
  const overview = await loadOverview(db, spaceId)
  return {
    space: space.slug,
    space_name: space.name,
    rev: row?.rev ?? null,
    markdown: row?.markdown ?? '',
    updated_at: row ? isoString(row.created_at) : null,
    overview,
  }
}

/** The overview block body (between the markers) — a pure function so the write
 * path can detect a human edit by comparing against a freshly rendered block. */
export function renderOverview(overview: CharterOverview): string {
  const lines: string[] = [
    `- Concepts: ${overview.concepts}`,
    `- Decisions: ${overview.decisions}`,
    `- Sources: ${overview.sources}`,
  ]
  if (overview.index.length) {
    lines.push('', '### Concept index', '')
    for (const entry of overview.index) lines.push(`- [[${entry.slug}]] — ${inlineText(entry.summary)}`)
  }
  return lines.join('\n')
}

/**
 * The virtual document: `# <space> — Charter`, the authored markdown between the
 * charter markers, then the derived overview between the overview markers. Pure
 * function of the detail (mirrors renderProposalMarkdown / renderIndex) so the
 * `text/markdown` view and the JSON view can never disagree.
 */
export function renderCharter(detail: CharterDetail): string {
  const authored = detail.markdown.trim() || '_No charter written yet. Edit this section to steer synthesis._'
  return [
    `# ${inlineText(detail.space_name)} — Charter`,
    '',
    CHARTER_OPEN,
    authored,
    CHARTER_CLOSE,
    '',
    '## Overview (derived)',
    '',
    OVERVIEW_OPEN,
    renderOverview(detail.overview),
    OVERVIEW_CLOSE,
    '',
  ].join('\n')
}

/** Wire projection shared by REST + MCP so the two transports cannot drift. */
export function toCharterResponse(detail: CharterDetail): Record<string, unknown> {
  return {
    space: detail.space,
    rev: detail.rev,
    markdown: detail.markdown,
    updated_at: detail.updated_at,
    overview: detail.overview,
    document: renderCharter(detail),
  }
}

function between(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  if (start === -1) return null
  const from = start + open.length
  const end = text.indexOf(close, from)
  if (end === -1) return null
  return text.slice(from, end)
}

export interface ParsedCharterDocument {
  authored: string
  /** The overview block the caller submitted, when the full document was written back. */
  overview: string | null
}

/**
 * Split a written document into its authored + overview halves. A body WITH the
 * charter markers has its authored text extracted from between them (a full
 * round-trip write); a body WITHOUT markers is taken wholesale as the authored
 * charter (writing just the charter markdown directly).
 */
export function parseCharterDocument(body: string): ParsedCharterDocument {
  const marked = between(body, CHARTER_OPEN, CHARTER_CLOSE)
  const authored = (marked ?? body).trim()
  const overview = between(body, OVERVIEW_OPEN, OVERVIEW_CLOSE)
  return { authored, overview: overview === null ? null : overview.trim() }
}

export interface WriteCharterResult {
  rev: number | null
  /** Ingest jobs opened for an edited overview block (the review-gate route). */
  ingest_ids: string[]
}

export interface WriteCharterDeps {
  /** Route an edited overview block through the review gate; returns an ingest id (or null). */
  enqueueOverviewEdit?: (markdown: string) => Promise<string | null>
}

/**
 * Bidirectional write. The authored half writes DIRECTLY as a new versioned
 * revision (human-owned config); the overview half, when edited, is routed
 * through the review gate via `enqueueOverviewEdit` (never applied directly).
 * A no-op authored write does not create a revision.
 */
export async function writeCharter(
  db: Db,
  spaceId: string,
  body: string,
  opts: { createdBy?: string; agentMeta?: Record<string, unknown> } = {},
  deps: WriteCharterDeps = {},
): Promise<WriteCharterResult> {
  const space = await loadSpace(db, spaceId)
  const parsed = parseCharterDocument(body)
  if (parsed.authored.length > CHARTER_MAX_CHARS) {
    throw new ValidationError(`charter exceeds ${CHARTER_MAX_CHARS} characters (got ${parsed.authored.length})`)
  }

  const ingest_ids: string[] = []
  // Overview edit → review gate. Compared against the overview we WOULD render
  // for current knowledge: unchanged means the human never touched it.
  if (parsed.overview !== null && deps.enqueueOverviewEdit) {
    const expected = renderOverview(await loadOverview(db, spaceId)).trim()
    if (parsed.overview !== expected) {
      const id = await deps.enqueueOverviewEdit(parsed.overview)
      if (id) ingest_ids.push(id)
    }
  }

  const current = await currentRevision(db, spaceId)
  // No-op authored write: nothing to version (but an overview edit may still
  // have opened an ingest above).
  if ((current?.markdown ?? '').trim() === parsed.authored) {
    return { rev: current?.rev ?? null, ingest_ids }
  }

  const rev = await db.tx(async (tx) => {
    const nextRes = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(rev), 0) + 1 AS next FROM wk_charter_revisions WHERE space_id = $1`,
      [spaceId],
    )
    const next = nextRes.rows[0]?.next ?? 1
    if (current) {
      await tx.update(
        'wk_charter_revisions',
        { id: `eq.${current.id}` },
        { status: 'superseded' },
        { returning: false },
      )
    }
    await tx.insert(
      'wk_charter_revisions',
      {
        space_id: spaceId,
        rev: next,
        status: 'current',
        markdown: parsed.authored,
        base_revision_id: current?.id ?? null,
        created_by: opts.createdBy ?? null,
        agent_meta: JSON.stringify(opts.agentMeta ?? {}),
      },
      { returning: false },
    )
    return next
  })
  void space
  return { rev, ingest_ids }
}

/**
 * Delete the charter: supersede the current revision with no replacement (the
 * space reverts to no charter). Idempotent — a space with no charter is a no-op.
 * History is retained.
 */
export async function deleteCharter(db: Db, spaceId: string): Promise<void> {
  await loadSpace(db, spaceId)
  const current = await currentRevision(db, spaceId)
  if (!current) return
  await db.update('wk_charter_revisions', { id: `eq.${current.id}` }, { status: 'superseded' }, { returning: false })
}

/** Full revision history, newest first — the document's version list. */
export async function getCharterHistory(db: Db, spaceId: string): Promise<CharterRevisionSummary[]> {
  await loadSpace(db, spaceId)
  const rows = await db.select<{
    rev: number
    status: 'current' | 'superseded'
    created_by: string | null
    created_at: Date | string
    agent_meta: Record<string, unknown>
  }>('wk_charter_revisions', { space_id: `eq.${spaceId}`, order: 'rev.desc' })
  return rows.map((row) => ({
    rev: row.rev,
    status: row.status,
    created_by: row.created_by,
    created_at: isoString(row.created_at),
    agent_meta: row.agent_meta ?? {},
  }))
}

/** The latest authored charter markdown (for prompt steering); '' when none. */
export async function latestCharterMarkdown(db: Db, spaceId: string): Promise<string> {
  const current = await currentRevision(db, spaceId)
  return (current?.markdown ?? '').trim()
}
