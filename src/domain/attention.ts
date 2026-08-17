import type { Db } from '../db/postgres.ts'
import { lintSpace, type LintFinding } from './lint.ts'
import { isoString, sha256Hex, summarizeSource } from './sources.ts'
import { NotFoundError, ValidationError } from './errors.ts'

export type AttentionKind = 'proposal' | 'triage' | 'output' | 'care'
export type AttentionState = 'open' | 'deferred' | 'discarded' | 'decided'

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
  source: { label: string; href: string; actor: string | null }
  available_actions: string[]
  previous_rejection: { proposal_id: string; reviewed_at: string; note: string | null } | null
}

export interface AttentionPage {
  generated_at: string
  counts: { open: number; overdue: number; oldest_days: number | null; by_kind: Record<AttentionKind, number> }
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

function careKey(finding: LintFinding): string {
  return `care:${finding.rule}:${sha256Hex(
    JSON.stringify({
      concept_slug: finding.concept_slug ?? null,
      claim_id: finding.claim_id ?? null,
      details: finding.details ?? null,
    }),
  ).slice(0, 16)}`
}

function careActions(finding: LintFinding): string[] {
  if (finding.rule === 'missing-charter') return ['open_guidelines']
  if (finding.rule === 'unreviewed-proposals' || finding.rule === 'stale-proposals') return ['open_review']
  if (finding.rule === 'stale-captures') return ['open_triage']
  if (finding.rule === 'dangling-sources') return ['open_source', 'find_page']
  if (finding.rule === 'tombstoned-sources') return ['open_page', 'propose_deprecation']
  if (finding.rule === 'broken-relations' || finding.rule === 'broken-cross-space-links') {
    return ['open_page', 'edit_relation']
  }
  if (finding.rule === 'missing-citations' || finding.rule === 'unsourced-concepts') {
    return ['open_page', 'add_source']
  }
  if (finding.rule === 'contradictions') return ['open_page', 'propose_supersession']
  if (finding.rule === 'stale-claims') return ['open_page', 'reverify_claim']
  if (finding.rule === 'orphan-concepts') return ['open_page', 'add_relation']
  if (finding.rule === 'self-derived-only') return ['open_page', 'add_external_source']
  return ['open_page', 'edit_page']
}

async function openItems(
  db: Db,
  spaceId: string,
  deps: { scaffoldingKinds: readonly string[] },
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = []
  const proposals = await db.query<{
    id: string
    title: string
    summary: string
    created_at: Date | string
    previous_id: string | null
    previous_at: Date | string | null
    previous_note: string | null
  }>(
    `SELECT p.id, p.title, p.summary, p.created_at,
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
      source: { label: 'Change proposal', href: `/decisions/proposals/${proposal.id}`, actor: null },
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
      source: { label: 'Inbox capture', href: `/inbox?triage=${capture.id}`, actor: null },
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
      source: { label: 'Produced output', href: `/answers/${output.id}`, actor: null },
      available_actions: ['open_output', 'promote', 'defer', 'discard'],
      previous_rejection: null,
    })
  }

  const lint = await lintSpace(db, spaceId, { scaffoldingKinds: deps.scaffoldingKinds, tier: 'deep' })
  const checkedAt = new Date().toISOString()
  for (const finding of lint.findings) {
    const label = finding.message.default_text
    const target = finding.concept_slug ? `/pages/${finding.concept_slug}` : '/care'
    items.push({
      key: careKey(finding),
      kind: 'care',
      state: 'open',
      title: label,
      summary: `Rule: ${finding.rule}`,
      effect: 'Review the finding and choose a repair; checking itself changes nothing.',
      created_at: checkedAt,
      remind_at: null,
      note: null,
      source: { label: 'Care check', href: target, actor: null },
      available_actions: careActions(finding),
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
    reviewed_at: Date | string | null
    created_at: Date | string
  }>(
    `SELECT id, title, summary, status, reviewed_at, created_at
       FROM wk_change_proposals
      WHERE space_id = $1 AND status <> 'pending'
      ORDER BY coalesce(reviewed_at, created_at) DESC
      LIMIT 50`,
    [spaceId],
  )
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
    source: { label: 'Reviewed proposal', href: `/decisions/proposals/${row.id}`, actor: null },
    available_actions: ['open_review'],
    previous_rejection: null,
  }))
}

function parseSnapshot(row: OverlayRow): AttentionItem {
  const snapshot = typeof row.snapshot === 'string' ? (JSON.parse(row.snapshot) as AttentionItem) : row.snapshot
  return {
    ...snapshot,
    state: row.state,
    remind_at: row.remind_at ? isoString(row.remind_at) : null,
    note: row.note,
  }
}

export async function getAttentionItem(
  db: Db,
  spaceId: string,
  key: string,
  deps: { scaffoldingKinds: readonly string[] },
): Promise<AttentionItem | null> {
  const [overlay] = await db.select<OverlayRow>('wk_attention_states', {
    space_id: `eq.${spaceId}`,
    item_key: `eq.${key}`,
    limit: 1,
  })
  if (overlay) return parseSnapshot(overlay)
  return (await openItems(db, spaceId, deps)).find((item) => item.key === key) ?? null
}

export async function getAttention(
  db: Db,
  spaceId: string,
  args: { state?: AttentionState; kind?: AttentionKind; limit?: number; cursor?: string },
  deps: { scaffoldingKinds: readonly string[] },
): Promise<AttentionPage> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
  const offset = args.cursor ? Number(Buffer.from(args.cursor, 'base64url').toString('utf8')) : 0
  if (!Number.isInteger(offset) || offset < 0) throw new ValidationError('cursor is invalid')
  const current = await openItems(db, spaceId, deps)
  const overlays = await db.select<OverlayRow>('wk_attention_states', { space_id: `eq.${spaceId}`, limit: 1000 })
  const overlayByKey = new Map(overlays.map((row) => [row.item_key, row]))
  const open = current
    .filter((item) => !overlayByKey.has(item.key))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key))
  const deferred = overlays.filter((row) => row.state === 'deferred').map(parseSnapshot)
  const discarded = overlays.filter((row) => row.state === 'discarded').map(parseSnapshot)
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
  const by_kind: Record<AttentionKind, number> = { proposal: 0, triage: 0, output: 0, care: 0 }
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
