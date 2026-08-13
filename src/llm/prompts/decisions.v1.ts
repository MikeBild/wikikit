// decisions.v1 — mine one source for the settled choices it records, once per
// ingest, against the decisions the space already holds.
//
// WHY this is its own stage: a decision is a fact of the SOURCE ("we decided
// X"), but synthesis runs once per affected concept. Every concept call saw
// the same source, so every call re-emitted the same decision under its own
// slug and the decision log multiplied one choice into five. One call over the
// whole source can hold its own output in view and produce a distinct list;
// N independent calls cannot coordinate by construction.
//
// The existing ACTIVE decisions of the space ride the rendered input so the
// model can mark a choice as already recorded (duplicate_of) or as a change to
// one (updates), instead of proposing a near-copy. Those markers are advisory:
// the pipeline validates every slug against the real list and falls open to
// "new decision" — a human reviews the proposal either way.
//
// Runs on the strong model (WIKIKIT_MODEL_SYNTHESIS): deciding whether two
// German paraphrases are the same choice is the nuanced part of this pipeline,
// and it is one call per ingest rather than one per concept.
import type { ExtractDecisionsInput } from '../schemas.ts'

export const version = 'decisions.v1'

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
  return `${guidance}## Decisions this space already holds

${existing}

## Source (kind: ${kind})

Title: ${input.source.title ?? '(untitled)'}

<source_markdown>
${input.source.markdown}
</source_markdown>

Record the decisions this source settles.`
}
