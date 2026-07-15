// LLM boundary schemas — zod v4 at the model boundary (CONTRACTS.md §3.2).
//
// WHY zod on BOTH sides of the wire: the request side derives the structured
// -output JSON schema the API enforces; the response side re-parses the model
// text through the same zod object. Structured outputs guarantee shape, not
// semantics — constraints the API cannot enforce (confidence 0..1, non-empty
// strings) are validated here, and a violation is a hard LlmOutputInvalidError
// (no silent partials, per contract).
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Input types (plain interfaces — inputs come from our own trusted code paths;
// zod guards the *model's* output, the untrusted side of this boundary)
// ---------------------------------------------------------------------------

export interface ConceptIndexEntry {
  slug: string
  title: string
  summary: string
}

export interface ClassifyInput {
  source: { title: string | null; markdown: string }
  conceptIndex: ConceptIndexEntry[]
}

/** What a source IS (not its transport). Steers synthesis: 'meeting' sources
 * are actively mined for explicit decision statements. Absent = unknown. */
export type SourceKind = 'meeting' | 'article' | 'note'

export interface SynthesizeInput {
  /** currentMarkdown === null means the concept is new (no current revision). */
  concept: { slug: string; title: string; currentMarkdown: string | null }
  source: { id: string; title: string | null; markdown: string }
  /** The space's controlled predicate vocabulary (wk_spaces.settings.predicates). */
  predicates: string[]
  /** Optional source classification; when 'meeting', decision mining is on. */
  sourceKind?: SourceKind
}

export interface AnswerEvidence {
  kind: 'concept' | 'claim'
  slug: string | null
  text: string
  status: string | null
}

export interface AnswerInput {
  question: string
  evidence: AnswerEvidence[]
}

/** Input for the optional Haiku contradiction adjudication (adjudicate.v1, cuttable). */
export interface AdjudicateInput {
  subject: string
  predicate: string
  existing: { object: string; quote: string | null }
  incoming: { object: string; quote: string | null }
}

// ---------------------------------------------------------------------------
// Output schemas — the provider parses model responses through these
// ---------------------------------------------------------------------------

// WHY the same slug rule as the DB CHECK constraints: a slug the model invents
// must survive `wk_concepts.slug ~ '^[a-z0-9][a-z0-9-]{0,126}$'` — rejecting it
// here turns a would-be SQL constraint violation into a typed LLM output error.
const zSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,126}$/, 'slug must be lowercase kebab-case (max 127 chars)')

export const zClassifyOutput = z.object({
  affected: z.array(zSlug),
  new: z.array(z.object({ slug: zSlug, title: z.string().min(1).max(500) })),
})
export type ClassifyOutput = z.infer<typeof zClassifyOutput>

const zRelationKind = z.enum(['related', 'part_of', 'depends_on', 'contradicts', 'supersedes'])

export const zSynthesizeOutput = z.object({
  title: z.string().min(1).max(500),
  summary: z.string(),
  markdown: z.string().min(1),
  claims: z.array(
    z.object({
      subject: z.string().min(1),
      predicate: z.string().min(1),
      object: z.string().min(1),
      // WHY quote is required: every claim needs a wk_citations row with a
      // verbatim excerpt — a claim the model cannot quote is a claim we drop.
      quote: z.string().min(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
  relations: z.array(z.object({ to_slug: zSlug, kind: zRelationKind })),
  // Decisions the source explicitly records (decision-log pattern). Empty for
  // most sources; a 'meeting' source is where these actually appear. Each maps
  // 1:1 to a proposed wk_decisions row (zCreateProposalArgs.decisions shape),
  // so a human reviews it before it becomes an active decision — an agent
  // never writes the decision log unattended.
  decisions: z
    .array(
      z.object({
        slug: zSlug,
        title: z.string().min(1).max(500),
        context: z.string().min(1),
        decision: z.string().min(1),
        rationale: z.string(),
        alternatives: z.array(z.string()),
      }),
    )
    .default([]),
})
export type SynthesizeOutput = z.infer<typeof zSynthesizeOutput>

export const zAnswerOutput = z.object({
  answer_markdown: z.string().min(1),
  cited_slugs: z.array(z.string()),
  not_in_knowledge_base: z.boolean(),
})
export type AnswerOutput = z.infer<typeof zAnswerOutput>

// Adjudication verdicts (deterministic exact-frame matcher finds the pair; the
// model only classifies WHY the objects differ):
//   contradictory — same frame, incompatible objects → both claims disputed
//   temporal      — the newer claim supersedes (valid_from/until semantics)
//   complementary — both can hold at once (no dispute)
export const zAdjudicateOutput = z.object({
  verdict: z.enum(['contradictory', 'temporal', 'complementary']),
  reason: z.string().min(1),
})
export type AdjudicateOutput = z.infer<typeof zAdjudicateOutput>

// ---------------------------------------------------------------------------
// zod → structured-outputs JSON schema
// ---------------------------------------------------------------------------

// Keywords the structured-outputs grammar compiler rejects. zod's toJSONSchema
// emits them for .min()/.max()/.regex(); we strip them from the WIRE schema
// only — the zod parse after the response enforces them client-side, so
// nothing is lost, and the API never sees an unsupported keyword.
const UNSUPPORTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
] as const

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) continue
    out[key] = sanitize(value)
  }
  // Structured outputs require every object to close itself off — zod v4 emits
  // this already, but we enforce it defensively so a future schema tweak
  // (e.g. z.looseObject) cannot silently ship an open schema.
  if (out.type === 'object') out.additionalProperties = false
  return out
}

/**
 * Render a zod schema as the JSON schema for `output_config.format`
 * (type json_schema, additionalProperties:false on every object, no
 * unsupported constraint keywords, no $schema envelope).
 */
export function toOutputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return sanitize(json) as Record<string, unknown>
}
