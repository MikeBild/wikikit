// classify.v3 — v2 plus an explicit generated-language contract.
//
// Source text and technical slugs remain untouched. When a source or its
// space pins en/de, model-authored concept titles must use that language. A
// second call may carry languageRepair after the deterministic dominance gate
// rejects the first attempt.
import type { ClassifyInput } from '../schemas.ts'

export const version = 'classify.v3'

export const system = `You are the classification stage of WikiKit, a knowledge system that maintains reviewed concept pages synthesized from archived sources.

You receive one new source document and a compact index of the concepts that already exist in this knowledge space. Decide which existing concepts this source materially affects and which genuinely new concepts it warrants.

Rules:
- "affected" lists slugs from the provided concept index only — a concept is affected when the source adds, changes, contradicts, or dates information a reader of that concept page would care about. Mere keyword overlap is not enough.
- "new" proposes concepts for substantial topics the source covers that no existing concept represents. Prefer updating an existing concept over creating a near-duplicate.
- New concept slugs are lowercase kebab-case (letters, digits, hyphens; must start with a letter or digit), stable and descriptive, e.g. "open-knowledge-format". Titles are short noun phrases.
- Be conservative: an unremarkable source may affect nothing and warrant nothing. Empty arrays are a correct answer.
- Never invent slugs for "affected" that are not in the index.`

function languageBlock(input: ClassifyInput): string {
  if (!input.language) return ''
  const label = input.language === 'de' ? 'German (de)' : 'English (en)'
  const repair = input.languageRepair
    ? 'The previous attempt used the wrong language. This is the one permitted repair attempt; check every generated title before responding.\n'
    : ''
  return `## Required output language

Write every model-authored human-readable title in ${label}. Keep stable slugs, product names, protocol names, URLs and source quotations unchanged.
${repair}
`
}

export function render(input: ClassifyInput): string {
  const index =
    input.conceptIndex.length === 0
      ? '(the space has no concepts yet)'
      : input.conceptIndex.map((c) => `- ${c.slug} — ${c.title}: ${c.summary}`).join('\n')
  const guidance = input.charter?.trim()
    ? `## Space guidance

The space maintainer set this charter. Honor its page-type and naming conventions when proposing new concepts.

${input.charter.trim()}

`
    : ''
  return `${languageBlock(input)}${guidance}## Concept index

${index}

## Source

Title: ${input.source.title ?? '(untitled)'}

<source_markdown>
${input.source.markdown}
</source_markdown>

Classify this source against the concept index.`
}
