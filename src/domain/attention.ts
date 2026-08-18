import type { Db } from '../db/postgres.ts'
import { isoString, summarizeSource } from './sources.ts'
import { NotFoundError, ValidationError } from './errors.ts'

export type AttentionKind = 'proposal' | 'triage' | 'output'
export type AttentionState = 'open' | 'deferred' | 'discarded' | 'decided'

export interface AttentionOrigin {
  kind: 'source' | 'capture' | 'output'
  label: string
  href: string
  provenance: 'external' | 'generated' | null
}

export interface AttentionTarget {
  kind: 'page' | 'wiki' | 'unspecified'
  label: string
  href: string | null
  change: 'create' | 'update' | 'choose'
}

export interface AttentionItem {
  key: string
  kind: AttentionKind
  state: AttentionState
  title: string
  summary: string
  effect: string
  created_at: string
  remind_at: string | null
  note: string | null
  origins: AttentionOrigin[]
  targets: AttentionTarget[]
  available_actions: string[]
  previous_rejection: { proposal_id: string; reviewed_at: string; note: string | null } | null
}

export interface AttentionPage {
  generated_at: string
  counts: {
    open: number
    overdue: number
    oldest_days: number | null
    by_kind: Record<AttentionKind, number>
  }
  items: AttentionItem[]
  next_cursor: string | null
  recent_activity: AttentionItem[]
}

interface OverlayRow {
  item_key: string
  kind: AttentionKind
  state: 'open' | 'deferred' | 'discarded'
  remind_at: Date | string | null
  note: string | null
  snapshot: AttentionItem | string
  updated_at: Date | string
}

function daysOld(value: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(value).getTime()) / 86_400_000))
}

interface ProposalRow {
  id: string
  title: string
  summary: string
  status?: string
  source_ids?: string[] | null
}

async function proposalContexts(
  db: Db,
  spaceId: string,
  proposals: readonly ProposalRow[],
): Promise<{ origins: Map<string, AttentionOrigin[]>; targets: Map<string, AttentionTarget[]> }> {
  const ids = proposals.map((proposal) => proposal.id)
  const origins = new Map<string, AttentionOrigin[]>(ids.map((id) => [id, []]))
  const targets = new Map<string, AttentionTarget[]>(ids.map((id) => [id, []]))
  if (!ids.length) return { origins, targets }

  const sourceIds = [...new Set(proposals.flatMap((proposal) => proposal.source_ids ?? []))]
  const sources = sourceIds.length
    ? await db.query<{ id: string; title: string; metadata: Record<string, unknown> | string }>(
        `SELECT id, title, metadata FROM wk_sources WHERE space_id = $1 AND id = ANY($2::uuid[])`,
        [spaceId, sourceIds],
      )
    : { rows: [] as { id: string; title: string; metadata: Record<string, unknown> | string }[] }
  const sourceById = new Map(sources.rows.map((source) => [source.id, source]))
  for (const proposal of proposals) {
    for (const id of proposal.source_ids ?? []) {
      const source = sourceById.get(id)
      if (!source) continue
      const metadata = typeof source.metadata === 'string' ? JSON.parse(source.metadata) : source.metadata
      origins.get(proposal.id)!.push({
        kind: 'source',
        label: source.title,
        href: `/sources/${source.id}`,
        provenance: metadata.derived_from_output_id ? 'generated' : 'external',
      })
    }
  }

  const revisions = await db.query<{
    proposal_id: string
    slug: string
    title: string
    base_revision_id: string | null
  }>(
    `SELECT r.proposal_id, c.slug, r.title, r.base_revision_id
       FROM wk_concept_revisions r
       JOIN wk_concepts c ON c.id = r.concept_id
      WHERE r.space_id = $1 AND r.proposal_id = ANY($2::uuid[])
      ORDER BY r.created_at ASC`,
    [spaceId, ids],
  )
  const statusById = new Map(proposals.map((proposal) => [proposal.id, proposal.status]))
  for (const revision of revisions.rows) {
    const existing = revision.base_revision_id !== null || statusById.get(revision.proposal_id) === 'approved'
    targets.get(revision.proposal_id)?.push({
      kind: 'page',
      label: revision.title,
      href: existing ? `/pages/${revision.slug}` : null,
      change: revision.base_revision_id === null ? 'create' : 'update',
    })
  }
  return { origins, targets }
}

async function openItems(db: Db, spaceId: string): Promise<AttentionItem[]> {
  const items: AttentionItem[] = []
  const proposals = await db.query<{
    id: string
    title: string
    summary: string
    created_at: Date | string
    previous_id: string | null
    previous_at: Date | string | null
    previous_note: string | null
    source_ids: string[] | null
  }>(
    `SELECT p.id, p.title, p.summary, p.created_at, p.source_ids,
            previous.id AS previous_id, previous.reviewed_at AS previous_at, previous.review_note AS previous_note
       FROM wk_change_proposals p
       LEFT JOIN LATERAL (
         SELECT r.id, r.reviewed_at, r.review_note
           FROM wk_change_proposals r
          WHERE r.space_id = p.space_id AND r.input_hash = p.input_hash
            AND r.status = 'rejected' AND r.id <> p.id
          ORDER BY r.reviewed_at DESC NULLS LAST, r.created_at DESC
          LIMIT 1
       ) previous ON true
      WHERE p.space_id = $1 AND p.status = 'pending'
      ORDER BY p.created_at ASC`,
    [spaceId],
  )
  const proposalContext = await proposalContexts(db, spaceId, proposals.rows)
  for (const proposal of proposals.rows) {
    items.push({
      key: `proposal:${proposal.id}`,
      kind: 'proposal',
      state: 'open',
      title: proposal.title,
      summary: proposal.summary,
      effect: 'Changes wiki knowledge after a human review.',
      created_at: isoString(proposal.created_at),
      remind_at: null,
      note: null,
      origins: proposalContext.origins.get(proposal.id) ?? [],
      targets: proposalContext.targets.get(proposal.id) ?? [],
      available_actions: ['open_review'],
      previous_rejection:
        proposal.previous_id && proposal.previous_at
          ? {
              proposal_id: proposal.previous_id,
              reviewed_at: isoString(proposal.previous_at),
              note: proposal.previous_note,
            }
          : null,
    })
  }

  const captures = await db.query<{
    id: string
    created_at: Date | string
    input: Record<string, unknown> | string
  }>(
    `SELECT id, created_at, input FROM wk_ingest_jobs WHERE space_id = $1 AND status = 'captured' ORDER BY created_at`,
    [spaceId],
  )
  for (const capture of captures.rows) {
    const input = typeof capture.input === 'string' ? JSON.parse(capture.input) : capture.input
    const triage = input.triage as Record<string, unknown> | undefined
    const content = String(input.markdown ?? input.text ?? input.url ?? '')
    items.push({
      key: `triage:${capture.id}`,
      kind: 'triage',
      state: 'open',
      title: String(triage?.title ?? input.title ?? content.split(/\r?\n/u)[0] ?? 'Captured note').slice(0, 120),
      summary: String(triage?.summary ?? summarizeSource(content, 320)),
      effect: triage?.question ? String(triage.question) : 'Choose where this capture belongs.',
      created_at: isoString(capture.created_at),
      remind_at: null,
      note: null,
      origins: [
        {
          kind: 'capture',
          label: String(input.title ?? triage?.title ?? 'Inbox item'),
          href: `/inbox?triage=${capture.id}`,
          provenance: null,
        },
      ],
      targets: [
        typeof triage?.target_space === 'string' && triage.target_space.trim()
          ? {
              kind: 'wiki',
              label: triage.target_space,
              href: `/?space=${encodeURIComponent(triage.target_space)}`,
              change: 'choose',
            }
          : { kind: 'unspecified', label: 'Target not chosen yet', href: null, change: 'choose' },
      ],
      available_actions: ['triage', 'defer', 'discard'],
      previous_rejection: null,
    })
  }

  const outputs = await db.query<{
    id: string
    title: string
    markdown: string
    created_at: Date | string
  }>(
    `SELECT id, title, markdown, created_at FROM wk_outputs WHERE space_id = $1 AND promoted_at IS NULL ORDER BY created_at`,
    [spaceId],
  )
  for (const output of outputs.rows) {
    items.push({
      key: `output:${output.id}`,
      kind: 'output',
      state: 'open',
      title: output.title,
      summary: summarizeSource(output.markdown, 320),
      effect: 'May be filed back through ordinary ingest and review.',
      created_at: isoString(output.created_at),
      remind_at: null,
      note: null,
      origins: [{ kind: 'output', label: output.title, href: `/answers/${output.id}`, provenance: 'generated' }],
      targets: [{ kind: 'unspecified', label: 'Target chosen during filing', href: null, change: 'choose' }],
      available_actions: ['open_output', 'promote', 'defer', 'discard'],
      previous_rejection: null,
    })
  }
  return items
}

async function decidedItems(db: Db, spaceId: string): Promise<AttentionItem[]> {
  const rows = await db.query<{
    id: string
    title: string
    summary: string
    status: string
    source_ids: string[] | null
    reviewed_at: Date | string | null
    created_at: Date | string
  }>(
    `SELECT id, title, summary, status, source_ids, reviewed_at, created_at
       FROM wk_change_proposals
      WHERE space_id = $1 AND status <> 'pending'
      ORDER BY coalesce(reviewed_at, created_at) DESC
      LIMIT 50`,
    [spaceId],
  )
  const context = await proposalContexts(db, spaceId, rows.rows)
  return rows.rows.map((row) => ({
    key: `proposal:${row.id}`,
    kind: 'proposal',
    state: 'decided',
    title: row.title,
    summary: row.summary,
    effect: `Proposal ${row.status}.`,
    created_at: isoString(row.reviewed_at ?? row.created_at),
    remind_at: null,
    note: null,
    origins: context.origins.get(row.id) ?? [],
    targets: context.targets.get(row.id) ?? [],
    available_actions: ['open_review'],
    previous_rejection: null,
  }))
}

function parseSnapshot(row: OverlayRow, current?: AttentionItem): AttentionItem {
  const snapshot = typeof row.snapshot === 'string' ? (JSON.parse(row.snapshot) as AttentionItem) : row.snapshot
  return {
    ...(current ?? snapshot),
    state: row.state,
    remind_at: row.remind_at ? isoString(row.remind_at) : null,
    note: row.note,
  }
}

export async function getAttentionItem(db: Db, spaceId: string, key: string): Promise<AttentionItem | null> {
  const [overlay] = await db.select<OverlayRow>('wk_attention_states', {
    space_id: `eq.${spaceId}`,
    item_key: `eq.${key}`,
    limit: 1,
  })
  const current = (await openItems(db, spaceId)).find((item) => item.key === key)
  if (overlay) return parseSnapshot(overlay, current)
  return current ?? null
}

export async function getAttention(
  db: Db,
  spaceId: string,
  args: { state?: AttentionState; kind?: AttentionKind; limit?: number; cursor?: string },
): Promise<AttentionPage> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
  const offset = args.cursor ? Number(Buffer.from(args.cursor, 'base64url').toString('utf8')) : 0
  if (!Number.isInteger(offset) || offset < 0) throw new ValidationError('cursor is invalid')
  const current = await openItems(db, spaceId)
  const overlays = await db.select<OverlayRow>('wk_attention_states', { space_id: `eq.${spaceId}`, limit: 1000 })
  const overlayByKey = new Map(overlays.map((row) => [row.item_key, row]))
  const currentByKey = new Map(current.map((item) => [item.key, item]))
  const open = current
    .filter((item) => !overlayByKey.has(item.key))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key))
  const deferred = overlays
    .filter((row) => row.state === 'deferred')
    .map((row) => parseSnapshot(row, currentByKey.get(row.item_key)))
  const discarded = overlays
    .filter((row) => row.state === 'discarded')
    .map((row) => parseSnapshot(row, currentByKey.get(row.item_key)))
  const decided = await decidedItems(db, spaceId)
  const selected =
    args.state === 'deferred'
      ? deferred
      : args.state === 'discarded'
        ? discarded
        : args.state === 'decided'
          ? decided
          : open
  const filtered = args.kind ? selected.filter((item) => item.kind === args.kind) : selected
  const page = filtered.slice(offset, offset + limit)
  const now = Date.now()
  const by_kind: Record<AttentionKind, number> = { proposal: 0, triage: 0, output: 0 }
  for (const item of open) by_kind[item.kind] += 1
  return {
    generated_at: new Date(now).toISOString(),
    counts: {
      open: open.length,
      overdue: deferred.filter((item) => item.remind_at && new Date(item.remind_at).getTime() <= now).length,
      oldest_days: open.length ? Math.max(...open.map((item) => daysOld(item.created_at, now))) : null,
      by_kind,
    },
    items: page,
    next_cursor: offset + limit < filtered.length ? Buffer.from(String(offset + limit)).toString('base64url') : null,
    recent_activity: decided.slice(0, 10),
  }
}

export async function setAttentionState(
  db: Db,
  spaceId: string,
  item: AttentionItem | null,
  args: { key: string; state: 'open' | 'deferred' | 'discarded'; remind_at?: string | null; note?: string | null },
): Promise<void> {
  if (args.state === 'open') {
    await db.query(`DELETE FROM wk_attention_states WHERE space_id = $1 AND item_key = $2`, [spaceId, args.key])
    return
  }
  if (!item) throw new NotFoundError(`attention item ${args.key} not found`)
  if (args.state !== 'deferred' && args.remind_at)
    throw new ValidationError('remind_at is only valid for deferred items')
  await db.query(
    `INSERT INTO wk_attention_states (space_id, item_key, kind, state, remind_at, note, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (space_id, item_key) DO UPDATE
       SET state = excluded.state, remind_at = excluded.remind_at, note = excluded.note,
           snapshot = excluded.snapshot, updated_at = now()`,
    [spaceId, args.key, item.kind, args.state, args.remind_at ?? null, args.note ?? null, JSON.stringify(item)],
  )
}
