import type { Db } from '../db/postgres.ts'

export const DEFAULT_BRIEFING_BUDGET_TOKENS = 1200
export const MIN_BRIEFING_BUDGET_TOKENS = 500
export const MAX_BRIEFING_BUDGET_TOKENS = 4000

export interface BriefingSpace {
  id: string
  slug: string
  name: string
  settings: Record<string, unknown>
}

export interface AgentBriefingResult {
  markdown: string
  spaces: string[]
  budget_tokens: number
  used_tokens: number
  concepts_included: string[]
  concepts_omitted: number
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

function render(spaces: BriefingSpace[], entries: BriefingEntry[], omitted: number): string {
  const spaceList = spaces.map((space) => `\`${space.slug}\``).join(', ')
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
      continue
    }
    for (const entry of selected) {
      const summary = entry.summary.trim().replace(/\s+/g, ' ').slice(0, 320)
      lines.push(`- ${entry.slug}: ${entry.title}${summary ? ` — ${summary}` : ''}`)
    }
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

  const selected = [...entries]
  let omitted = 0
  let markdown = render(spaces, selected, omitted)
  while (estimatedTokens(markdown) > budget && selected.length > 0) {
    const secondary = selected
      .map((entry, index) => ({ entry, index }))
      .reverse()
      .find(({ entry }) => !entry.primary)
    selected.splice(secondary?.index ?? selected.length - 1, 1)
    omitted += 1
    markdown = render(spaces, selected, omitted)
  }
  return {
    markdown,
    spaces: spaces.map((space) => space.slug),
    budget_tokens: budget,
    used_tokens: estimatedTokens(markdown),
    concepts_included: selected.map((entry) => entry.slug),
    concepts_omitted: omitted,
  }
}
