// normalize.ts — the pure object normalizer behind wk_claims.object_normalized.
// Best-effort BY CONTRACT: unparseable input falls back to the trimmed
// original and never throws.
import { describe, expect, test } from 'bun:test'
import { normalizeObject, resolveAlias, type PredicateDef } from '../../src/domain/normalize.ts'

const quantity: PredicateDef = {
  name: 'max_upload',
  type: 'quantity',
  functional: true,
  unit: { canonical: 'MiB', accept: { GiB: 1024, KiB: 1 / 1024, MiB: 1 } },
}

describe('normalizeObject', () => {
  test('no definition → trimmed passthrough', () => {
    expect(normalizeObject(undefined, '  raw value ')).toEqual({ normalized: 'raw value', valueNum: null, unit: null })
  })

  test('string type canonicalizes case and whitespace', () => {
    const def: PredicateDef = { name: 'is', type: 'string', functional: true }
    expect(normalizeObject(def, '  Production   Ready ')).toEqual({
      normalized: 'production ready',
      valueNum: null,
      unit: null,
    })
  })

  test('number type parses; garbage falls back', () => {
    const def: PredicateDef = { name: 'count', type: 'number', functional: false }
    expect(normalizeObject(def, '42.50')).toEqual({ normalized: '42.5', valueNum: 42.5, unit: null })
    expect(normalizeObject(def, 'many')).toEqual({ normalized: 'many', valueNum: null, unit: null })
  })

  test('quantity converts declared units to the canonical one', () => {
    expect(normalizeObject(quantity, '1 GiB')).toEqual({ normalized: '1024 MiB', valueNum: 1024, unit: 'MiB' })
    expect(normalizeObject(quantity, '1024 MiB')).toEqual({ normalized: '1024 MiB', valueNum: 1024, unit: 'MiB' })
    // Undeclared unit → verbatim fallback (no built-in ontology).
    expect(normalizeObject(quantity, '3 parsec')).toEqual({ normalized: '3 parsec', valueNum: null, unit: null })
  })

  test('date type canonicalizes to ISO; date-only stays date-only', () => {
    const def: PredicateDef = { name: 'released_on', type: 'date', functional: true }
    expect(normalizeObject(def, '2026-07-23')).toEqual({
      normalized: '2026-07-23',
      valueNum: Date.parse('2026-07-23'),
      unit: null,
    })
    expect(normalizeObject(def, 'not a date')).toEqual({ normalized: 'not a date', valueNum: null, unit: null })
  })

  test('enum snaps case-insensitively onto the declared value', () => {
    const def: PredicateDef = { name: 'tier', type: 'enum', functional: true, enum_values: ['Free', 'Pro'] }
    expect(normalizeObject(def, 'pro').normalized).toBe('Pro')
    expect(normalizeObject(def, 'enterprise').normalized).toBe('enterprise') // undeclared → fallback
  })

  test('is deterministic', () => {
    expect(normalizeObject(quantity, '2 GiB')).toEqual(normalizeObject(quantity, '2 GiB'))
  })
})

describe('resolveAlias', () => {
  test('case-insensitive exact match resolves to the canonical slug', () => {
    const aliases = { 'The Device A': 'device-a', 'Gerät B': 'device-b' }
    expect(resolveAlias(aliases, 'the device a')).toBe('device-a')
    expect(resolveAlias(aliases, 'Gerät B')).toBe('device-b')
    expect(resolveAlias(aliases, 'unrelated')).toBe('unrelated')
    expect(resolveAlias(undefined, 'anything')).toBe('anything')
  })
})
