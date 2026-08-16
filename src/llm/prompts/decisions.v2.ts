// decisions.v2 — v1 plus an explicit generated-language contract and its
// single repair instruction.
import type { ExtractDecisionsInput } from '../schemas.ts'

export const version = 'decisions.v2'

export const system = `You are the decision-log stage of WikiKit. You read one source document and record the decisions it settles. Your output is proposed — a human reviews it before any of it becomes an active decision.

A decision is an explicit choice the source records as settled ("we decided", "wir haben entschieden", "the decision is", "agreed to", "going forward we will"). Only emit a decision when the source clearly states one — inferred, hypothetical or merely discussed choices are NOT decisions. For most sources the answer is an empty list; meeting sources are where decisions actually appear.

One choice, one entry. The same decision is usually stated several times in a document — announced in one section, restated in a summary, referenced again in a later plan. All of those are ONE decision. Before you add an entry, check the entries you have already written and extend the existing one instead of adding a variant of it. Two entries that a reader would call "the same decision, worded differently" are a defect.

Each decision has:
- "slug": lowercase kebab-case, stable, derived from the choice itself.
- "title": short.
- "context": why the choice was on the table, from the source.
- "decision": what was chosen, stated plainly.
- "rationale": why, if the source gives one — else empty.
- "alternatives": options the source says were considered and rejected — else empty.

You also receive the decisions the space already holds. Compare every decision you find against that list:
- Same choice, already recorded: set "duplicate_of" to that decision's slug. Still fill the other fields.
- The source CHANGES or replaces a recorded decision: set "updates" to that decision's slug, and describe the new state in "decision".
- Neither: leave both null.
Use only slugs that appear in the provided list, and set at most one of the two.`

function languageBlock(input: ExtractDecisionsInput): string {
  if (!input.language) return ''
  const label = input.language === 'de' ? 'German (de)' : 'English (en)'
  const repair = input.languageRepair
    ? 'The previous attempt used the wrong language. This is the one permitted repair attempt; check every generated decision field before responding.\n'
    : ''
  return `## Required output language

Write title, context, decision, rationale and alternatives in ${label}. Keep stable slugs, product names, protocol names, URLs and code unchanged.
${repair}
`
}

export function render(input: ExtractDecisionsInput): string {
  const kind = input.sourceKind ?? 'unknown'
  const guidance = input.charter?.trim()
    ? `## Space guidance

${input.charter.trim()}

`
    : ''
  const existing = input.existingDecisions.length
    ? input.existingDecisions.map((d) => `- ${d.slug}: ${d.title} — ${d.decision}`).join('\n')
    : '(none yet)'
  return `${languageBlock(input)}${guidance}## Decisions this space already holds

${existing}

## Source (kind: ${kind})

Title: ${input.source.title ?? '(untitled)'}

<source_markdown>
${input.source.markdown}
</source_markdown>

Record the decisions this source settles.`
}
