import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '../../apps/cockpit/src/pages/pages.tsx'), 'utf8')

describe('the Pages index fits its viewport', () => {
  test('uses fixed table layout and removes secondary columns below md', () => {
    expect(source).toContain('tableClassName="w-full table-fixed"')
    expect(source.match(/max-md:hidden/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  test('never exposes UUID-shaped page labels or slugs', () => {
    expect(source).toContain('semanticLabel([row.title]')
    expect(source).toContain('!isUuidLike(row.slug)')
  })
})
