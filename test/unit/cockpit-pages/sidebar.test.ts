// What the sidebar remembers between reloads.
//
// The chrome is not a page, but the rule is the same kind of thing every rule
// under this directory is: something that decides what an operator sees, stated
// as a pure function so it can be proven without a browser. The sidebar is on
// every screen in the console, so "it forgets what I did" is a papercut met
// several times a day rather than an edge case.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSidebarOpen, SIDEBAR_STORAGE_KEY } from '../../../apps/cockpit/src/hooks/use-sidebar.ts'

describe('what the sidebar starts as', () => {
  test('a remembered collapse survives the reload', () => {
    // The whole finding: before this, the value was written and never read, so
    // the answer here was always the default.
    expect(resolveSidebarOpen('collapsed', true)).toBe(false)
  })

  test('a remembered expansion survives too', () => {
    expect(resolveSidebarOpen('expanded', false)).toBe(true)
  })

  test('with nothing remembered, the caller decides', () => {
    expect(resolveSidebarOpen(null, true)).toBe(true)
    expect(resolveSidebarOpen(null, false)).toBe(false)
  })

  test('a value nobody wrote falls back rather than throwing', () => {
    // localStorage is somewhere the reader can edit, and a console that refuses
    // to render its own chrome because of what is in there is a bad trade.
    expect(resolveSidebarOpen('true', true)).toBe(true)
    expect(resolveSidebarOpen('', false)).toBe(false)
    expect(resolveSidebarOpen('yes please', true)).toBe(true)
  })
})

describe('where it is remembered', () => {
  test('the key follows the console convention', () => {
    expect(SIDEBAR_STORAGE_KEY.startsWith('wk-cockpit-')).toBe(true)
  })

  test('the sidebar sets no cookie', () => {
    // A guard against a re-vendor, not against a typo. `components/ui/sidebar.tsx`
    // is copied in from a shared design contract, and the stock file writes a
    // `sidebar_state` cookie on `path=/` that nothing in a static bundle can
    // ever read — so it would ride every /v1/* and /mcp request carrying a fact
    // no server wants, and the sidebar would go back to forgetting. The comment
    // in that file says the deviation is deliberate; this makes the comment
    // enforceable. `lib/theme.ts` writes a cookie on purpose and is untouched
    // by this: the auth funnel is server-rendered and genuinely reads it.
    //
    // Comment lines are dropped before looking, because the comment that makes
    // this deviation legible names the very cookie it removed. Dropping lines
    // rather than stripping comment syntax out of the middle of lines keeps
    // this from ever misreading a `//` inside a string.
    const source = readFileSync(join(import.meta.dir, '../../../apps/cockpit/src/components/ui/sidebar.tsx'), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join('\n')
    expect(code).not.toContain('document.cookie')
    expect(code).not.toContain('sidebar_state')
  })
})
