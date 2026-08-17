// Which wiki the console opens, and why.
//
// A space IS a wiki, so the choice is the ADDRESS of what somebody is reading —
// not a preference. The rule below decides what a pasted link opens, which is
// the one thing a link must get right: two people following the same URL must
// land in the same wiki, whatever either of their browsers remembers.
import { describe, expect, test } from 'bun:test'
import {
  resolveSpace,
  sortSpaceOptions,
  SPACE_STORAGE_KEY,
  visibleSpaceOptions,
} from '../../../apps/cockpit/src/lib/space.ts'

const AVAILABLE = ['handbook', 'platform', 'research']

describe('resolving which wiki to show', () => {
  test('the URL wins over anything stored', () => {
    // The whole reason the slug is in the URL. A stored guess that could
    // override it would make a shared link open a different page for the
    // person who received it.
    expect(resolveSpace('research', 'handbook', AVAILABLE)).toBe('research')
  })

  test('the stored guess is used only when the URL says nothing', () => {
    expect(resolveSpace(null, 'platform', AVAILABLE)).toBe('platform')
  })

  test('with neither, it opens the first wiki the server listed', () => {
    expect(resolveSpace(null, null, AVAILABLE)).toBe('handbook')
  })

  test('a URL naming a wiki this credential cannot see lands somewhere readable', () => {
    // A link from somebody with wider access should not put a reader on a
    // wall. They see a wiki they can read; the sidebar shows which one.
    expect(resolveSpace('secret', null, AVAILABLE)).toBe('handbook')
  })

  test('a stale stored slug is ignored rather than followed', () => {
    // The wiki was deleted, or the credential narrowed. Either way the stored
    // value is now a lie about what exists.
    expect(resolveSpace(null, 'deleted', AVAILABLE)).toBe('handbook')
  })

  test('a credential that can see nothing resolves to nothing', () => {
    // Not an error and not a crash: a fresh installation has no wiki yet, and
    // the shell renders an empty state rather than a broken page.
    expect(resolveSpace('handbook', 'handbook', [])).toBeNull()
  })
})

describe('the storage key', () => {
  test('carries the console prefix, like every other stored value', () => {
    // CUI-TOKEN-3's sibling rule for storage: one prefix, so an operator
    // clearing this console's state can find all of it.
    expect(SPACE_STORAGE_KEY.startsWith('wk-cockpit-')).toBe(true)
  })
})

describe('production and test wikis in the switcher', () => {
  const OPTIONS = [
    { slug: 'z-test', environment: 'test' as const },
    { slug: 'z-production', environment: 'production' as const },
    { slug: 'a-production', environment: 'production' as const },
    { slug: 'a-test', environment: 'test' as const },
  ]

  test('sorts production first and alphabetizes inside both environments', () => {
    expect(sortSpaceOptions(OPTIONS).map((option) => option.slug)).toEqual([
      'a-production',
      'z-production',
      'a-test',
      'z-test',
    ])
  })

  test('hides test probes until requested but never hides the current wiki', () => {
    expect(visibleSpaceOptions(OPTIONS, 'a-production', false).map((option) => option.slug)).toEqual([
      'z-production',
      'a-production',
    ])
    expect(visibleSpaceOptions(OPTIONS, 'z-test', false).map((option) => option.slug)).toEqual([
      'z-test',
      'z-production',
      'a-production',
    ])
    expect(visibleSpaceOptions(OPTIONS, 'a-production', true)).toEqual(OPTIONS)
  })
})
