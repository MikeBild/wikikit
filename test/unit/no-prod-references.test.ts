// The public repo must stay free of concrete production references: the
// operator's private deployment domain (anywhere) and sibling product names
// (in the documentation surface — code internals and CHANGELOG history keep
// their historical markers). Needles are assembled from fragments so this
// guard never matches itself.
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const SELF = 'test/unit/no-prod-references.test.ts'

function gitGrep(args: string[]): string {
  try {
    return execFileSync('git', ['grep', ...args], { cwd: ROOT, encoding: 'utf8' })
  } catch (error) {
    const err = error as { status?: number; stdout?: string }
    // git grep exits 1 with empty stdout when there are no matches — success.
    if (err.status === 1 && !err.stdout) return ''
    throw error
  }
}

describe('no production references', () => {
  test('the private deployment domain appears in no tracked file', () => {
    const needle = ['mikebild', 'dev'].join('\\.')
    const hits = gitGrep(['-nIE', needle, '--', '.', `:!${SELF}`])
    expect(hits, `production domain reference(s) found:\n${hits}`).toBe('')
  })

  test('sibling product names appear nowhere in the docs surface', () => {
    const products = ['Content', 'Sub', 'Slide'].map((p) => `${p}Kit`).join('|')
    const hits = gitGrep(['-nIiE', products, '--', 'README.md', 'docs', 'examples'])
    expect(hits, `sibling product reference(s) found in docs:\n${hits}`).toBe('')
  })
})
