import type { Db } from '../db/postgres.ts'
import { reviewOverview } from '../domain/health.ts'

export const DEFAULT_BRIEFING_BUDGET_TOKENS = 1200
export const MIN_BRIEFING_BUDGET_TOKENS = 500
export const MAX_BRIEFING_BUDGET_TOKENS = 4000

export interface BriefingSpace {
  id: string
  slug: string
  name: string
  settings: Record<string, unknown>
}

/**
 * The review backlog of the briefed spaces. `oldest_days` is null exactly when
 * nothing is pending — the null-not-zero discipline of the health surfaces —
 * and `spaces` carries every briefed space, measured zeros included, so a
 * consumer can tell "no backlog" from "not asked".
 */
export interface PendingChanges {
  total: number
  oldest_days: number | null
  spaces: { space: string; pending: number; oldest_days: number | null }[]
}

export interface AgentBriefingResult {
  markdown: string
  spaces: string[]
  budget_tokens: number
  used_tokens: number
  concepts_included: string[]
  concepts_omitted: number
  pending_changes: PendingChanges
}

interface BriefingEntry {
  space: string
  slug: string
  title: string
  summary: string
  primary: boolean
}

function estimatedTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

function configuredSlugs(settings: Record<string, unknown>): string[] {
  const briefing = settings.agent_briefing
  if (!briefing || typeof briefing !== 'object') return []
  const raw = (briefing as { concept_slugs?: unknown }).concept_slugs
  const max = Math.min(5, Math.max(0, Number((briefing as { max_concepts?: unknown }).max_concepts ?? 5)))
  if (!Array.isArray(raw)) return []
  return raw.filter((slug): slug is string => typeof slug === 'string').slice(0, max)
}

function render(spaces: BriefingSpace[], entries: BriefingEntry[], omitted: number, pending: PendingChanges): string {
  const spaceList = spaces.map((space) => `\`${space.slug}\``).join(', ')
  const bySlug = new Map(pending.spaces.map((entry) => [entry.space, entry]))
  const lines = [
    `# WikiKit session briefing — spaces: ${spaceList}`,
    '',
    'Grounding rule: search and read reviewed WikiKit knowledge instead of guessing domain rules.',
    `Use \`wikikit_search\` and \`wikikit_read\` with one of these spaces: ${spaceList}.`,
    'If the knowledge base has no answer, say so instead of inventing project internals.',
  ]
  for (const space of spaces) {
    const selected = entries.filter((entry) => entry.space === space.slug)
    lines.push('', `## ${space.name} (\`${space.slug}\`)`)
    if (selected.length === 0) {
      lines.push('- No pinned briefing concepts; search this space on demand.')
    }
    for (const entry of selected) {
      const summary = entry.summary.trim().replace(/\s+/g, ' ').slice(0, 320)
      lines.push(`- ${entry.slug}: ${entry.title}${summary ? ` — ${summary}` : ''}`)
    }
    // The backlog, in renderBriefing's own words (src/schedule.ts) so the
    // session hook and the scheduled report state one fact in one voice. A
    // space with nothing pending gets NO line: an absent backlog is not a
    // sentence worth a reader's morning.
    const backlog = bySlug.get(space.slug)
    if (backlog && backlog.pending > 0) {
      lines.push(`- ${backlog.pending} change(s) pending review.`)
      if (backlog.oldest_days !== null) lines.push(`- Oldest: ${backlog.oldest_days} day(s) old.`)
    }
  }
  if (spaces.length > 1 && pending.total > 0) {
    lines.push(
      '',
      `Across these spaces: ${pending.total} change(s) pending review${
        pending.oldest_days !== null ? `; oldest ${pending.oldest_days} day(s) old` : ''
      }.`,
    )
  }
  if (omitted > 0) lines.push('', `- … ${omitted} briefing concept(s) omitted for the token budget.`)
  return lines.join('\n')
}

export async function buildAgentBriefing(
  db: Db,
  spaces: BriefingSpace[],
  budgetTokens = DEFAULT_BRIEFING_BUDGET_TOKENS,
): Promise<AgentBriefingResult> {
  const budget = Math.min(MAX_BRIEFING_BUDGET_TOKENS, Math.max(MIN_BRIEFING_BUDGET_TOKENS, budgetTokens))
  const entries: BriefingEntry[] = []
  for (const [index, space] of spaces.entries()) {
    const slugs = configuredSlugs(space.settings)
    if (slugs.length === 0) continue
    const { rows } = await db.query<{ slug: string; title: string; summary: string }>(
      `SELECT c.slug, r.title, r.summary
         FROM wk_concepts c
         JOIN wk_concept_revisions r ON r.id = c.current_revision_id
        WHERE c.space_id = $1 AND c.slug = ANY($2::text[])
        ORDER BY array_position($2::text[], c.slug)`,
      [space.id, slugs],
    )
    entries.push(...rows.map((row) => ({ space: space.slug, ...row, primary: index === 0 })))
  }

  // Only the briefed spaces — the caller chose them, this function enumerates
  // nothing. This block is proposal-specific; the end-user overview also
  // counts inbox triage because that requires a person too. Reports are history.
  const overview = await reviewOverview(
    db,
    spaces.map((space) => space.id),
  )
  const pendingSpaces = spaces.map((space) => {
    const row = overview.get(space.id)
    return { space: space.slug, pending: row?.pending ?? 0, oldest_days: row?.oldest_days ?? null }
  })
  const pending: PendingChanges = {
    total: pendingSpaces.reduce((sum, entry) => sum + entry.pending, 0),
    oldest_days: pendingSpaces.reduce<number | null>(
      (oldest, entry) => (entry.oldest_days === null ? oldest : Math.max(oldest ?? 0, entry.oldest_days)),
      null,
    ),
    spaces: pendingSpaces,
  }

  const selected = [...entries]
  let omitted = 0
  let markdown = render(spaces, selected, omitted, pending)
  // The trim removes pinned CONCEPTS only, never the fact lines above: a
  // backlog squeezed out by a tight budget would be the one morning the number
  // mattered most.
  while (estimatedTokens(markdown) > budget && selected.length > 0) {
    const secondary = selected
      .map((entry, index) => ({ entry, index }))
      .reverse()
      .find(({ entry }) => !entry.primary)
    selected.splice(secondary?.index ?? selected.length - 1, 1)
    omitted += 1
    markdown = render(spaces, selected, omitted, pending)
  }
  return {
    markdown,
    spaces: spaces.map((space) => space.slug),
    budget_tokens: budget,
    used_tokens: estimatedTokens(markdown),
    // Qualified provenance (0023): multi-space briefings must say WHICH
    // space each concept came from.
    concepts_included: selected.map((entry) => `${entry.space}:${entry.slug}`),
    concepts_omitted: omitted,
    pending_changes: pending,
  }
}
