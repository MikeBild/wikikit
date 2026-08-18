import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '../../apps/cockpit/src/pages/pages.tsx'), 'utf8')
const spacesSource = readFileSync(join(import.meta.dir, '../../apps/cockpit/src/pages/spaces.tsx'), 'utf8')

describe('the Pages index fits its viewport', () => {
  test('uses fixed table layout and removes lower-priority columns responsively', () => {
    expect(source).toContain('tableClassName="w-full table-fixed"')
    expect(source.match(/priority: '(?:secondary|optional)'/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  test('never exposes UUID-shaped page labels or slugs', () => {
    expect(source).toContain('const title = row.title')
    expect(source).toContain('!isUuidLike(row.slug)')
  })

  test('uses visible row positions for selectors because readable slugs can still contain UUID suffixes', () => {
    expect(source).toContain('rowTestId={(_row, index) => `pages-row-${index + 1}`}')
    expect(source).not.toMatch(/data-testid=\{`[^`]*\$\{(?:row|item)\.slug\}/)
  })

  test('lets table cells own their selector instead of duplicating it on cell content', () => {
    expect(source).toContain('data-testid={`${testId}-trigger`}')
    expect(source).not.toContain('className="flex flex-col items-start gap-0.5" data-testid={testId}')
    expect(source).toContain('cell: (row) => <RelativeTime value={row.updated_at} />')
  })

  test('wraps generated-report provenance inside the narrow wiki overview cell', () => {
    expect(spacesSource).toContain('className="h-auto min-w-0 max-w-full whitespace-normal text-left leading-tight"')
  })
})
