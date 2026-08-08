/**
 * Whether a draft differs from what was loaded — the decision behind an
 * unsaved-work guard.
 *
 * Deliberately a baseline diff and NOT a `touched` flag. A touched flag says a
 * field was focused, which is not the same as changed: typing a character and
 * deleting it again leaves a form that warns about losing work that does not
 * exist. An operator who meets that warning twice stops reading it, and the
 * third time is the one where the work was real. Comparing against the baseline
 * means editing a value back to what it was makes the form clean again, which is
 * both what an operator expects and what keeps the warning worth reading.
 *
 * Lifted out of the charter editor's `forms/use-dirty.ts`, minus its React half,
 * because the decision is what a test can hold and this repository's runner has
 * no DOM.
 */

/**
 * A stable serialisation for comparison.
 *
 * `JSON.stringify` on two objects differing only in key order reports a change
 * nobody made — which, for a dirty flag, is an unsaved-changes prompt on a form
 * nobody touched.
 */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalise(entry)]),
    )
  }
  return value
}

export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalise(left)) === JSON.stringify(canonicalise(right))
}

/**
 * True when there is work a close would throw away.
 *
 * `canonical` exists for the values the wire and the editor disagree about — a
 * markdown document that arrived without a trailing newline and gained one from
 * a textarea is the same document, and only the caller knows that.
 */
export function isDirty<T>(current: T, baseline: T, canonical: (value: T) => unknown = (value) => value): boolean {
  return !sameValue(canonical(current), canonical(baseline))
}

/**
 * The canonical form of a markdown document, for the charter editor.
 *
 * A charter is markdown a space governs itself by, and every edit to it mints a
 * new version — so "is this dirty?" decides both an unsaved-work warning and
 * whether a version gets cut at all. Trailing whitespace on the last line and
 * the presence of a final newline are differences a textarea manufactures and a
 * reader cannot see. Warning about them, or versioning them, would be treating
 * work nobody did as a change to the document.
 */
export function canonicalMarkdown(text: string): string {
  return text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
}
