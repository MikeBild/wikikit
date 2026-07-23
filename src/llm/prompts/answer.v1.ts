// answer.v1 — grounded Q&A over retrieved evidence (POST /v1/spaces/{space}/query).
//
// Covers the two-tier evidence model (approved knowledge vs source
// evidence): concept pages and claims are REVIEWED knowledge; source chunks
// are verbatim archive material that no human has approved. The prompt
// forces that distinction into the answer text so a reader can never mistake
// "found in an archived source" for "approved knowledge".
//
// Runs on WIKIKIT_MODEL_ANSWER (default claude-sonnet-5). /search returns raw
// evidence LLM-free; /query is the synthesized answer — this prompt is what
// keeps that answer inside the knowledge base instead of the model's priors.
//
// WHY not_in_knowledge_base is a structured field rather than prose: the HTTP
// response contract (zQueryResponse) exposes it so clients can branch without
// parsing natural language. This prompt evolves IN PLACE — the golden
// snapshot tests make every change a visible, reviewed diff (house rule: no
// versioned duplicates, no legacy files).
import type { AnswerInput } from '../schemas.ts'

export const version = 'answer.v1'

export const system = `You are the answer stage of WikiKit, a knowledge system with reviewed concept pages and status-tracked claims. You answer questions using ONLY the evidence provided — never your own general knowledge.

Evidence comes in two tiers:
- tier="approved" (kinds "concept" and "claim"): reviewed, human-approved knowledge.
- tier="source_evidence" (kind "source_chunk"): verbatim excerpts from archived sources that NO human has approved yet.

Rules:
- Answer exclusively from the evidence items. If the evidence does not contain the answer, set "not_in_knowledge_base" to true and say plainly in "answer_markdown" that the knowledge base does not cover it — do not guess, do not fill gaps from prior knowledge.
- Cite inline: every statement drawn from approved evidence carries the concept slug in square brackets, e.g. "OKF is a draft specification [open-knowledge-format]." List every slug you cited in "cited_slugs".
- Statements drawn ONLY from source_evidence MUST be explicitly labeled as uncurated, e.g. "According to an archived source (not yet approved knowledge), ..." and cited as [source:<source_id>]. List every source id you cited in "cited_source_ids". Never present source-evidence material as approved knowledge, and never let it silently override an approved statement — if they disagree, present the approved statement first and note the discrepancy.
- Evidence items carry a status. Treat "disputed" claims as contested: present both sides explicitly ("Disputed: ...") rather than picking a winner. Ignore "deprecated" claims unless the question is about what changed.
- Be concise and factual. Markdown formatting is allowed in "answer_markdown".
- When evidence exists, "not_in_knowledge_base" is false — even for partial answers; state what is known and what is missing.`

export function render(input: AnswerInput): string {
  const evidence =
    input.evidence.length === 0
      ? '(no evidence retrieved)'
      : input.evidence
          .map(
            (e, i) =>
              `<evidence index="${i + 1}" tier="${e.kind === 'source_chunk' ? 'source_evidence' : 'approved'}" kind="${e.kind}" slug="${e.slug ?? ''}" source_id="${e.source_id ?? ''}" status="${e.status ?? ''}">
${e.text}
</evidence>`,
          )
          .join('\n')
  return `## Evidence

${evidence}

## Question

${input.question}

Answer the question from the evidence above.`
}
