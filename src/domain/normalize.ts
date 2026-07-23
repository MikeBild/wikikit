// Object normalization for typed predicates (0021) — pure, deterministic,
// best-effort BY CONTRACT: an unparseable object normalizes to its trimmed
// original and never errors, because normalization is an additive comparison
// aid, not a validation gate. The canonical form is computed server-side at
// staging (never caller-supplied) so there is exactly one normalizer.
//
// Unit conversion uses ONLY the space-declared factors from the predicate
// registry — no built-in unit ontology: 'MiB' means whatever the space says
// it means, and an undeclared unit passes through verbatim. Deterministic and
// auditable over clever.

/** One entry of wk_spaces.settings.predicate_defs — the typed predicate registry. */
export interface PredicateDef {
  name: string
  type: 'string' | 'number' | 'quantity' | 'date' | 'enum' | 'reference'
  functional: boolean
  /** quantity only: canonical unit + accepted aliases with multiplication factors. */
  unit?: { canonical: string; accept: Record<string, number> }
  enum_values?: string[]
}

export interface NormalizedObject {
  /** Canonical comparison form (wk_claims.object_normalized). */
  normalized: string
  /** Parsed numeric value for number/quantity types (wk_claims.object_value_num). */
  valueNum: number | null
  /** Canonical unit after conversion (wk_claims.object_unit). */
  unit: string | null
}

const NUMBER_PATTERN = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/

function fallback(object: string): NormalizedObject {
  return { normalized: object.trim(), valueNum: null, unit: null }
}

/** Trim + collapse whitespace + lowercase — the string-type canonical form. */
function canonicalString(object: string): string {
  return object.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function normalizeObject(def: PredicateDef | undefined, object: string): NormalizedObject {
  if (!def) return fallback(object)
  const trimmed = object.trim()
  switch (def.type) {
    case 'number': {
      if (!NUMBER_PATTERN.test(trimmed)) return fallback(object)
      const value = Number(trimmed)
      if (!Number.isFinite(value)) return fallback(object)
      return { normalized: String(value), valueNum: value, unit: null }
    }
    case 'quantity': {
      // "<number> <unit>" — the unit resolves through the declared factors.
      const match = trimmed.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(\S.*)$/)
      if (!match || !def.unit) return fallback(object)
      const raw = Number(match[1])
      if (!Number.isFinite(raw)) return fallback(object)
      const unitToken = match[2]!.trim()
      const factor =
        unitToken === def.unit.canonical ? 1 : (def.unit.accept[unitToken] ?? def.unit.accept[unitToken.toLowerCase()])
      if (factor === undefined) return fallback(object)
      const value = raw * factor
      return { normalized: `${value} ${def.unit.canonical}`, valueNum: value, unit: def.unit.canonical }
    }
    case 'date': {
      const parsed = Date.parse(trimmed)
      if (Number.isNaN(parsed)) return fallback(object)
      // Date-only inputs canonicalize to the date; timestamps to the instant.
      const iso = new Date(parsed).toISOString()
      const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? iso.slice(0, 10) : iso
      return { normalized, valueNum: parsed, unit: null }
    }
    case 'enum': {
      const canonical = canonicalString(object)
      const hit = def.enum_values?.find((value) => canonicalString(value) === canonical)
      return hit ? { normalized: hit, valueNum: null, unit: null } : fallback(object)
    }
    case 'reference':
    case 'string':
    default:
      return { normalized: canonicalString(object), valueNum: null, unit: null }
  }
}

/**
 * Case-insensitive exact alias resolution (settings.aliases: alias →
 * canonical concept slug). Applied ONCE at staging so stored claims are
 * always canonical — apply, lint and the frame index need zero alias
 * awareness.
 */
export function resolveAlias(aliases: Record<string, unknown> | undefined, subject: string): string {
  if (!aliases) return subject
  const needle = subject.trim().toLowerCase()
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (typeof canonical === 'string' && alias.trim().toLowerCase() === needle) return canonical
  }
  return subject
}
