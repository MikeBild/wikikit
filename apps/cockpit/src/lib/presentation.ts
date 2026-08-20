const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
const HIDDEN_KEYS = /(^|_)(id|uuid)$/i

export function isUuidLike(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim())
}

export function semanticLabel(candidates: readonly (string | null | undefined)[], fallback: string): string {
  return candidates.find((candidate) => candidate?.trim() && !isUuidLike(candidate))?.trim() ?? fallback
}

/** Remove opaque database references only at the UI boundary; wire values remain untouched. */
export function presentValue(value: unknown, hidden = 'Internal reference hidden'): unknown {
  if (isUuidLike(value)) return hidden
  if (Array.isArray(value)) return value.map((entry) => presentValue(entry, hidden))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !HIDDEN_KEYS.test(key))
        .map(([key, entry]) => [key, presentValue(entry, hidden)]),
    )
  }
  return value
}

/**
 * Anything shaped like an opaque reference, whole or truncated.
 *
 * Deliberately looser than `UUID_PATTERN` above, which is a strict v1–v8
 * matcher used to decide whether a VALUE is an identifier. This one runs over
 * prose, where the thing to remove is whatever a reader would see as a machine
 * reference — including the truncated forms a log line or an ellipsis leaves
 * behind ("01a0103d-9c1f-…"), which the strict pattern would walk straight
 * past. The convention check reads the rendered page with the same loose
 * shape, so a title that satisfies the strict matcher and not this one would
 * pass review and fail the console.
 */
const OPAQUE_RUN_SOURCE = String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}(?:-[0-9a-f]{1,12})*-?(?:…|\.{3})?`
// Two objects, one shape. A single /g regex would carry `lastIndex` between a
// `replace` and a `test` and answer differently on the second call with the
// same input — the kind of bug that only shows up on the second row.
const OPAQUE_RUN_ALL = new RegExp(OPAQUE_RUN_SOURCE, 'gi')
const OPAQUE_RUN = new RegExp(OPAQUE_RUN_SOURCE, 'i')

/**
 * A clause left dangling by the removal.
 *
 * "… from source 8e065dc7-…" becomes "… from source", and a sentence that ends
 * on a preposition reads as a sentence somebody truncated — which is exactly
 * what happened, and exactly what should not be visible. Only a preposition
 * plus at most one following noun is taken, so a real ending is never eaten.
 */
const DANGLING_TAIL = /[\s,;:·]*\b(?:from|of|for|in|by|aus|von|für)\b(?:\s+[\p{L}][\p{L}-]*)?[\s.,;:·]*$/iu

export interface ReadableTitle {
  /** What to show. */
  text: string
  /** An opaque reference was removed, so the caller owes the reader a date. */
  redacted: boolean
}

/** Prose with every machine reference taken out, and no dangling clause left behind. */
export function withoutOpaqueRefs(value: string): string {
  const stripped = value
    .replace(OPAQUE_RUN_ALL, ' ')
    .replace(/\s{2,}/g, ' ')
    // The removal leaves the sentence's own punctuation floating: "… die Quelle
    // ." is a period somebody stranded, and it reads as damage rather than as a
    // sentence. Closing the gap keeps the period, which is the part that
    // belonged to the author.
    .replace(/\s+([.,;:!?])/g, '$1')
  const trimmed = (OPAQUE_RUN.test(value) ? stripped.replace(DANGLING_TAIL, '') : stripped).trim()
  return trimmed.replace(/[\s·:,;–—-]+$/u, '').trim()
}

/**
 * A title a person can read, out of one a machine wrote.
 *
 * The server composes proposal titles from whatever the source was called, and
 * an ingested coding session is called "Codex session 01a0103d-…" — so the
 * queue used to offer a reviewer a row identified by a number they cannot say
 * out loud, cannot search for and cannot tell apart from the next one (§5:
 * "Titel sind Zusammenfassungen, nie rohe Prompts oder UUIDs").
 *
 * The identifier is not repaired here and not hidden from the record: this is
 * the PRESENTATION boundary, the wire value is untouched, and the raw title
 * stays available in the row's own panel — it is a piece of evidence about
 * where something came from, which is a different job from naming it.
 *
 * What is left after the removal decides the outcome: a title that was only an
 * identifier has nothing to show and falls back, and one that had words keeps
 * them plus the date the caller appends, because "Codex session" alone would
 * make every session look like the same one.
 */
export function readableTitle(title: string | null | undefined, fallback: string): ReadableTitle {
  const source = title?.trim() ?? ''
  if (!source) return { text: fallback, redacted: false }
  if (!isOpaqueProse(source)) return { text: source, redacted: false }
  const text = withoutOpaqueRefs(source)
  // Two letters is the floor: what survives has to be a word, not the "v" left
  // over from a version prefix.
  return /\p{L}{2}/u.test(text) ? { text, redacted: true } : { text: fallback, redacted: true }
}

/** Whether a piece of prose carries a machine reference at all. */
export function isOpaqueProse(value: string): boolean {
  return OPAQUE_RUN.test(value)
}
