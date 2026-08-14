import { toneFor, type Tone } from '@/pages/home.logic'

/**
 * What an Output IS to a reader, with no DOM under it.
 *
 * The list this file serves holds three things the database calls one thing:
 * an answer somebody asked for, a briefing the scheduler wrote overnight, and a
 * care report the same worker produced. Keeping them in one list is the whole
 * point — "what did this system tell me" is one question, and splitting it
 * across three pages is how the two nobody asked for become invisible. So the
 * rules that let one row carry three shapes live here rather than as conditions
 * inside a cell.
 *
 * Two of them carry the page:
 *
 *  - **A row's identity is its question, and only an answer has one.** A
 *    briefing has a title and a null question; reading `question` for every row
 *    would leave a third of the list nameless.
 *  - **`not_in_knowledge_base` is nullable, and null is not `false`.** The field
 *    is only meaningful for `kind = 'answer'`; on a briefing it is null because
 *    the question was never asked, not because the wiki knew the answer.
 *    Rendering that as "covered" would be the console inventing a measurement
 *    (CUI-SEV-2).
 *
 * Import-free of anything with a DOM in it, like `inbox.logic.ts`, so the unit
 * tier can prove these without a renderer. `toneFor` comes from `home.logic`
 * because the console has exactly one state → tone table and a second one here
 * would be a second reading of the same five words.
 */

/**
 * The kinds `wk_outputs.kind` allows, restated for the browser.
 *
 * Restated rather than imported — this module compiles for a browser and does
 * not reach into the server's — and it is the alphabet of the kind filter, so a
 * value the server grows and this list does not still renders (see `kindWord`),
 * it just cannot be filtered on until this line catches up.
 */
export const OUTPUT_KINDS: readonly string[] = ['answer', 'briefing', 'health']

/**
 * The three kinds in the reader's words.
 *
 * "Care report" rather than "Health report": the page it belongs to is called
 * Care, and a console that names one thing twice makes the reader work out that
 * they are the same thing.
 */
const KIND_WORDS: Record<string, string> = {
  answer: 'Answer',
  briefing: 'Briefing',
  health: 'Care report',
}

/**
 * An unrecognised kind prints ITSELF rather than being folded into one of the
 * three. A word from a newer server is still a word the server means, and
 * inventing a nicer one for it hides a vocabulary drift.
 */
export function kindWord(kind: string): string {
  return KIND_WORDS[kind] ?? kind
}

/** The fields of an Output this page reads. The response carries more. */
export interface OutputRow {
  kind: string
  title: string
  question: string | null
  citations: readonly { slug: string; title: string }[]
  not_in_knowledge_base: boolean | null
  promoted_ingest_id: string | null
}

export interface Standing {
  label: string
  tone: Tone
}

/**
 * Whether this row has been filed back into the wiki — the one state an Output
 * has, and it is derived rather than stored.
 *
 * `promoted_ingest_id` is the whole answer: promotion opens an ingest job and
 * writes its id here, and re-promoting returns the FIRST job, so the field is
 * set exactly once and never cleared. Deliberately NOT `succeeded` for the
 * unpromoted case and `failed` for nothing: an answer nobody filed is not a
 * failure, it is an answer nobody filed. That is the `unknown` state — visibly
 * present, visibly not a verdict.
 */
export function filingStanding(row: OutputRow): Standing {
  return row.promoted_ingest_id
    ? { label: 'In the wiki', tone: toneFor('succeeded') }
    : { label: 'Not filed', tone: toneFor('unknown') }
}

/**
 * What this row says about whether the wiki covered the question.
 *
 * Three values, not two, and the third is the reason this is a function: a
 * briefing's `not_in_knowledge_base` is null because nobody asked it anything,
 * which is a different fact from an answer whose question the wiki could not
 * cover — and from an answer it covered fine.
 */
export type Coverage = 'covered' | 'not-covered' | 'unknown'

export function coverageOf(row: OutputRow): Coverage {
  if (row.kind !== 'answer') return 'unknown'
  if (row.not_in_knowledge_base === true) return 'not-covered'
  if (row.not_in_knowledge_base === false) return 'covered'
  return 'unknown'
}

/**
 * The sentence a row is recognised by.
 *
 * The question for an answer, because that is what the person who asked it will
 * scan for; the title for everything else. The fallback is the caller's so this
 * module stays out of the business of naming a thing it has no words for.
 */
export function outputLabel(row: OutputRow, fallback: string): string {
  const candidates = row.kind === 'answer' ? [row.question, row.title] : [row.title, row.question]
  return candidates.find((candidate) => candidate?.trim())?.trim() ?? fallback
}

/** Whether the promote action has anything left to do on this row. */
export function promotable(row: OutputRow): boolean {
  return !row.promoted_ingest_id
}
