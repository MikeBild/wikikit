// Vault-mirror bundle format (`obsidian`): serialize-only projection of the
// approved knowledge. What this suite pins down is the CONTRACT the sync
// client relies on — every file carries the provenance marker as its first
// frontmatter key, nothing derived from sources or review history ships,
// bytes are deterministic, and parse refuses (mirrors never round back in).
import { describe, expect, test } from 'bun:test'
import { obsidianBundleFormat } from '../../src/export/obsidian.ts'
import { BUNDLE_FORMATS } from '../../src/export/import.ts'
import type { SpaceSnapshot } from '../../src/export/markdown.ts'
import { hasWikiKitProvenance, parseFrontmatter } from '../../src/markdown.ts'

const SOURCE_HASH = 'af7e01419480668317d0742889a2e65157d5df4eadce4f2c6c44a79f37bfc83d'

function demoSnapshot(): SpaceSnapshot {
  return {
    space: { slug: 'demo', name: 'Demo Space' },
    concepts: [
      {
        slug: 'okf',
        title: 'Open Knowledge Format',
        summary: 'A markdown bundle format.',
        markdown: '# OKF\n\nSee [[wikikit]].\n',
        claims: [
          {
            subject: 'okf',
            predicate: 'has_status',
            object: 'draft',
            status: 'verified',
            confidence: 0.9,
            citations: [{ source: SOURCE_HASH, quote: 'OKF is a draft spec', locator: 'heading: Intro' }],
          },
        ],
        relations: [
          { to: 'wikikit', kind: 'related' },
          { to: 'wikikit', kind: 'part_of' }, // duplicate target — one link
        ],
      },
      {
        slug: 'wikikit',
        title: 'WikiKit',
        summary: '',
        markdown: '# WikiKit\n',
        claims: [],
        relations: [],
      },
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
        kind: 'markdown',
        url: null,
        title: 'OKF Announcement',
        content: '# OKF Announcement\n\nOKF is a draft spec for knowledge bundles.\n',
      },
    ],
    log: [
      {
        date: '2026-07-01',
        action: 'Approved',
        title: 'Ingest note',
        reviewer: 'mike',
        review_channel: 'rest',
        model: null,
        concepts: ['okf'],
      },
    ],
  }
}

describe('obsidianBundleFormat.serialize', () => {
  const files = obsidianBundleFormat.serialize(demoSnapshot())
  const byPath = new Map(files.map((file) => [file.path, file.content]))

  test('emits concepts + decisions + index only, in deterministic order', () => {
    expect(files.map((file) => file.path)).toEqual([
      'index.md',
      'concepts/okf.md',
      'concepts/wikikit.md',
      'decisions/no-cli.md',
    ])
  })

  test('no sources/ entries and no log.md — despite the snapshot carrying both', () => {
    expect(files.some((file) => file.path.startsWith('sources/'))).toBe(false)
    expect(files.some((file) => file.path.split('/').at(-1) === 'log.md')).toBe(false)
  })

  test('the wikikit marker is the FIRST frontmatter key of every file', () => {
    for (const file of files) {
      expect(file.content).toStartWith('---\nwikikit:\n')
      expect(hasWikiKitProvenance(file.content)).toBe(true) // what the ingest guard probes
    }
  })

  test('marker payload is {space, kind, slug}', () => {
    const { data } = parseFrontmatter(byPath.get('concepts/okf.md')!)
    expect(data.wikikit).toEqual({ space: 'demo', kind: 'concept', slug: 'okf' })
    const decision = parseFrontmatter(byPath.get('decisions/no-cli.md')!)
    expect(decision.data.wikikit).toEqual({ space: 'demo', kind: 'decision', slug: 'no-cli' })
  })

  test('index.md is a [[slug]] TOC of concepts and decisions, without sources', () => {
    const index = byPath.get('index.md')!
    expect(index).toContain('# Demo Space')
    expect(index).toContain('- [[okf]] — A markdown bundle format.')
    expect(index).toContain('- [[no-cli]] — No CLI')
    expect(index).not.toContain('Sources')
    expect(index).not.toContain(SOURCE_HASH)
  })

  test('concept body is verbatim plus a deduplicated ## Related section; no claims frontmatter', () => {
    const concept = byPath.get('concepts/okf.md')!
    const { data, content } = parseFrontmatter(concept)
    expect(data.title).toBe('Open Knowledge Format')
    expect(data.summary).toBe('A markdown bundle format.')
    expect(data.claims).toBeUndefined() // structured claims are round-trip freight, not vault reading
    expect(content).toStartWith('# OKF\n\nSee [[wikikit]].')
    expect(content).toEndWith('## Related\n\n- [[wikikit]]\n')
    expect(content.match(/\[\[wikikit\]\]/g)!.length).toBe(2) // body link + ONE related link
  })

  test('a concept without relations gets no Related section, without summary no summary key', () => {
    const concept = byPath.get('concepts/wikikit.md')!
    const { data, content } = parseFrontmatter(concept)
    expect(content).toBe('# WikiKit\n')
    expect(data.summary).toBeUndefined()
  })

  test('decision body is readable sections derived from the fields', () => {
    const decision = byPath.get('decisions/no-cli.md')!
    const { data, content } = parseFrontmatter(decision)
    expect(data.status).toBe('active')
    expect(content).toContain('## Context\n\nHeadless product line.')
    expect(content).toContain('## Decision\n\nREST and MCP only.')
    expect(content).toContain('## Rationale\n\nOne surface.')
    expect(content).toContain('- full CLI — rejected: duplicate surface')
  })

  test('serialization is deterministic (same snapshot → same bytes)', () => {
    expect(obsidianBundleFormat.serialize(demoSnapshot())).toEqual(files)
  })
})

describe('obsidianBundleFormat.parse', () => {
  test('throws — the format is export-only', () => {
    expect(() => obsidianBundleFormat.parse([])).toThrow('export-only')
  })

  test('is registered in BUNDLE_FORMATS under its format name', () => {
    expect(BUNDLE_FORMATS.obsidian).toBe(obsidianBundleFormat)
    expect(obsidianBundleFormat.format).toBe('obsidian')
  })
})
