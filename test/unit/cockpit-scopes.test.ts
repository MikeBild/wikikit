// The console's copy of the authorization rule, held against the server's.
//
// The cockpit has to decide what to render BEFORE it makes a request — which
// nav entries to show, which buttons to offer — so it cannot ask the server
// "would you allow this?" for each decision. That means two implication tables,
// and two copies of a rule are only tolerable when something compares them.
//
// This compares them over the full cross product. The failure it prevents is
// specific and has two directions: a console more permissive than its server
// offers buttons that 403, and a console stricter than its server hides work
// somebody is entitled to do — which is the worse of the two, because nothing
// on screen says it happened.
import { describe, expect, test } from 'bun:test'
import { holdsScope as serverHoldsScope } from '../../src/http/auth.ts'
import { holdsScope as consoleHoldsScope, VALID_SCOPES, scopesLabel } from '../../apps/cockpit/src/lib/scopes.ts'

/** Every scope set worth asking about: each scope alone, plus the interesting pairs. */
const SCOPE_SETS: readonly (readonly string[])[] = [
  [],
  ...VALID_SCOPES.map((scope) => [scope]),
  ['knowledge:read', 'knowledge:propose'],
  ['knowledge:read', 'knowledge:propose', 'knowledge:review'],
  ['knowledge:read', 'knowledge:approve'],
  ['admin', 'knowledge:read'],
  ['*', 'admin'],
]

describe('the console mirrors the server exactly', () => {
  test('agrees on every scope set × every scope', () => {
    const disagreements: string[] = []
    for (const scopes of SCOPE_SETS) {
      for (const candidate of VALID_SCOPES) {
        const server = serverHoldsScope(scopes, candidate)
        const client = consoleHoldsScope(scopes, candidate)
        if (server !== client) {
          disagreements.push(`[${scopes.join(',')}] → ${candidate}: server=${server} console=${client}`)
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  test('agrees on a scope neither has heard of', () => {
    // A scope added to the server and not yet to the console must be refused
    // by both, not waved through by the copy that does not know it.
    for (const scopes of SCOPE_SETS) {
      expect(consoleHoldsScope(scopes, 'knowledge:invent')).toBe(serverHoldsScope(scopes, 'knowledge:invent'))
    }
  })
})

describe('the rules that carry the product', () => {
  test('approve implies review, and never the reverse', () => {
    expect(consoleHoldsScope(['knowledge:approve'], 'knowledge:review')).toBe(true)
    expect(consoleHoldsScope(['knowledge:review'], 'knowledge:approve')).toBe(false)
  })

  test('holding review does not let anybody publish', () => {
    // The whole product rests on this: a reviewer can inspect a change; only
    // an approver can turn it into visible knowledge.
    expect(consoleHoldsScope(['knowledge:read', 'knowledge:propose', 'knowledge:review'], 'knowledge:approve')).toBe(
      false,
    )
  })

  test('an empty scope set holds nothing', () => {
    for (const candidate of VALID_SCOPES) expect(consoleHoldsScope([], candidate)).toBe(false)
  })
})

describe('scopesLabel names the shape of the scopes, not an invented role', () => {
  test.each([
    [['*'], 'unrestricted'],
    [['admin'], 'admin'],
    [['knowledge:read', 'knowledge:approve'], 'approver'],
    [['knowledge:read', 'knowledge:propose', 'knowledge:review'], 'reviewer'],
    [['knowledge:read', 'knowledge:propose'], 'contributor'],
    [['knowledge:read'], 'reader'],
  ])('%s reads as %s', (scopes, expected) => {
    expect(scopesLabel(scopes)).toBe(expected)
  })

  test('the words match the server role presets that expand into them', () => {
    // WikiKit stores no role — the presets are an expansion at key-creation
    // time. The console may still use their names, but only for scope sets the
    // server would actually have produced from them.
    expect(scopesLabel(['knowledge:read'])).toBe('reader')
    expect(scopesLabel(['knowledge:read', 'knowledge:propose'])).toBe('contributor')
  })
})
