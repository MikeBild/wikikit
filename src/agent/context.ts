import type { AgentBriefingResult, BriefingSpace } from './briefing.ts'
import { buildAgentBriefing, DEFAULT_BRIEFING_BUDGET_TOKENS } from './briefing.ts'
import type { Db } from '../db/postgres.ts'

export interface AgentContextOptions {
  prompt: string
  project_hint?: string
  primary_space?: string
  manual_spaces?: string[]
  exclude_spaces?: string[]
  max_spaces?: number
  budget_tokens?: number
}

export interface SpaceMatch {
  slug: string
  name: string
  score: number
  reasons: string[]
}

export interface AgentContextResult extends AgentBriefingResult {
  selection_mode: 'manual' | 'automatic'
  matches: SpaceMatch[]
}

const STOP_WORDS = new Set([
  'aber',
  'also',
  'auch',
  'bitte',
  'dann',
  'das',
  'dem',
  'den',
  'der',
  'die',
  'ein',
  'eine',
  'einer',
  'einen',
  'für',
  'hat',
  'hier',
  'ich',
  'ist',
  'machen',
  'mach',
  'mein',
  'meine',
  'mit',
  'oder',
  'sind',
  'und',
  'von',
  'was',
  'wie',
  'wird',
  'wir',
  'zur',
  'zum',
  'the',
  'this',
  'that',
  'with',
  'from',
  'into',
  'your',
  'please',
  'create',
  'make',
  'add',
  'use',
  'using',
])

function words(text: string): string[] {
  return (text.toLocaleLowerCase('de-DE').match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => word.length >= 3 && !STOP_WORDS.has(word),
  )
}

function variants(word: string): string[] {
  const result = new Set([word])
  if (word.length >= 8) result.add(word.slice(0, 4))
  for (const suffix of ['ern', 'en', 'er', 'es']) {
    if (word.length > suffix.length + 4 && word.endsWith(suffix)) result.add(word.slice(0, -suffix.length))
  }
  return [...result]
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function profile(space: BriefingSpace): { identity: Set<string>; description: Set<string>; keywords: Set<string> } {
  const context = space.settings.agent_context
  const configured = context && typeof context === 'object' ? (context as Record<string, unknown>) : {}
  const description = [space.settings.description, space.settings.purpose, configured.description, configured.use_when]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  const keywordText = [...stringList(configured.keywords), ...stringList(configured.aliases)].join(' ')
  const identityWords = words(`${space.slug.replaceAll('-', ' ')} ${space.name}`)
  if (space.slug.endsWith('-de')) identityWords.push('deutsch', 'german')
  return {
    identity: new Set(identityWords.flatMap(variants)),
    description: new Set(words(description).flatMap(variants)),
    keywords: new Set(words(keywordText).flatMap(variants)),
  }
}

function rank(space: BriefingSpace, prompt: string, projectHint = ''): SpaceMatch {
  const candidate = profile(space)
  const promptWords = new Set(words(prompt))
  const projectWords = new Set(words(projectHint))
  let score = 0
  const reasons = new Set<string>()
  for (const word of promptWords) {
    let bestMatch = 0
    for (const variant of variants(word)) {
      if (candidate.keywords.has(variant)) {
        bestMatch = Math.max(bestMatch, variant === word ? 12 : 6)
      } else if (candidate.identity.has(variant)) {
        bestMatch = Math.max(bestMatch, variant === word ? 9 : 5)
      } else if (candidate.description.has(variant)) {
        bestMatch = Math.max(bestMatch, variant === word ? 4 : 2)
      }
    }
    if (bestMatch > 0) {
      score += bestMatch
      reasons.add(word)
    }
  }
  for (const word of projectWords) {
    if (candidate.identity.has(word)) {
      score += 15
      reasons.add(`project:${word}`)
    }
  }
  return { slug: space.slug, name: space.name, score, reasons: [...reasons].slice(0, 5) }
}

function emptyBriefing(budget: number): AgentBriefingResult {
  const markdown =
    '# WikiKit context\n\nNo relevant reviewed space was selected automatically. Use `wikikit_spaces` to inspect available spaces or name spaces explicitly.'
  return {
    markdown,
    spaces: [],
    budget_tokens: budget,
    used_tokens: Math.ceil(Buffer.byteLength(markdown, 'utf8') / 4),
    concepts_included: [],
    concepts_omitted: 0,
  }
}

export async function buildAgentContext(
  db: Db,
  visibleSpaces: BriefingSpace[],
  options: AgentContextOptions,
): Promise<AgentContextResult> {
  const budget = options.budget_tokens ?? DEFAULT_BRIEFING_BUDGET_TOKENS
  const excluded = new Set(options.exclude_spaces ?? [])
  const bySlug = new Map(visibleSpaces.map((space) => [space.slug, space]))
  const manual = [...new Set(options.manual_spaces ?? [])].filter((slug) => !excluded.has(slug))
  const maxSpaces = Math.max(1, Math.min(10, options.max_spaces ?? 3))
  let selected: BriefingSpace[] = []
  let matches: SpaceMatch[] = []

  if (manual.length > 0) {
    selected = manual
      .map((slug) => bySlug.get(slug))
      .filter((space): space is BriefingSpace => Boolean(space))
      .slice(0, maxSpaces)
    matches = selected.map((space) => ({ slug: space.slug, name: space.name, score: 100, reasons: ['explicit'] }))
  } else {
    const primary =
      options.primary_space && !excluded.has(options.primary_space) ? bySlug.get(options.primary_space) : undefined
    if (primary) selected.push(primary)
    matches = visibleSpaces
      .filter((space) => !excluded.has(space.slug) && space.slug !== primary?.slug)
      .map((space) => rank(space, options.prompt, options.project_hint))
      .filter((match) => match.score >= 5)
      .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
      .slice(0, maxSpaces - selected.length)
    selected.push(...matches.map((match) => bySlug.get(match.slug)!))
    if (primary) matches.unshift({ slug: primary.slug, name: primary.name, score: 100, reasons: ['primary'] })
  }

  const briefing = selected.length > 0 ? await buildAgentBriefing(db, selected, budget) : emptyBriefing(budget)
  return { ...briefing, selection_mode: manual.length > 0 ? 'manual' : 'automatic', matches }
}
