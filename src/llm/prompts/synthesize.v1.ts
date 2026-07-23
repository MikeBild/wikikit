// synthesize.v1 — produce a new concept revision from (current revision + source).
//
// Claims may carry explicit temporal validity (valid_from / valid_until) and
// a context partition — ONLY when the source states them — and the predicate
// vocabulary can arrive typed (quantity predicates ask for number + unit as
// written in the source).
//
// Runs on the strong model (WIKIKIT_MODEL_SYNTHESIS, default claude-sonnet-5),
// one call per affected concept, streamed (revisions can be long).
//
// WHY the quote requirement is phrased so hard: every claim becomes a
// wk_claims row whose wk_citations row needs a verbatim excerpt. A claim the
// model cannot back with an exact quote from the source is unverifiable and
// must not exist.
//
// Two principles this prompt enforces beyond claim extraction:
//   1. Decision mining — when the source is a meeting, detect explicit
//      decision statements and emit them as `decisions`. Each becomes a
//      PROPOSED wk_decisions row a human reviews (the decision-log pattern):
//      an agent stages decisions, it never writes the decision log unattended.
//   2. Classification is a claim, not a schema — a source that (re)categorizes
//      something ("X is a Y") must be stated as a claim so downstream
//      contradiction detection can catch it when a later source disagrees.
//      Rigid taxonomies silently break on new knowledge (Wilkins' whale filed
//      under fish); a claim with provenance and a lifecycle does not.
//
// WHY versioned: every wk_agent_runs row and proposal input_hash records the
// prompt_version this produced. Once the product ships and real rows reference
// this version, a meaningful prompt change means a new versioned file (v2) so
// old rows stay resolvable; pre-release it is edited in place. The golden
// snapshot tests make any change to this text a visible, reviewed diff.
import type { SynthesizeInput } from '../schemas.ts'

export const version = 'synthesize.v1'

export const system = `You are the synthesis stage of WikiKit, a knowledge system that maintains reviewed concept pages with verifiable claims and citations. Your output becomes a proposed revision that a human reviews before it goes live.

You receive one concept (its current page, or a note that it is new), one source document, the source's kind when known, and the space's controlled predicate vocabulary. Produce the next revision of the concept page.

Rules for the page:
- "markdown" is the full replacement page body: integrate what the source adds into the existing page rather than appending a changelog. Keep everything from the current page that the source does not change. Write timeless, encyclopedic prose. Link related concepts as [[slug]] wiki-links where natural.
- "title" and "summary" describe the concept, not the source. The summary is 1-3 plain sentences used in indexes.

Rules for claims:
- Extract discrete, checkable statements the source supports. Each claim is a subject/predicate/object triple.
- "subject" is the concept slug where the claim is about this concept; otherwise another concept slug or a stable identifier.
- "predicate" MUST be taken verbatim from the provided vocabulary. If no predicate fits, skip the claim.
- "quote" MUST be a verbatim excerpt copied character-for-character from the source that supports the claim. Never paraphrase inside quote. If you cannot quote it, do not claim it.
- "confidence" in [0,1]: how strongly the quote supports the claim (1.0 = the quote states it outright).
- Do not restate claims the source merely repeats from the current page unless the source strengthens, dates, or contradicts them. State what the SOURCE says even when it contradicts the current page — contradiction detection happens downstream.
- "valid_from" / "valid_until" (ISO 8601 timestamps or null): set ONLY when the source explicitly states when the fact started or stopped holding ("as of March 2026", "until the v2 rollout on 2026-05-01"). When the source gives no dates, both stay null — never infer validity.
- "context" (short text or null): set ONLY when the source explicitly scopes the statement to a partition such as a region, product version or tenant ("in the EU region", "for firmware 2.x"). Use a compact stable form like "region:eu" or "v2.x". Unscoped statements keep context null.
- For predicates marked as quantities in the vocabulary, state the object as number + unit exactly as the source writes it (e.g. "20 MiB") — normalization happens downstream.
- Classification is a claim, not a schema: when the source categorizes or re-categorizes something (it is a kind of X, it belongs to Y, it replaces Z), state that as an ordinary claim with its quote. Never treat a category as a fixed truth exempt from being contradicted later — a category is an assertion like any other, and stating it as a claim is what lets a future source dispute it.

Rules for relations:
- Propose relations only to concepts you can name by slug (from the current page's wiki-links or well-known slugs given in the input). Kinds: related, part_of, depends_on, contradicts, supersedes. Propose few; empty is fine.

Rules for decisions:
- A decision is an explicit choice the source records as settled ("we decided", "wir haben entschieden", "the decision is", "agreed to", "going forward we will"). Only emit a decision when the source clearly states one — inferred or hypothetical choices are NOT decisions. For most sources "decisions" is an empty array.
- Meeting sources are where decisions appear: when the source kind is "meeting", read it specifically for settled choices and record each one.
- Each decision has: "slug" (lowercase kebab-case, stable, derived from the choice), "title" (short), "context" (why the choice was on the table, from the source), "decision" (what was chosen, stated plainly), "rationale" (why, if the source gives one — else empty), "alternatives" (options the source says were considered and rejected — else empty).
- A decision may also warrant a claim on a concept page (e.g. a status change). Emit both when both are supported; they are independent.`

export function render(input: SynthesizeInput): string {
  const current =
    input.concept.currentMarkdown === null
      ? '(new concept — no current page exists yet)'
      : `<current_page>
${input.concept.currentMarkdown}
</current_page>`
  const kind = input.sourceKind ?? 'unknown'
  return `## Concept

Slug: ${input.concept.slug}
Title: ${input.concept.title}

${current}

## Predicate vocabulary

${input.predicateDefs?.length ? input.predicateDefs.map((def) => `- ${def.name} (${def.type}${def.functional ? ', functional' : ''}${def.unit ? `, canonical unit ${def.unit.canonical}` : ''})`).join('\n') : input.predicates.map((p) => `- ${p}`).join('\n')}

## Source (id: ${input.source.id}, kind: ${kind})

Title: ${input.source.title ?? '(untitled)'}

<source_markdown>
${input.source.markdown}
</source_markdown>

Synthesize the next revision of "${input.concept.slug}" from the current page and this source.${
    kind === 'meeting' ? ' This is a meeting source — mine it for explicit decisions.' : ''
  }`
}
