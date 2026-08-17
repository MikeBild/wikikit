// LLM boundary schemas — zod v4 at the model boundary (CONTRACTS.md §3.2).
//
// WHY zod on BOTH sides of the wire: the request side derives the structured
// -output JSON schema the API enforces; the response side re-parses the model
// text through the same zod object. Structured outputs guarantee shape, not
// semantics — constraints the API cannot enforce (confidence 0..1, non-empty
// strings) are validated here, and a violation is a hard LlmOutputInvalidError
// (no silent partials, per contract).
import { z } from 'zod'

export interface TriageInput {
  currentSpace: string
  title: string | null
  content: string
  spaces: { slug: string; name: string; purpose: string | null }[]
}

export const zTriageOutput = z.object({
  target_space: z.string().nullable(),
  title: z.string().min(1).max(120),
  summary: z.string().max(500),
  confidence: z.number().min(0).max(1),
  question: z.string().max(500).nullable(),
})

export type TriageOutput = z.infer<typeof zTriageOutput>

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
  /** en/de pin model-authored titles; absent keeps the provider neutral. */
  language?: 'en' | 'de'
  /** Set only for the single retry after a language-dominance failure. */
  languageRepair?: boolean
  /** The space charter (wk_charter_revisions latest) — human-owned guidance on
   *  page types + naming conventions. Steers new-concept slugs when present. */
  charter?: string
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
  /** en/de pin every human-readable field other than verbatim citations. */
  language?: 'en' | 'de'
  /** Set only for the single retry after a language-dominance failure. */
  languageRepair?: boolean
  /** Typed registry entries (settings.predicate_defs) — rendered instead of the bare names when present. */
  predicateDefs?: import('../domain/normalize.ts').PredicateDef[]
  /** Optional source classification; when 'meeting', decision mining is on. */
  sourceKind?: SourceKind
  /** The space charter (wk_charter_revisions latest) — human-owned guidance on
   *  emphasis, voice and page conventions. Steers synthesis when present. */
  charter?: string
}

/** One call per ingest: the whole source in, the choices it settles out.
 *  `existingDecisions` are the space's ACTIVE decisions — the model marks a
 *  find as a duplicate of, or an update to, one of them (see decisions.v1). */
export interface ExtractDecisionsInput {
  source: { title: string | null; markdown: string }
  /** en/de pin every generated decision field. */
  language?: 'en' | 'de'
  /** Set only for the single retry after a language-dominance failure. */
  languageRepair?: boolean
  /** Optional source classification; 'meeting' is where decisions live. */
  sourceKind?: SourceKind
  charter?: string
  existingDecisions: { slug: string; title: string; decision: string }[]
}

export interface AnswerEvidence {
  kind: 'concept' | 'claim' | 'source_chunk'
  slug: string | null
  text: string
  status: string | null
  /** Set for kind='source_chunk' — the archive row the excerpt came from. */
  source_id?: string | null
}

export interface AnswerInput {
  question: string
  evidence: AnswerEvidence[]
}

export interface DistillInput {
  /** Raw coding-agent session transcript (already tail-capped by the caller). */
  transcript: string
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

// An array the model may decline to supply. OpenAI's structured outputs reject
// a schema whose `required` omits any property key, so the wire schema lists
// every key (see toOutputJsonSchema) — declining has to be expressible in the
// VALUE instead, as null. Absent and null both normalize to [] here, so the
// inferred type stays a plain array and no reader ever sees null.
const zDeclinableArray = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .nullable()
    .default([])
    .transform((value) => value ?? [])

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
      // v2 semantics — ONLY when the source states them (defaulted so the
      // model may omit).
      valid_from: z.iso.datetime().nullable().default(null),
      valid_until: z.iso.datetime().nullable().default(null),
      context: z.string().min(1).max(200).nullable().default(null),
    }),
  ),
  relations: z.array(z.object({ to_slug: zSlug, kind: zRelationKind })),
})
export type SynthesizeOutput = z.infer<typeof zSynthesizeOutput>

// Decisions the source explicitly records (decision-log pattern). Empty for
// most sources; a 'meeting' source is where these actually appear. Each maps
// 1:1 to a proposed wk_decisions row (zCreateProposalArgs.decisions shape),
// so a human reviews it before it becomes an active decision — an agent
// never writes the decision log unattended.
//
// `duplicate_of` / `updates` name an EXISTING active decision by slug (see
// decisions.v1). They are advisory: the pipeline validates both against the
// list it actually passed in and treats an unknown slug as "new decision".
export const zExtractDecisionsOutput = z.object({
  decisions: zDeclinableArray(
    z.object({
      slug: zSlug,
      title: z.string().min(1).max(500),
      context: z.string().min(1),
      decision: z.string().min(1),
      rationale: z.string(),
      alternatives: z.array(z.string()),
      duplicate_of: zSlug.nullable().default(null),
      updates: zSlug.nullable().default(null),
    }),
  ),
})
export type ExtractDecisionsOutput = z.infer<typeof zExtractDecisionsOutput>

export const zAnswerOutput = z.object({
  answer_markdown: z.string().min(1),
  cited_slugs: z.array(z.string()),
  not_in_knowledge_base: z.boolean(),
  // Source-evidence citations: archive source ids the answer leaned on.
  cited_source_ids: zDeclinableArray(z.string()),
})
export type AnswerOutput = z.infer<typeof zAnswerOutput>

// Session distillation: a coding-agent transcript in, durable rules out.
//
// WHY an empty array is the EXPECTED answer: most sessions teach nothing that
// outlives them ("fix this typo"). Distillation is a filter first and an
// extractor second — capturing routine sessions would fill the review queue
// with noise a human then has to reject by hand, which kills the whole loop.
// `quote` is verbatim from the transcript for the same reason claims carry
// one: it is the evidence a reviewer checks the rule against, and the ingest
// pipeline's grounding guard drops any claim whose quote it cannot find.
export const zDistillOutput = z.object({
  learnings: zDeclinableArray(
    z.object({
      title: z.string().min(1).max(200),
      rule: z.string().min(1),
      quote: z.string().min(1),
    }),
  ),
})
export type DistillOutput = z.infer<typeof zDistillOutput>

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
  // Every key is emitted as required, so a wire-level default can never fire;
  // the zod parse is what fills an omitted or null field in.
  'default',
] as const

/** Extend a property schema to admit null, whatever shape it already has. Idempotent. */
function widenToNullable(node: Record<string, unknown>): Record<string, unknown> {
  if (node.type === 'null') return node
  if (Array.isArray(node.type)) {
    return node.type.includes('null') ? node : { ...node, type: [...node.type, 'null'] }
  }
  if (Array.isArray(node.anyOf)) {
    const alternatives = node.anyOf as Record<string, unknown>[]
    return alternatives.some((alt) => alt?.type === 'null')
      ? node
      : { ...node, anyOf: [...alternatives, { type: 'null' }] }
  }
  if (typeof node.type === 'string') return { ...node, type: [node.type, 'null'] }
  // Keyword-only nodes (enum, $ref, bare {}) cannot take a type union.
  const { description, ...constraint } = node
  return {
    ...(description === undefined ? {} : { description }),
    anyOf: [constraint, { type: 'null' }],
  }
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) continue
    out[key] = sanitize(value)
  }
  if (out.type === 'object') {
    // Structured outputs require every object to close itself off — zod v4 emits
    // this already, but we enforce it defensively so a future schema tweak
    // (e.g. z.looseObject) cannot silently ship an open schema.
    out.additionalProperties = false
    // OpenAI rejects a schema whose `required` omits any key in `properties`;
    // optionality is expressible only as a nullable value. Enforced here rather
    // than per schema so no author has to remember the rule: every key is
    // listed, and a key zod treats as optional is widened to accept null.
    const properties = out.properties as Record<string, Record<string, unknown>> | undefined
    if (properties) {
      const required = new Set((out.required as string[] | undefined) ?? [])
      out.properties = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, required.has(key) ? value : widenToNullable(value)]),
      )
      out.required = Object.keys(properties)
    }
  }
  return out
}

/**
 * Render a zod schema as the JSON schema for the provider's structured-output
 * format: every object closed, every property key in `required` with optional
 * ones nullable, no unsupported constraint keywords, no $schema envelope.
 *
 * Derived from the INPUT projection — what the model must emit — so a zod
 * `.default()` does not misreport an optional field as one the model always
 * supplies. Mirrors the AI SDK's own draft-7/inline conversion options so this
 * schema differs from the SDK's only where it is deliberately stricter.
 *
 * `io: 'input'` is mandatory, not a preference: zDeclinableArray ends in a
 * transform, and the output projection of a transform has no JSON Schema
 * representation — zod throws.
 */
export function toOutputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', reused: 'inline' }) as Record<string, unknown>
  delete json.$schema
  return sanitize(json) as Record<string, unknown>
}
