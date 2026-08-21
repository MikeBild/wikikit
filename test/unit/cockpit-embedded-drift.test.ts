// The embedded cockpit against the bundle it was generated from.
//
// `bun build --compile` produces one file, and a readFileSync against
// assets/cockpit inside it resolves to a path that does not exist on the
// operator's machine — so the console travels base64-encoded in
// src/cockpit-embedded.ts, the same way the migrations and the documentation
// already do. A generated artifact that is not drift-checked is a generated
// artifact that is stale, and a stale one here means the binary serves last
// week's console while the checkout shows this week's.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { EMBEDDED_COCKPIT, EMBEDDED_COCKPIT_FILES } from '../../src/cockpit-embedded.ts'

const BUNDLE = join(process.cwd(), 'assets', 'cockpit')

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, found)
    else found.push(full)
  }
  return found
}

function builtFiles(): string[] | null {
  try {
    return walk(BUNDLE).sort()
  } catch {
    return null
  }
}

describe('the embedded cockpit matches assets/cockpit', () => {
  test('a checkout that has never built the console still compiles', () => {
    // The module must exist and typecheck either way — this test is reached
    // only because it does. Zero files is a legitimate state; a missing module
    // is not.
    expect(typeof EMBEDDED_COCKPIT).toBe('object')
    expect(EMBEDDED_COCKPIT_FILES).toBe(Object.keys(EMBEDDED_COCKPIT).length)
  })

  test('every built file is embedded, byte for byte', () => {
    const files = builtFiles()
    if (!files) {
      throw new Error('assets/cockpit is missing — run `bun run build:cockpit`')
    }
    const keys = files.map((file) => relative(BUNDLE, file).split(sep).join('/')).sort()
    expect(Object.keys(EMBEDDED_COCKPIT).sort()).toEqual(keys)

    for (const file of files) {
      const key = relative(BUNDLE, file).split(sep).join('/')
      expect(EMBEDDED_COCKPIT[key], `${key} is not embedded`).toBe(readFileSync(file).toString('base64'))
    }
  })

  test('the shell is there, because everything else is reached through it', () => {
    expect(EMBEDDED_COCKPIT['index.html']).toBeString()
    const shell = Buffer.from(EMBEDDED_COCKPIT['index.html']!, 'base64').toString('utf8')
    expect(shell).toContain('<div id="root"')
    // The pre-paint theme script (CUI-THEME-3) has to be in the served bytes:
    // the CSP hash is computed from them, so a shell without it would ship a
    // policy admitting a script that is not there.
    expect(shell).toContain('wk-cockpit-theme')
  })

  /*
    WHO THE SHIPPED BYTES BELONG TO.

    The convention makes the DOM anchors of all six consoles deliberately
    identical, so a check run pointed at the wrong port finds every selector it
    looks for and reports a sibling's surface under this product. It happened: at
    CodeKit, WorkKit answered on the check port and the run produced eight
    violations in 156s over a page that was never CodeKit.

    scripts/konvention-check.mjs holds the marker against the DELIVERED document;
    this test holds it against the BUILT one. Not the same statement, and for
    WikiKit the difference is sharp: this check is the only one in the family
    measuring against two targets, and the gate stage measures `vite preview`
    over assets/cockpit. An identity that does not survive the build would be
    missing exactly where it is needed.

    Held against the name from package.json rather than a literal: the marker
    exists to say WHICH product this is, and one that can drift away from its own
    name would be worse than none.
  */
  test('the built shell says which product it is — and says the right one', () => {
    const html = readFileSync(join(BUNDLE, 'index.html'), 'utf8')
    const marker = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(html)?.[1]
    expect(marker, 'the built index.html declares <meta name="cockpit-product">').toBeTruthy()

    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
    expect(marker!.toLowerCase()).toBe(pkg.name.toLowerCase())

    // The source is the single place of definition; the build must not have
    // rewritten, lost or doubled it. Vite touches `<link>` and `<script>`
    // references, `<meta content>` not — which is what makes this an assertion
    // rather than a hope.
    const source = readFileSync(join(process.cwd(), 'apps', 'cockpit', 'index.html'), 'utf8')
    const declared = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(source)?.[1]
    expect(marker).toBe(declared)
    expect([...html.matchAll(/name="cockpit-product"/g)].length, 'exactly one occurrence').toBe(1)

    // And in the bytes the binary actually serves — assets/cockpit lives in the
    // checkout, src/cockpit-embedded.ts travels with `bun build --compile`.
    const embedded = Buffer.from(EMBEDDED_COCKPIT['index.html']!, 'base64').toString('utf8')
    expect(/<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(embedded)?.[1]).toBe(marker)
  })

  test('no source map ships to production readers', () => {
    // A .map exposes the console's whole source to anyone who opens devtools
    // on a deployment. Not a secret, but not something to ship without having
    // decided to.
    expect(Object.keys(EMBEDDED_COCKPIT).filter((key) => key.endsWith('.map'))).toEqual([])
  })
})
