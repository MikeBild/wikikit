// Qualified cross-space references (0023): 'other-space:concept-slug'.
//
// The syntax is deliberately tiny — one colon, both halves the existing slug
// grammars. Used by relation staging (wk_relations.to_space_id), the concept
// read side (provenance labels) and the [[space:slug]] markdown convention
// (documented; the graph truth lives in relations, never in a link
// rewriter).
const SPACE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const CONCEPT_SLUG = /^[a-z0-9][a-z0-9-]{0,126}$/

/** Widened to_slug grammar: plain concept slug OR space-qualified. */
export const QUALIFIED_SLUG_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,62}:)?[a-z0-9][a-z0-9-]{0,126}$/

export interface ParsedSlug {
  /** null = same-space reference. */
  space: string | null
  slug: string
}

/** Parse 'space:slug' | 'slug'; returns null when neither grammar matches. */
export function parseQualifiedSlug(value: string): ParsedSlug | null {
  const colon = value.indexOf(':')
  if (colon === -1) {
    return CONCEPT_SLUG.test(value) ? { space: null, slug: value } : null
  }
  const space = value.slice(0, colon)
  const slug = value.slice(colon + 1)
  if (!SPACE_SLUG.test(space) || !CONCEPT_SLUG.test(slug)) return null
  return { space, slug }
}

/** settings.imports — the declared federation surface of a space. */
export function readImports(settings: Record<string, unknown> | undefined): string[] {
  const raw = settings?.['imports']
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((value): value is string => typeof value === 'string' && SPACE_SLUG.test(value)))]
}
