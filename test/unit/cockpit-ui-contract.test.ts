// The cockpit-ui contract, held against the bytes that claim to implement it.
//
// contract/cockpit-ui.css is not a stylesheet — nothing imports it, nothing
// builds it. It is the bytes that must appear between the sentinels in
// apps/cockpit/src/index.css, stored once so a test can compare against
// something rather than against a promise. Its sha256 IS the contract's
// identity; a hand-typed version number can claim agreement while the bytes
// diverge, and that is precisely the failure this replaces.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RADIUS, TOKENS, STATE_TOKEN, STATUS_STATE, SEVERITY_STATE } from '../../apps/cockpit/src/lib/tokens.ts'

const root = process.cwd()
const contract = readFileSync(join(root, 'contract', 'cockpit-ui.css'), 'utf8')
const indexCss = readFileSync(join(root, 'apps', 'cockpit', 'src', 'index.css'), 'utf8')
const rules = readFileSync(join(root, 'contract', 'COCKPIT-UI.md'), 'utf8')

const REGIONS = ['tokens-light', 'tokens-dark', 'theme-map'] as const

/**
 * The declarations BETWEEN a pair of sentinels.
 *
 * Trailing horizontal whitespace on the last line is stripped because the
 * closing sentinel's own indentation is not part of the contract: `theme-map`
 * sits inside `@theme inline { … }` in index.css and at column zero in the
 * contract file, and a test that failed on that would be a test about
 * formatting rather than about tokens.
 */
function region(source: string, name: string): string {
  const begin = `/* cockpit-ui:begin ${name} */`
  const end = `/* cockpit-ui:end ${name} */`
  const start = source.indexOf(begin)
  const stop = source.indexOf(end)
  if (start < 0 || stop < 0) throw new Error(`region ${name} is missing`)
  return source.slice(start + begin.length, stop).replace(/[ \t]+$/, '')
}

describe('CUI-TOKEN-1 — the sentinel regions are the contract, byte for byte', () => {
  test.each(REGIONS.map((name) => [name] as const))('%s matches contract/cockpit-ui.css', (name) => {
    expect(region(indexCss, name)).toBe(region(contract, name))
  })

  test('the regions appear in the order the contract declares them', () => {
    const positions = REGIONS.map((name) => indexCss.indexOf(`/* cockpit-ui:begin ${name} */`))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})

describe('CUI-TOKEN-2 — the declared names are exactly the contract names', () => {
  const NAMES = [
    'background',
    'foreground',
    'surface',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'destructive',
    'warning',
    'success',
    'border',
    'input',
    'ring',
    'chart-1',
    'chart-2',
    'chart-3',
    'chart-4',
    'chart-5',
    'radius',
    'sidebar',
    'sidebar-foreground',
    'sidebar-primary',
    'sidebar-primary-foreground',
    'sidebar-accent',
    'sidebar-accent-foreground',
    'sidebar-border',
    'sidebar-ring',
  ]

  test('tokens-light declares them all and nothing else', () => {
    const declared = [...region(indexCss, 'tokens-light').matchAll(/^\s{2}--([\w-]+):/gm)].map((match) => match[1])
    expect(declared).toEqual(NAMES)
  })
})

describe('CUI-TOKEN-3 — a console-only custom property carries the wk- prefix', () => {
  test('nothing outside the sentinels declares an unprefixed custom property', () => {
    // Everything the contract owns lives inside a region; the type stack of
    // CUI-TYPE-1 is the one documented exception, and the --color-*/--radius-*
    // mapping is itself a region.
    const outside = REGIONS.reduce((source, name) => source.replace(region(source, name), ''), indexCss)
    const declared = [...outside.matchAll(/^\s+--([\w-]+):/gm)].map((match) => match[1]!)
    const allowed = new Set(['font-sans', 'font-mono', 'font-heading'])
    const offenders = declared.filter((name) => !name.startsWith('wk-') && !allowed.has(name))
    expect(offenders).toEqual([])
  })
})

describe('CUI-TYPE-1 — the type stack is contract by VALUE, never by bytes', () => {
  test('--font-sans carries the contract stack and lives outside the sentinels', () => {
    const declaration = indexCss.match(/--font-sans:\s*([^;]+);/)?.[1] ?? ''
    // Compared with whitespace normalised: one checkout's formatter wraps this
    // declaration and another's does not, and a contract a formatter can break
    // is a contract nobody keeps.
    expect(declaration.replace(/\s+/g, ' ').trim()).toBe(
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    )
    for (const name of REGIONS) expect(region(indexCss, name)).not.toContain('--font-sans')
  })
})

describe('the digest is the identity', () => {
  test('COCKPIT-UI.md pins the sha256 of the bytes it governs', () => {
    const digest = createHash('sha256').update(contract).digest('hex')
    expect(rules).toContain(`Tokens-Digest: sha256:${digest}`)
  })

  test('the rules document names no other product', () => {
    // WikiKit is an autonomous product. It carries the contract, not a family
    // roster: the token bytes are what membership is measured by.
    expect(rules).not.toMatch(/contentkit|watchkit|workkit|subkit|slidekit/i)
  })
})

describe('lib/tokens.ts restates the same table', () => {
  test.each(['light', 'dark'] as const)('%s values match the CSS', (scheme) => {
    const source = region(contract, scheme === 'light' ? 'tokens-light' : 'tokens-dark')
    const fromCss = Object.fromEntries(
      [...source.matchAll(/^\s{2}--([\w-]+):\s*([^;]+);/gm)].map((match) => [match[1]!, match[2]!.trim()]),
    )
    // --radius is a length, not a colour, and lives on RADIUS instead.
    delete fromCss.radius
    expect(TOKENS[scheme]).toEqual(fromCss as never)
  })

  test('RADIUS is the value every --radius-* step is computed from', () => {
    expect(region(contract, 'tokens-light')).toContain(`--radius: ${RADIUS};`)
  })
})

describe('CUI-SEV-1 — a severity never wears a chart series name', () => {
  test('every state maps to a semantic token', () => {
    for (const token of Object.values(STATE_TOKEN)) {
      expect(token).not.toMatch(/^chart-\d$/)
    }
  })

  test('every domain status and severity resolves to a declared state', () => {
    const states = new Set(Object.keys(STATE_TOKEN))
    for (const [status, state] of Object.entries(STATUS_STATE)) {
      expect(states.has(state), `${status} maps to unknown state ${state}`).toBe(true)
    }
    for (const [severity, state] of Object.entries(SEVERITY_STATE)) {
      expect(states.has(state), `${severity} maps to unknown state ${state}`).toBe(true)
    }
  })

  test('the status table covers the vocabularies the database actually allows', () => {
    // Read from the migrations rather than restated here: a status added to a
    // CHECK constraint and not to the table renders as an unstyled blank.
    const ingest = readFileSync(join(root, 'src', 'db', 'migrations', '0008_wk_ingest_quota_backoff.sql'), 'utf8')
    const allowed = [...(ingest.match(/status in \(([^)]+)\)/) ?? [])[1]!.matchAll(/'([^']+)'/g)].map(
      (match) => match[1]!,
    )
    for (const status of allowed) {
      expect(Object.keys(STATUS_STATE), `ingest status ${status} has no state`).toContain(status)
    }
  })
})
