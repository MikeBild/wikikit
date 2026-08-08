/**
 * The authorization model, as the console understands it.
 *
 * WHY a second copy exists at all: the console has to decide what to render
 * before it makes a request — which nav entries to show, which buttons to
 * offer. It cannot ask the server "would you allow this?" for every one of
 * those decisions, so it has to know the rule. That means two copies of the
 * implication table, and two copies of anything is only tolerable when a test
 * compares them: `test/unit/cockpit-scopes.test.ts` runs this module against
 * `src/http/auth.ts`'s `holdsScope` over the full cross product of scope-set
 * and scope, so a divergence is a failed build rather than a console that hides
 * a page the server would have served.
 *
 * This module is pure and DOM-free on purpose, for the same reason
 * `lib/theme-store.ts` and `lib/tokens.ts` are: it is a rule, not a view, and a
 * rule should not need a browser to prove it behaves.
 */

/** The closed scope alphabet, in the order `src/http/auth.ts` declares it. */
export const VALID_SCOPES = [
  'knowledge:read',
  'knowledge:propose',
  'knowledge:review',
  'knowledge:approve',
  'admin',
  '*',
] as const

export type Scope = (typeof VALID_SCOPES)[number]

export function isScope(value: string): value is Scope {
  return (VALID_SCOPES as readonly string[]).includes(value)
}

/**
 * Does this scope set satisfy a requirement?
 *
 * A mirror of `holdsScope` in `src/http/auth.ts`, and deliberately not an
 * improvement on it. `knowledge:approve` implies `knowledge:review` and never
 * the reverse — review is the inspect subset of approve — and `admin` reaches
 * every other scope including `*`. Mirroring that faithfully matters more than
 * it reading tidily: a console more permissive than its server shows buttons
 * that 403, a console stricter than its server hides work somebody is entitled
 * to do, and changing the rule is a server decision, not a rendering one.
 */
export function holdsScope(scopes: readonly string[], candidate: string): boolean {
  return (
    scopes.includes('*') ||
    scopes.includes(candidate) ||
    (candidate !== 'admin' && scopes.includes('admin')) ||
    (candidate === 'knowledge:review' && scopes.includes('knowledge:approve'))
  )
}

/**
 * The word the shell's footer prints under the operator's name.
 *
 * WikiKit stores no role — a key holds scopes and a session inherits them at
 * mint time, and the role presets exist only as an expansion at key-creation
 * time. So this names the shape the scopes have rather than inventing an
 * authority level the server has never heard of.
 */
export function scopesLabel(scopes: readonly string[]): string {
  if (scopes.includes('*')) return 'unrestricted'
  if (scopes.includes('admin')) return 'admin'
  if (scopes.includes('knowledge:approve')) return 'approver'
  if (scopes.includes('knowledge:review')) return 'reviewer'
  if (scopes.includes('knowledge:propose')) return 'contributor'
  if (scopes.includes('knowledge:read')) return 'reader'
  return scopes.length === 1 ? scopes[0]! : `${scopes.length} scopes`
}
