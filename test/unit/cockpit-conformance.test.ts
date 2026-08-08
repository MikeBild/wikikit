// The conformance record, held against the rules it claims to record.
//
// contract/COCKPIT-UI.md never names a test — enforcement is per-product, and
// contract/conformance.cockpit-ui.json is WikiKit's honest account of it. That
// account is only worth having if it cannot quietly go stale, which is what
// this file is for: a rule added to the contract and not to the record would
// otherwise read as enforced by omission, and a test named in the record after
// being deleted would read as coverage that no longer exists.
//
// Deliberately NOT a test that every rule is enforced. Most are not, and the
// file says so. An empty `enforced_by` with a real `why` is a truthful entry.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const rules = readFileSync(join(root, 'contract', 'COCKPIT-UI.md'), 'utf8')
const conformance = JSON.parse(readFileSync(join(root, 'contract', 'conformance.cockpit-ui.json'), 'utf8')) as {
  contract: string
  rules: Record<string, { enforced_by: string[]; why?: string }>
}

/** Every rule id the contract declares, in the order it declares them. */
const declared = [...rules.matchAll(/\*\*(CUI-[A-Z0-9]+-\d+)\*\*/g)].map((match) => match[1]!)

describe('the conformance record covers the contract', () => {
  test('the contract declares rules at all', () => {
    // Guards the regex above: a formatting change that stopped matching would
    // otherwise make every assertion below vacuously true.
    expect(declared.length).toBeGreaterThan(30)
  })

  test('it names the contract it records', () => {
    expect(conformance.contract).toBe('cockpit-ui')
  })

  test('every declared rule has an entry', () => {
    const missing = declared.filter((id) => !(id in conformance.rules))
    expect(missing, `rules with no conformance entry:\n${missing.join('\n')}`).toEqual([])
  })

  test('every entry names a rule the contract declares', () => {
    // The other direction: a rule removed from the contract must not leave a
    // claim of coverage behind.
    const orphans = Object.keys(conformance.rules).filter((id) => !declared.includes(id))
    expect(orphans, `conformance entries for rules that no longer exist:\n${orphans.join('\n')}`).toEqual([])
  })
})

describe('every entry is honest', () => {
  test('an unenforced rule states why', () => {
    const silent = Object.entries(conformance.rules)
      .filter(([, entry]) => entry.enforced_by.length === 0 && !entry.why?.trim())
      .map(([id]) => id)
    expect(silent, `unenforced with no stated reason:\n${silent.join('\n')}`).toEqual([])
  })

  test('every named test file exists', () => {
    const ghosts: string[] = []
    for (const [id, entry] of Object.entries(conformance.rules)) {
      for (const file of entry.enforced_by) {
        if (!existsSync(join(root, file))) ghosts.push(`${id} → ${file}`)
      }
    }
    expect(ghosts, `conformance names files that do not exist:\n${ghosts.join('\n')}`).toEqual([])
  })

  test('the rules a token change would break are actually tested', () => {
    // The narrow claim this file is willing to make about coverage: the token
    // contract itself is the thing carried by copy, so it is the thing that
    // must not rest on review. Everything else may honestly be aspirational.
    for (const id of [
      'CUI-TOKEN-1',
      'CUI-TOKEN-2',
      'CUI-TOKEN-3',
      'CUI-TYPE-1',
      'CUI-MARK-1',
      'CUI-NAV-1',
      'CUI-NAV-2',
    ]) {
      expect(conformance.rules[id]?.enforced_by.length, `${id} must be enforced by a test`).toBeGreaterThan(0)
    }
  })
})
