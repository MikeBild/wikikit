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

  test('no source map ships to production readers', () => {
    // A .map exposes the console's whole source to anyone who opens devtools
    // on a deployment. Not a secret, but not something to ship without having
    // decided to.
    expect(Object.keys(EMBEDDED_COCKPIT).filter((key) => key.endsWith('.map'))).toEqual([])
  })
})
