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
