/**
 * The starter template for a wiki that has no guidelines yet, with no DOM under
 * it.
 *
 * WHY a template at all: the guidelines are the single most practical lever a
 * new wiki has — every classification and synthesis job reads them, so they
 * decide what gets written and how — and an empty textarea is exactly what
 * makes somebody skip them. "Write the rules that guide synthesis" is true and
 * unanswerable; six named questions are answerable in five minutes.
 *
 * WHY six fields composed into Markdown rather than six columns: the guidelines
 * are a DOCUMENT. They are read by a model as prose, edited afterwards as prose,
 * and versioned as prose. A schema behind them would turn every later thought
 * that does not fit one of six boxes into a field somebody has to add, and it
 * would make the round trip through `PUT /charter` lossy. So this is a form that
 * writes a first draft and then gets out of the way — the operator lands in the
 * ordinary editor with text in it, and nothing here is ever read back.
 *
 * The section headings are the CALLER's, passed in rather than baked in: this
 * console is localized, and a German wiki whose guidelines carry English
 * headings is a document that reads as though it were written for somebody
 * else.
 */

export interface GuidelinesDraft {
  purpose: string
  belongs: string
  excluded: string
  pageTypes: string
  emphasis: string
  voice: string
}

export type GuidelinesField = keyof GuidelinesDraft

/** The order the questions are asked in, which is also the order they compose in. */
export const GUIDELINES_FIELDS: readonly GuidelinesField[] = [
  'purpose',
  'belongs',
  'excluded',
  'pageTypes',
  'emphasis',
  'voice',
]

export const EMPTY_GUIDELINES: GuidelinesDraft = {
  purpose: '',
  belongs: '',
  excluded: '',
  pageTypes: '',
  emphasis: '',
  voice: '',
}

/**
 * The six answers as one Markdown document.
 *
 * A section with nothing in it is LEFT OUT rather than emitted with an empty
 * body. Half-filled is the normal state of a first draft, and a document full
 * of headings followed by nothing teaches the model that this wiki has no
 * opinion about those things — which is a different claim from not having said
 * yet.
 */
export function composeGuidelines(draft: GuidelinesDraft, headings: Record<GuidelinesField, string>): string {
  return GUIDELINES_FIELDS.filter((field) => draft[field].trim())
    .map((field) => `## ${headings[field]}\n\n${draft[field].trim()}\n`)
    .join('\n')
}

/** Whether the operator has answered anything at all. */
export function guidelinesStarted(draft: GuidelinesDraft): boolean {
  return GUIDELINES_FIELDS.some((field) => draft[field].trim().length > 0)
}
