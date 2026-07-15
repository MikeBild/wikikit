import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { VERSION } from '../../src/version.ts'

describe('VERSION', () => {
  test('matches package.json in dev (no build-time injection)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(VERSION).toBe(pkg.version)
  })

  test('looks like semver', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
