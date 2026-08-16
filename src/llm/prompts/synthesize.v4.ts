// synthesize.v4 — v3 plus an explicit generated-language contract and its
// single repair instruction. Claims remain grounded by verbatim source quotes;
// language never authorizes translating a citation or technical identifier.
import type { SynthesizeInput } from '../schemas.ts'

export const version = 'synthesize.v4'

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

Decisions are NOT your job: a separate stage reads the whole source for settled choices. When the source records a decision that belongs on this page (e.g. a status change), state it as an ordinary claim with its quote.`

function languageBlock(input: SynthesizeInput): string {
  if (!input.language) return ''
  const label = input.language === 'de' ? 'German (de)' : 'English (en)'
  const repair = input.languageRepair
    ? 'The previous attempt was not predominantly in the required language. This is the one permitted repair attempt; check title, summary, page prose and natural-language claim objects before responding.\n'
    : ''
  return `## Required output language

Write title, summary, Markdown prose and natural-language claim objects in ${label}. Controlled predicate identifiers, stable slugs, product names, protocol names, URLs, code and verbatim source quotes remain unchanged.
${repair}
`
}

export function render(input: SynthesizeInput): string {
  const current =
    input.concept.currentMarkdown === null
      ? '(new concept — no current page exists yet)'
      : `<current_page>
${input.concept.currentMarkdown}
</current_page>`
  const kind = input.sourceKind ?? 'unknown'
  const guidance = input.charter?.trim()
    ? `## Space guidance

The space maintainer set this charter. Follow its emphasis, voice and page conventions when writing the page — without ever loosening the claim/quote grounding rules.

${input.charter.trim()}

`
    : ''
  return `${languageBlock(input)}${guidance}## Concept

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

Synthesize the next revision of "${input.concept.slug}" from the current page and this source.`
}
