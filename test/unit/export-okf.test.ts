// OKF v0.1 adapter — mapping fidelity against the vendored spec
// (docs/okf-v0.1.md), the wikikit-extension losslessness, and the same byte
// round trip the md format guarantees. Conformance of exported bundles is the
// CONTRACT test (test/contract/okf-conformance.test.ts); this file covers the
// adapter mechanics.
import { describe, expect, test } from 'bun:test'
import { sha256Hex } from '../../src/domain/sources.ts'
import { type ImportedBundle, type SpaceSnapshot } from '../../src/export/markdown.ts'
import { okfBundleFormat, OKF_GENERATOR, OKF_VERSION, readOkfManifest } from '../../src/export/okf.ts'
import { parseFrontmatter } from '../../src/markdown.ts'
import { VERSION } from '../../src/version.ts'

const SOURCE_CONTENT = '# Announcement\n\nOKF is a draft spec.\n'
const SOURCE_HASH = sha256Hex(SOURCE_CONTENT)

function demoSnapshot(): SpaceSnapshot {
  return {
    space: { slug: 'demo', name: 'Demo Space' },
    concepts: [
      {
        slug: 'okf',
        title: 'Open Knowledge Format',
        summary: 'A markdown bundle format.',
        markdown: '# OKF\n\nBody.\n',
        claims: [
          {
            subject: 'okf',
            predicate: 'has_status',
            object: 'draft',
            status: 'verified',
            confidence: 0.9,
            citations: [{ source: SOURCE_HASH, quote: 'OKF is a draft spec.', locator: '' }],
          },
        ],
        relations: [{ to: 'wikikit', kind: 'related' }],
      },
      { slug: 'wikikit', title: 'WikiKit', summary: '', markdown: '# WikiKit\n', claims: [], relations: [] },
    ],
    decisions: [
      {
        slug: 'no-cli',
        title: 'No CLI',
        status: 'active',
        context: 'Headless product line.',
        decision: 'REST and MCP only.',
        rationale: 'One surface.',
        alternatives: [{ option: 'full CLI', reason_rejected: 'duplicate surface' }],
      },
    ],
    sources: [
      {
        content_hash: SOURCE_HASH,
        kind: 'url',
        url: 'https://example.com/okf',
        title: 'Announcement',
        content: SOURCE_CONTENT,
      },
    ],
    log: [
      {
        date: '2026-07-01',
        action: 'Approved',
        title: 'Import',
        reviewer: 'mike',
        review_channel: 'rest',
        model: null,
        concepts: ['okf'],
      },
    ],
  }
}

describe('okfBundleFormat.serialize', () => {
  const files = okfBundleFormat.serialize(demoSnapshot())
  const byPath = new Map(files.map((file) => [file.path, file.content]))

  test('every document carries the REQUIRED type field (spec §4.1)', () => {
    expect(parseFrontmatter(byPath.get('concepts/okf.md')!).data.type).toBe('Concept')
    expect(parseFrontmatter(byPath.get('decisions/no-cli.md')!).data.type).toBe('Decision')
    expect(parseFrontmatter(byPath.get(`sources/${SOURCE_HASH}.md`)!).data.type).toBe('Source')
  })

  test('the root index.md manifest carries okf_version + generator stamp (spec §11)', () => {
    const manifest = readOkfManifest(files)
    expect(manifest.okf_version).toBe(OKF_VERSION)
    expect(manifest.okf_version).toBe('0.1')
    expect(manifest.generator).toBe(OKF_GENERATOR)
    expect(manifest.generator).toBe(`wikikit/${VERSION}`)
  })

  test('summary maps to description; source url maps to resource (spec §4.1)', () => {
    expect(parseFrontmatter(byPath.get('concepts/okf.md')!).data.description).toBe('A markdown bundle format.')
    expect(parseFrontmatter(byPath.get(`sources/${SOURCE_HASH}.md`)!).data.resource).toBe('https://example.com/okf')
  })

  test('claims/relations travel in the single wikikit extension key', () => {
    const { data } = parseFrontmatter(byPath.get('concepts/okf.md')!)
    const wikikit = data.wikikit as { claims: unknown[]; relations: unknown[] }
    expect(wikikit.claims).toHaveLength(1)
    expect(wikikit.relations).toEqual([{ to: 'wikikit', kind: 'related' }])
    // No stray top-level extension keys — one namespaced key only.
    expect(Object.keys(data).sort()).toEqual(['description', 'title', 'type', 'wikikit'])
  })

  test('decision bodies are readable sections derived from the fields', () => {
    const decision = byPath.get('decisions/no-cli.md')!
    expect(decision).toContain('# Context')
    expect(decision).toContain('# Decision')
    expect(decision).toContain('# Rationale')
    expect(decision).toContain('- full CLI — rejected: duplicate surface')
  })

  test('log.md uses ISO date headings (spec §7)', () => {
    expect(byPath.get('log.md')!).toContain('## 2026-07-01')
    expect(byPath.get('log.md')!).toContain('* **Approved**: Import')
  })

  test('serialization is deterministic', () => {
    expect(okfBundleFormat.serialize(demoSnapshot())).toEqual(files)
  })
})

describe('okfBundleFormat.serialize — index bullet safety', () => {
  test('multi-line summaries and bracketed titles stay conformant index bullets', async () => {
    // zSynthesizeOutput places NO newline restriction on summaries — a raw
    // newline interpolated into a `* [...](...) - ...` bullet would split the
    // bullet and fail our own index-structure conformance rule.
    const snapshot = demoSnapshot()
    snapshot.concepts[0]!.summary = 'First line.\nSecond line with   extra whitespace.\n\nThird.'
    snapshot.concepts[1]!.title = 'WikiKit [headless] edition'
    const files = okfBundleFormat.serialize(snapshot)
    const { checkOkfConformance } = await import('../../src/export/okf.ts')
    expect(checkOkfConformance(files)).toEqual([])
    const index = files.find((file) => file.path === 'index.md')!.content
    expect(index).toContain('First line. Second line with extra whitespace. Third.')
    expect(index).toContain('\\[headless\\]')
  })
})

describe('okfBundleFormat round trip', () => {
  test('serialize → parse → serialize is byte-identical', () => {
    const snapshot = demoSnapshot()
    snapshot.log = [] // log narrates local review history — outside the stability contract
    const first = okfBundleFormat.serialize(snapshot)
    const bundle = okfBundleFormat.parse(first)
    const rebuilt: SpaceSnapshot = {
      space: snapshot.space,
      concepts: bundle.concepts,
      decisions: bundle.decisions,
      sources: bundle.sources.map((source) => ({
        content_hash: sha256Hex(source.content),
        kind: source.kind,
        url: source.url,
        title: source.title,
        content: source.content,
      })),
      log: [],
    }
    expect(okfBundleFormat.serialize(rebuilt)).toEqual(first)
  })
})

describe('okfBundleFormat.parse (permissive consumption, spec §9)', () => {
  test('unknown and missing types become generic concepts', () => {
    const bundle: ImportedBundle = okfBundleFormat.parse([
      { path: 'tables/orders.md', content: '---\ntype: BigQuery Table\ntitle: Orders\n---\n\nBody.\n' },
      { path: 'notes/untyped.md', content: 'No frontmatter at all.\n' },
    ])
    expect(bundle.concepts.map((concept) => concept.slug).sort()).toEqual(['notes-untyped', 'tables-orders'])
  })

  test('reserved filenames are never parsed as concepts (spec §3.1)', () => {
    const bundle = okfBundleFormat.parse([
      { path: 'index.md', content: '# Contents\n' },
      { path: 'tables/index.md', content: '# Tables\n' },
      { path: 'log.md', content: '# Update Log\n' },
    ])
    expect(bundle.concepts).toEqual([])
  })

  test('decision documents parse from the wikikit extension with defaults', () => {
    const bundle = okfBundleFormat.parse([
      { path: 'decisions/adopt.md', content: '---\ntype: Decision\ntitle: Adopt\n---\nWe adopt OKF.\n' },
    ])
    expect(bundle.decisions[0]!.decision).toBe('We adopt OKF.')
    expect(bundle.decisions[0]!.status).toBe('active')
  })

  test('source documents outside sources/ are recognized by type', () => {
    const bundle = okfBundleFormat.parse([
      { path: 'refs/blog.md', content: '---\ntype: Source\nresource: https://example.com\n---\nQuoted text.\n' },
    ])
    expect(bundle.sources).toHaveLength(1)
    expect(bundle.sources[0]!.ref).toBe('blog')
    expect(bundle.sources[0]!.url).toBe('https://example.com')
  })

  test('colliding slugified paths keep the first concept instead of clobbering', () => {
    const bundle = okfBundleFormat.parse([
      { path: 'concepts/My Note.md', content: '---\ntype: Note\n---\nfirst\n' },
      { path: 'concepts/my note.md', content: '---\ntype: Note\n---\nsecond\n' },
    ])
    expect(bundle.concepts).toHaveLength(1)
    expect(bundle.concepts[0]!.markdown).toBe('first\n')
  })
})
