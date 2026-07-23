// Answer — grounded Q&A over the knowledge base (plan §5: "/query = Synthese
// (answer.v1), antwortet nur aus dem Material").
//
// Retrieval-then-synthesis in one function:
//   1. wk_search (LLM-free, top_k) finds candidate concepts,
//   2. current revisions + verified/disputed claims + citations are loaded as
//      evidence (proposed content invisible by construction; deprecated
//      claims excluded — retired knowledge answers nothing),
//   3. ONE answer.v1 call turns evidence into a cited markdown answer,
//   4. the call is logged to wk_agent_runs and the run id returned.
//
// WHY the LLM is called even on EMPTY retrieval: QueryAnswer.agent_run_id is
// non-nullable by contract (§4.2) — every /query response is auditable back to
// exactly one model call. The prompt handles the empty-evidence case ("say
// plainly that the knowledge base does not cover it"), and the structured
// not_in_knowledge_base flag lets clients branch without parsing prose.
// Short-circuiting would save pennies and break the audit invariant.
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import { getConcept } from '../domain/concepts.ts'
import { LlmNotConfiguredError, NotFoundError } from '../domain/errors.ts'
import type { LlmProvider } from '../llm/provider.ts'
import type { AnswerEvidence } from '../llm/schemas.ts'
import { fitTokenBudget } from '../ingest/chunk.ts'
import { search } from './search.ts'

const zAnswerArgs = z.object({
  question: z.string().min(1).max(2000),
  top_k: z.number().int().min(1).max(50).default(8),
  mode: z.enum(['approved_only', 'approved_then_sources']).default('approved_only'),
})

export type AnswerArgs = z.input<typeof zAnswerArgs>

export interface QueryAnswer {
  /** Inline [slug] citations; disputed claims surfaced explicitly. */
  answer_markdown: string
  citations: { slug: string; title: string }[]
  /** True → the answer says so; no hallucinated content. */
  not_in_knowledge_base: boolean
  /** wk_agent_runs row of the answer call — the audit anchor. */
  agent_run_id: string
  /**
   * Archive material the answer leaned on that exists ONLY in a source, not
   * in approved knowledge (approved_then_sources mode; empty otherwise). The
   * prompt forces such statements to be labeled as uncurated in the text.
   */
  source_citations: { source_id: string; chunk_id: string; title: string | null }[]
}

// Per-concept evidence cap. Separate from WIKIKIT_MAX_INGEST_TOKENS on
// purpose: that variable governs how much of a SOURCE the synthesis reads;
// answer evidence packs up to top_k concept pages into one prompt, so each
// page gets a fixed slice. 4k tokens × 8 concepts ≈ 32k — comfortable, and a
// concept page that large is a lint smell anyway.
const EVIDENCE_TOKENS_PER_CONCEPT = 4000

// Cap on distinct source-chunk evidence items (approved_then_sources mode).
// Chunks are <= ~400 tokens each by construction (chunkForRetrieval), so six
// of them add at most ~2.4k tokens to the prompt.
const EVIDENCE_SOURCE_CHUNKS = 6

/**
 * Answer a question from the knowledge base with citations. Throws
 * LlmNotConfiguredError (503) without an API key — /search remains the
 * LLM-free alternative.
 */
export async function answerQuestion(
  db: Db,
  spaceId: string,
  llm: LlmProvider,
  args: AnswerArgs,
  deps: { vector?: { available: boolean } } = {},
): Promise<QueryAnswer> {
  const input = zAnswerArgs.parse(args)
  if (!llm.configured) throw new LlmNotConfiguredError(llm.apiKeyEnv)

  // Retrieval: the question itself is the FTS query (websearch syntax is
  // forgiving of natural language). Claim hits and concept hits both resolve
  // to their concept — the concept page is the evidence unit. In
  // approved_then_sources mode the same call also returns the labeled
  // source-chunk tier (appended after all approved hits). Hybrid ranking
  // engages automatically when pgvector + an embedding provider are present.
  const hits = await search(
    db,
    spaceId,
    { q: input.question, limit: input.top_k, mode: input.mode },
    { llm, vector: deps.vector },
  )
  const slugs = [...new Set(hits.flatMap((hit) => (hit.slug ? [hit.slug] : [])))]

  const evidence: AnswerEvidence[] = []
  const titles = new Map<string, string>()

  for (const slug of slugs) {
    let concept
    try {
      concept = await getConcept(db, spaceId, { slug })
    } catch (error) {
      // A hit whose concept vanished between search and load (concurrent
      // approval repointing revisions) is skipped, not fatal — retrieval is
      // best-effort by nature.
      if (error instanceof NotFoundError) continue
      throw error
    }
    titles.set(slug, concept.title)

    const page = fitTokenBudget(concept.markdown, EVIDENCE_TOKENS_PER_CONCEPT)
    evidence.push({
      kind: 'concept',
      slug,
      text: `# ${concept.title}\n\n${concept.summary}\n\n${page.markdown}`,
      status: null,
    })

    // Claims travel as separate evidence items so their STATUS reaches the
    // model — the prompt requires disputed claims to be presented as
    // contested rather than silently picking a winner. The first citation
    // quote rides along: the verbatim excerpt is what makes a claim usable
    // evidence rather than an assertion.
    for (const claim of concept.claims) {
      if (claim.status !== 'verified' && claim.status !== 'disputed') continue
      const quote = claim.citations[0]?.quote
      evidence.push({
        kind: 'claim',
        slug,
        text: `${claim.subject} ${claim.predicate} ${claim.object}${quote ? ` (source quote: "${quote}")` : ''}`,
        status: claim.status,
      })
    }
  }

  // Source-evidence tier: chunk hits travel as their own evidence items,
  // capped in count (each chunk is already <= ~400 tokens by construction).
  // The prompt (answer.v1) forces statements grounded ONLY here to be
  // labeled uncurated and cited as [source:<id>].
  const chunkTitles = new Map<string, { source_id: string; chunk_id: string; title: string | null }>()
  for (const hit of hits) {
    if (hit.kind !== 'source_chunk' || !hit.source_id || !hit.chunk_id) continue
    if (chunkTitles.size >= EVIDENCE_SOURCE_CHUNKS) break
    const [chunk] = await db.select<{ content: string; heading: string | null }>('wk_source_chunks', {
      id: `eq.${hit.chunk_id}`,
      space_id: `eq.${spaceId}`,
      limit: 1,
    })
    if (!chunk) continue
    chunkTitles.set(hit.source_id, { source_id: hit.source_id, chunk_id: hit.chunk_id, title: hit.title || null })
    evidence.push({
      kind: 'source_chunk',
      slug: null,
      source_id: hit.source_id,
      text: `${hit.title ? `Source: ${hit.title}\n` : ''}${chunk.heading ? `${chunk.heading}\n` : ''}${chunk.content}`,
      status: null,
    })
  }

  const result = await llm.answer({ question: input.question, evidence })

  // Audit ledger — EVERY LLM call lands in wk_agent_runs (CONTRACTS §1.13).
  const [run] = await db.insert<{ id: string }>('wk_agent_runs', {
    space_id: spaceId,
    kind: 'answer',
    model: result.run.model,
    prompt_version: result.run.prompt_version,
    input_hash: result.run.input_hash,
    usage: JSON.stringify(result.run.usage),
    duration_ms: result.run.duration_ms,
  })

  // Citations resolve through the evidence actually shown to the model — a
  // cited slug we never loaded would be a hallucinated reference and is
  // dropped (the inline [slug] in the prose remains the model's own claim,
  // but the structured citations list only ever names real evidence).
  const citations = [...new Set(result.output.cited_slugs)]
    .filter((slug) => titles.has(slug))
    .map((slug) => ({ slug, title: titles.get(slug)! }))

  // Same anti-hallucination rule for the source tier: a cited source id we
  // never loaded as evidence is dropped.
  const sourceCitations = [...new Set(result.output.cited_source_ids)]
    .filter((sourceId) => chunkTitles.has(sourceId))
    .map((sourceId) => chunkTitles.get(sourceId)!)

  return {
    answer_markdown: result.output.answer_markdown,
    citations,
    not_in_knowledge_base: result.output.not_in_knowledge_base,
    agent_run_id: run!.id,
    source_citations: sourceCitations,
  }
}
