// `?space=` survives navigation, or the console silently changes wiki.
//
// The defect this guards is the worst kind: nothing errors, nothing looks
// broken, and the reader is simply somewhere else. A `<Link>` with no `search`
// prop does not inherit the current query string — the router treats a missing
// `search` as an empty one — so clicking Pages while reading `?space=team-b`
// landed on `/cockpit/pages` with no space, the resolver fell through to the
// first wiki the credential could see, and the sidebar, the page body and every
// subsequent request quietly moved to a different one.
//
// `lib/space.ts` promises the opposite in so many words: "a link somebody
// pastes into chat has to open the same wiki for the person who receives it".
// This is what makes that a fact rather than a comment.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSpace } from '../../apps/cockpit/src/lib/space.ts'

const router = readFileSync(join(process.cwd(), 'apps', 'cockpit', 'src', 'router.tsx'), 'utf8')

describe('the router retains the wiki across every navigation', () => {
  test('the root route declares a retain middleware for space', () => {
    // Declared ONCE, on the root route. Three pages had remembered a
    // `search={(prev) => prev}` prop and fourteen link sites had not, which is
    // exactly how a per-call-site convention fails: silently, on the links
    // nobody thought about.
    expect(router).toContain('retainSearchParams')
    expect(router).toMatch(/search:\s*\{\s*middlewares:\s*\[retainSearchParams\(\['space'\]\)\]\s*\}/)
  })

  test('it is imported from the router package rather than hand-rolled', () => {
    expect(router).toMatch(/import\s*\{[\s\S]*?retainSearchParams[\s\S]*?\}\s*from\s*'@tanstack\/react-router'/)
  })

  test('the search schema still admits space, or retaining it would be pointless', () => {
    expect(router).toContain('validateSearch')
    expect(router).toMatch(/space\?\s*:\s*string/)
  })
})

describe('what the resolver does when the URL says nothing', () => {
  test('it falls through to the first wiki — which is why the URL must not lose it', () => {
    // Not a defect on its own: a bare `/cockpit/` has to open something. It is
    // the reason the retention above matters, so it is asserted here where the
    // two facts sit together.
    expect(resolveSpace(null, null, ['team-a', 'team-b'])).toBe('team-a')
  })

  test('a URL that names a wiki always wins over anything remembered', () => {
    expect(resolveSpace('team-b', 'team-a', ['team-a', 'team-b'])).toBe('team-b')
  })
})
