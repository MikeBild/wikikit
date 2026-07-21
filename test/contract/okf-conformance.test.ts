// OKF conformance contract (plan §14.2, §15.1) — the promise foreign systems
// rely on: every bundle WikiKit exports is conformant with the VENDORED spec
// at docs/okf-v0.1.md, and spec-shaped foreign bundles import without error.
//
// The rules asserted here are derived from the spec's §9 conformance section
// (frontmatter parseable, non-empty `type`, reserved-file structure) plus the
// §11 manifest rule. If this test needs changing, the spec was re-vendored —
// bump OKF_VERSION consciously (a visible contract change in the diff).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '../../src/domain/sources.ts'
import { type BundleFile, type SpaceSnapshot } from '../../src/export/markdown.ts'
import {
  checkOkfConformance,
  okfBundleFormat,
  OKF_GENERATOR,
  OKF_VERSION,
  readOkfManifest,
} from '../../src/export/okf.ts'
import { parseFrontmatter } from '../../src/markdown.ts'

const FIXTURES = join(import.meta.dir, '../fixtures/okf')

function loadTree(dir: string, prefix = ''): BundleFile[] {
  const files: BundleFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) files.push(...loadTree(join(dir, entry.name), `${prefix}${entry.name}/`))
    else files.push({ path: `${prefix}${entry.name}`, content: readFileSync(join(dir, entry.name), 'utf8') })
  }
  return files
}

const SOURCE_CONTENT = '# Announcement\n\nOKF is a draft spec.\n'

// A representative snapshot exercising every document type, extension key,
// and reserved file the exporter can emit.
function richSnapshot(): SpaceSnapshot {
  return {
    space: { slug: 'demo', name: 'Demo Space' },
    concepts: [
      {
        slug: 'okf',
        title: 'Open Knowledge Format',
        summary: 'A markdown bundle format.',
        markdown: '# OKF\n\nSee [WikiKit](/concepts/wikikit.md).\n',
        claims: [
          {
            subject: 'okf',
            predicate: 'has_status',
            object: 'draft',
            status: 'disputed',
            confidence: 0.75,
            citations: [{ source: sha256Hex(SOURCE_CONTENT), quote: 'OKF is a draft spec.', locator: 'l. 3' }],
          },
        ],
        relations: [{ to: 'wikikit', kind: 'contradicts' }],
      },
      { slug: 'wikikit', title: 'WikiKit', summary: '', markdown: '# WikiKit\n', claims: [], relations: [] },
    ],
    decisions: [
      {
        slug: 'no-cli',
        title: 'No CLI',
        status: 'superseded',
        context: 'Headless.',
        decision: 'REST and MCP only.',
        rationale: '',
        alternatives: [],
      },
    ],
    sources: [
      {
        content_hash: sha256Hex(SOURCE_CONTENT),
        kind: 'url',
        url: 'https://example.com/okf',
        title: 'Announcement',
        content: SOURCE_CONTENT,
      },
    ],
    log: [
      {
        date: '2026-07-15',
        action: 'Approved',
        title: 'Import bundle',
        reviewer: 'mike',
        review_channel: 'rest',
        model: 'claude-sonnet-5',
        concepts: ['okf'],
      },
      {
        date: '2026-07-01',
        action: 'Rejected',
        title: 'Stale note',
        reviewer: null,
        review_channel: null,
        model: null,
        concepts: [],
      },
    ],
  }
}

describe('exported bundles are OKF v0.1 conformant', () => {
  test('a rich export produces zero conformance issues', () => {
    expect(checkOkfConformance(okfBundleFormat.serialize(richSnapshot()))).toEqual([])
  })

  test('an empty space still exports a conformant bundle', () => {
    const empty: SpaceSnapshot = { space: { slug: 's', name: 'S' }, concepts: [], decisions: [], sources: [], log: [] }
    expect(checkOkfConformance(okfBundleFormat.serialize(empty))).toEqual([])
  })

  test('conformance rule 1+2: every non-reserved document has frontmatter with a non-empty type', () => {
    for (const file of okfBundleFormat.serialize(richSnapshot())) {
      const base = file.path.split('/').at(-1)!
      if (base === 'index.md' || base === 'log.md') continue
      const { data } = parseFrontmatter(file.content)
      expect(typeof data.type).toBe('string')
      expect(String(data.type).length).toBeGreaterThan(0)
    }
  })

  test('§11 manifest: root index.md declares okf_version 0.1 and the generator stamp', () => {
    const manifest = readOkfManifest(okfBundleFormat.serialize(richSnapshot()))
    expect(manifest).toEqual({ okf_version: OKF_VERSION, generator: OKF_GENERATOR })
    expect(OKF_VERSION).toBe('0.1')
    expect(OKF_GENERATOR).toMatch(/^wikikit\/\d+\.\d+\.\d+/)
  })

  test('§7 log: date headings are ISO 8601, newest first', () => {
    const log = okfBundleFormat.serialize(richSnapshot()).find((file) => file.path === 'log.md')!
    const dates = [...log.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!)
    expect(dates).toEqual(['2026-07-15', '2026-07-01'])
    for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('spec-derived foreign fixtures', () => {
  const foreign = loadTree(join(FIXTURES, 'foreign-bundle'))

  test('the Appendix-A-shaped bundle is conformant', () => {
    expect(checkOkfConformance(foreign)).toEqual([])
  })

  test('imports without error: unknown types become concepts, broken links tolerated (§5.3, §9)', () => {
    const bundle = okfBundleFormat.parse(foreign)
    // Concept ID is the bundle path (spec §2), slugified into wk_ grammar.
    expect(bundle.concepts.map((concept) => concept.slug).sort()).toEqual([
      'datasets-sales',
      'tables-customers',
      'tables-orders',
    ])
    expect(bundle.decisions).toEqual([])
    // description → summary survives the type-agnostic mapping.
    const sales = bundle.concepts.find((concept) => concept.slug === 'datasets-sales')!
    expect(sales.summary).toBe('All sales-related tables for the retail business.')
  })

  test('re-exporting imported foreign knowledge stays conformant (exchange loop)', () => {
    const bundle = okfBundleFormat.parse(foreign)
    const snapshot: SpaceSnapshot = {
      space: { slug: 'acme', name: 'Acme' },
      concepts: bundle.concepts,
      decisions: bundle.decisions,
      sources: [],
      log: [],
    }
    expect(checkOkfConformance(okfBundleFormat.serialize(snapshot))).toEqual([])
  })
})

describe('non-conformant input is detected (validator, not the permissive importer)', () => {
  const nonconformant = loadTree(join(FIXTURES, 'nonconformant'))

  test('missing frontmatter and missing type are each flagged with their rule', () => {
    const issues = checkOkfConformance(nonconformant)
    expect(issues.map((issue) => issue.rule).sort()).toEqual(['frontmatter-required', 'type-required'])
  })

  test('the PERMISSIVE importer still accepts them as generic concepts (spec §9)', () => {
    const bundle = okfBundleFormat.parse(nonconformant)
    expect(bundle.concepts.map((concept) => concept.slug).sort()).toEqual(['missing-type', 'no-frontmatter'])
  })

  test('frontmatter on a non-root index.md is flagged (§11: root only)', () => {
    const issues = checkOkfConformance([
      { path: 'tables/index.md', content: '---\nokf_version: "0.1"\n---\n# Tables\n' },
    ])
    expect(issues.some((issue) => issue.rule === 'index-frontmatter')).toBe(true)
  })

  test('non-ISO log dates are flagged (§7)', () => {
    const issues = checkOkfConformance([{ path: 'log.md', content: '# Log\n\n## July 15, 2026\n* **Update**: x\n' }])
    expect(issues.some((issue) => issue.rule === 'log-date')).toBe(true)
  })

  test('a malformed okf_version in the manifest is flagged (§11 form <major>.<minor>)', () => {
    const issues = checkOkfConformance([{ path: 'index.md', content: '---\nokf_version: v1\n---\n# Contents\n' }])
    expect(issues.some((issue) => issue.rule === 'okf-version')).toBe(true)
  })
})
