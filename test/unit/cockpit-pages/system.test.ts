// The System page's rules — chiefly the card that reports which revision
// markers this installation treats as reference targets.
//
// The defect this closes is not a missing feature, it is an invisible one: the
// configuration decides whether a page's evidence is measured at all, and until
// the installation reported it, an operator could only learn which markers were
// honoured by reading the source of the build they hoped they were running. A
// console that then printed the markers as a bare list would repeat the defect
// one surface later — "did I set that, or did it come with the product" is the
// first question, and a list of strings answers none of it.
//
// Nothing here names a marker literal. Every case builds its own strings,
// because the console renders whatever the API returned and a test that knew
// the value would be asserting against one deployment's database.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeFailure } from '../../../apps/cockpit/src/lib/failure.ts'
import {
  declarationSentence,
  originLegend,
  originStanding,
  scaffoldingMarkers,
  SCAFFOLDING_EFFECT,
  type KnowledgeConfig,
  type ScaffoldingMarker,
} from '../../../apps/cockpit/src/pages/system.logic.ts'

const BUILT_IN = 'structural-reference'

/** A response, built from whatever markers a case wants to talk about. */
function config(configured: boolean, items: ScaffoldingMarker[]): KnowledgeConfig {
  return { scaffolding_kinds: { env: 'WIKIKIT_SCAFFOLDING_KINDS', configured, items } }
}

describe('provenance is the point, not the list', () => {
  test('the three origins render as three different words', () => {
    const words = new Set(
      (['built_in', 'configured', 'fallback'] as const).map((origin) => originStanding(origin).label),
    )
    expect(words.size).toBe(3)
  })

  test('the three origins render as three different tones', () => {
    const tones = new Set(
      (['built_in', 'configured', 'fallback'] as const).map((origin) => originStanding(origin).tone),
    )
    expect(tones.size).toBe(3)
  })

  test('each origin says what an operator can do about it', () => {
    // A badge with no sentence behind it is a colour with a caption. The
    // shipped default is the one that has to earn its warning: it must say
    // that nobody here chose it.
    expect(originStanding('built_in').meaning).toContain('Configuration cannot remove it')
    expect(originStanding('configured').meaning).toContain('configuration')
    expect(originStanding('fallback').meaning).toContain('Nobody configured this')
  })

  test('a marker keeps its own provenance through the rows', () => {
    const rows = scaffoldingMarkers(
      config(true, [
        { kind: BUILT_IN, origin: 'built_in' },
        { kind: 'an-operators-own-marker', origin: 'configured' },
      ]),
    )
    expect(rows.map((row) => row.kind)).toEqual([BUILT_IN, 'an-operators-own-marker'])
    expect(rows[0]!.label).toBe(originStanding('built_in').label)
    expect(rows[1]!.label).toBe(originStanding('configured').label)
    expect(rows[0]!.label).not.toBe(rows[1]!.label)
  })

  test('the server’s order is kept, because it is the order the reads apply', () => {
    // Regrouping by provenance would look tidier and would be an order no part
    // of WikiKit uses.
    const kinds = ['first-marker', 'second-marker', 'third-marker']
    const rows = scaffoldingMarkers(
      config(true, [
        { kind: kinds[0]!, origin: 'configured' },
        { kind: kinds[1]!, origin: 'built_in' },
        { kind: kinds[2]!, origin: 'configured' },
      ]),
    )
    expect(rows.map((row) => row.kind)).toEqual(kinds)
  })

  test('an origin a newer server invents prints itself rather than passing as a known one', () => {
    const standing = originStanding('inherited-from-somewhere')
    expect(standing.label).toBe('inherited-from-somewhere')
    expect(standing.tone).toBe('unknown')
    // Never silently rendered as the reassuring one.
    expect(standing.label).not.toBe(originStanding('built_in').label)
  })
})

describe('the legend explains each provenance once', () => {
  test('only the origins actually present appear', () => {
    const legend = originLegend(
      config(false, [
        { kind: BUILT_IN, origin: 'built_in' },
        { kind: 'a-shipped-default', origin: 'fallback' },
      ]),
    )
    expect(legend.map((entry) => entry.origin)).toEqual(['built_in', 'fallback'])
    // The operator never set anything, so "set on this installation" must not
    // be explained at them.
    expect(legend.map((entry) => entry.origin)).not.toContain('configured')
  })

  test('a repeated origin is explained once, in first-appearance order', () => {
    const legend = originLegend(
      config(true, [
        { kind: BUILT_IN, origin: 'built_in' },
        { kind: 'one-marker', origin: 'configured' },
        { kind: 'another-marker', origin: 'configured' },
      ]),
    )
    expect(legend.map((entry) => entry.origin)).toEqual(['built_in', 'configured'])
  })
})

describe('"did I set that" is answered by the server, never derived from the rows', () => {
  test('an installation that configured exactly the built-in still reads as configured', () => {
    // The case the server sends `configured` for: identical items, opposite
    // answers. Deriving this sentence from the rows would tell one of these
    // two operators the reverse of the truth.
    const items: ScaffoldingMarker[] = [{ kind: BUILT_IN, origin: 'built_in' }]
    const wrote = declarationSentence(config(true, items))
    const wroteNothing = declarationSentence(config(false, items))
    expect(wrote).not.toBe(wroteNothing)
    expect(wrote).toContain('is set on this installation')
    expect(wroteNothing).toContain('is not set here')
  })

  test('the sentence names the variable the server named, not one the console remembers', () => {
    const renamed = { scaffolding_kinds: { env: 'A_LATER_NAME', configured: true, items: [] } }
    expect(declarationSentence(renamed)).toContain('A_LATER_NAME')
  })
})

describe('a configuration nobody added to still shows what is honoured', () => {
  test('the built-in marker alone is a card with a row in it, not an empty card', () => {
    // WikiKit's own marker is always in the list, so "nothing configured" is
    // never "nothing to show". A card that emptied itself here would teach an
    // operator that no page is exempt from measurement — the opposite of what
    // this installation does.
    const nothingConfigured = config(false, [{ kind: BUILT_IN, origin: 'built_in' }])
    const rows = scaffoldingMarkers(nothingConfigured)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe(BUILT_IN)
    expect(originLegend(nothingConfigured)).toHaveLength(1)
  })

  test('the empty branch is reachable only when the server reported no marker at all', () => {
    expect(scaffoldingMarkers(config(false, []))).toEqual([])
  })
})

describe('the card says what the configuration DOES', () => {
  test('one sentence, naming the two behaviours the markers change', () => {
    // A list of opaque strings is the defect one surface later. Both halves
    // have to be there: the index stops measuring evidence, and the linter
    // stops applying its fault rules.
    expect(SCAFFOLDING_EFFECT).toContain('reference target')
    expect(SCAFFOLDING_EFFECT).toContain('does not measure its evidence')
    expect(SCAFFOLDING_EFFECT).toContain('fault rules skip it')
    expect(SCAFFOLDING_EFFECT.split('. ')).toHaveLength(1)
  })
})

/**
 * The three things a pure-logic test cannot reach, read out of the page source
 * — the same device webhooks.test.ts uses, and for the same reason: the module
 * is a React component and this runner has no DOM.
 */
describe('an admin-only card is refused out loud, never hidden', () => {
  const source = readFileSync(join(import.meta.dir, '../../../apps/cockpit/src/pages/system.tsx'), 'utf8')
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n')

  test('the card is rendered unconditionally — no scope check gates it away', () => {
    expect(code).toContain('<Card data-testid="knowledge-config-card">')
    // `useCan()` anywhere on this page would mean the console keeping its own
    // copy of who may read what, and being wrong about it in the quiet
    // direction is exactly how a card disappears.
    expect(code).not.toMatch(/\buseCan\b/)
  })

  test('the refusal comes from the server, through DataState', () => {
    expect(code).toContain('query={knowledgeConfig}')
  })

  test('what a non-admin actually reads is a settled refusal with the server’s own words', () => {
    // `DataState` renders `describeFailure` for a failed read; a 403 from this
    // route is what a reader gets. Terminal, so no retry button — asking again
    // cannot grant a scope — and the server's message is carried verbatim.
    const notice = describeFailure({
      status: 403,
      message: 'insufficient_scope',
      actions: ['ask an administrator for the admin scope'],
    })
    expect(notice.title).toBe('Not permitted')
    expect(notice.retryable).toBe(false)
    expect(notice.message).toBe('insufficient_scope')
    expect(notice.actions).toEqual(['ask an administrator for the admin scope'])
  })

  test('the effect sentence reaches the reader, rather than being a constant nobody renders', () => {
    expect(code).toContain('{SCAFFOLDING_EFFECT}')
  })

  test('the page names no marker of its own', () => {
    // The console reports whatever the running installation holds. A literal
    // here would be this console describing the build somebody read rather
    // than the process somebody is running.
    expect(code).not.toContain(BUILT_IN)
  })
})
