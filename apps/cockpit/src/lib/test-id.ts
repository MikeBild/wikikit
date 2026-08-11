const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
const OPAQUE = /\b[0-9a-f]{24,}\b/i
const VALID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Build readable, stable selectors without leaking database identifiers. */
export function testId(...segments: readonly (string | number | null | undefined)[]): string {
  const source = segments.filter((segment) => segment !== null && segment !== undefined).join('-')
  if (UUID.test(source) || OPAQUE.test(source)) throw new Error('Test IDs must not contain opaque identifiers')
  const value = source
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!VALID.test(value)) throw new Error('Test IDs must contain a readable identifier')
  return value
}
