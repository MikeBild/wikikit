// Self-containment guard: the single binary must serve the REAL llms docs, not
// the "not bundled in this build" placeholder. A prod deploy shipped that
// placeholder because docs were read only from a docs/ dir that never ships
// beside the binary — EMBEDDED_DOCS (compile-time text imports) is the fix, and
// these assertions fail if the embed is dropped or the docs lose key content.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMBEDDED_DOCS } from '../../src/http/docs-embedded.ts'

const ROOT = join(import.meta.dir, '../..')

describe('embedded docs (binary self-containment)', () => {
  test('agent guide and both llms docs are embedded and non-trivial', () => {
    expect(EMBEDDED_DOCS['agent-guide.md']?.length ?? 0).toBeGreaterThan(1000)
    expect(EMBEDDED_DOCS['llms.txt']?.length ?? 0).toBeGreaterThan(200)
    expect(EMBEDDED_DOCS['llms-full.txt']?.length ?? 0).toBeGreaterThan(1000)
    // Never the fallback placeholder.
    expect(EMBEDDED_DOCS['llms-full.txt']).not.toContain('is not bundled in this build')
  })

  test('embedded content is byte-identical to docs/ (cannot drift)', () => {
    for (const name of ['agent-guide.md', 'llms.txt', 'llms-full.txt'] as const) {
      const onDisk = readFileSync(join(ROOT, 'docs', name), 'utf8')
      expect(EMBEDDED_DOCS[name]).toBe(onDisk)
    }
  })

  test('embedded docs carry the current surface (guards a stale/empty embed)', () => {
    expect(EMBEDDED_DOCS['agent-guide.md']).toContain('wikikit_context')
    expect(EMBEDDED_DOCS['agent-guide.md']).toContain('tools-only clients')
    expect(EMBEDDED_DOCS['llms.txt']).toContain('wikikit_decisions')
    expect(EMBEDDED_DOCS['llms-full.txt']).toContain('wikikit_decisions')
    expect(EMBEDDED_DOCS['llms-full.txt']).toContain('/v1/spaces/{space}/decisions')
  })
})
