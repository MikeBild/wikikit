// classify.v2 — route one source document against the space's concept index,
// with optional per-space Charter steering.
//
// Runs on the cheap/fast model (WIKIKIT_MODEL_CLASSIFY, default
// claude-haiku-4-5): one call per ingested source, small structured output.
//
// WHY system/render split: the system block is byte-identical across every
// call and carries cache_control — the per-source material lives entirely in
// render() so the cached prefix never invalidates (prompt caching is a prefix
// match). The space Charter, when set, is human-owned guidance on page types +
// naming conventions; it rides render() (NOT the cached system block) and steers
// the slugs/titles proposed for new concepts.
//
// WHY versioned (v2): the system prompt is unchanged from v1; render() gained
// the optional `## Space guidance` section. Every wk_agent_runs row records the
// prompt_version — a meaningful change is a version bump (goldens enforce this).
import type { ClassifyInput } from '../schemas.ts'

export const version = 'classify.v2'

export const system = `You are the classification stage of WikiKit, a knowledge system that maintains reviewed concept pages synthesized from archived sources.

You receive one new source document and a compact index of the concepts that already exist in this knowledge space. Decide which existing concepts this source materially affects and which genuinely new concepts it warrants.

Rules:
- "affected" lists slugs from the provided concept index only — a concept is affected when the source adds, changes, contradicts, or dates information a reader of that concept page would care about. Mere keyword overlap is not enough.
- "new" proposes concepts for substantial topics the source covers that no existing concept represents. Prefer updating an existing concept over creating a near-duplicate.
- New concept slugs are lowercase kebab-case (letters, digits, hyphens; must start with a letter or digit), stable and descriptive, e.g. "open-knowledge-format". Titles are short noun phrases.
- Be conservative: an unremarkable source may affect nothing and warrant nothing. Empty arrays are a correct answer.
- Never invent slugs for "affected" that are not in the index.`

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
  return `${guidance}## Concept index

${index}

## Source

Title: ${input.source.title ?? '(untitled)'}

<source_markdown>
${input.source.markdown}
</source_markdown>

Classify this source against the concept index.`
}
