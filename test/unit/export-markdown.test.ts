// Markdown-tree bundle format (plan §9): frontmatter-lossless serialization,
// fixture-tree parsing, the serialize→parse→serialize byte round trip, and
// the snapshot loader's reader-visibility SQL (via a routing fake pool — same
// convention as the other domain tests).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import {
  loadSpaceSnapshot,
  markdownBundleFormat,
  slugFromPath,
  slugify,
  type BundleFile,
  type ImportedBundle,
  type SpaceSnapshot,
} from '../../src/export/markdown.ts'
import { sha256Hex } from '../../src/domain/sources.ts'

const FIXTURE_DIR = join(import.meta.dir, '../fixtures/markdown-tree')
const SOURCE_HASH = 'af7e01419480668317d0742889a2e65157d5df4eadce4f2c6c44a79f37bfc83d'

function loadTree(dir: string, prefix = ''): BundleFile[] {
  const files: BundleFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) files.push(...loadTree(join(dir, entry.name), `${prefix}${entry.name}/`))
    else files.push({ path: `${prefix}${entry.name}`, content: readFileSync(join(dir, entry.name), 'utf8') })
  }
  return files
}

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
        relations: [{ to: 'wikikit', kind: 'related' }],
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
    log: [],
  }
}

/**
 * Rebuild a SpaceSnapshot from a parsed bundle the way import → approve →
 * export would: sources re-hashed from content, claim/decision status carried
 * from frontmatter (all-verified/active fixtures make that the approved
 * state), empty log. This is the unit-level round-trip oracle.
 */
function snapshotFromBundle(bundle: ImportedBundle, space: SpaceSnapshot['space']): SpaceSnapshot {
  return {
    space,
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
}

describe('markdownBundleFormat.serialize', () => {
  const files = markdownBundleFormat.serialize(demoSnapshot())
  const byPath = new Map(files.map((file) => [file.path, file.content]))

  test('emits the plan §9 layout in deterministic order', () => {
    expect(files.map((file) => file.path)).toEqual([
      'index.md',
      'log.md',
      'concepts/okf.md',
      'concepts/wikikit.md',
      'decisions/no-cli.md',
      `sources/${SOURCE_HASH}.md`,
    ])
  })

  test('index.md is a TOC with [[slug]] wiki links', () => {
    const index = byPath.get('index.md')!
    expect(index).toContain('# Demo Space')
    expect(index).toContain('- [[okf]] — A markdown bundle format.')
    expect(index).toContain('- [[no-cli]] — No CLI')
    expect(index).toContain(`[OKF Announcement](sources/${SOURCE_HASH}.md)`)
  })

  test('concept claims live structured in frontmatter, body verbatim', () => {
    const concept = byPath.get('concepts/okf.md')!
    expect(concept).toStartWith('---\n')
    expect(concept).toContain('predicate: has_status')
    expect(concept).toContain(`source: ${SOURCE_HASH}`)
    expect(concept).toEndWith('# OKF\n\nSee [[wikikit]].\n')
  })

  test('source body is raw content verbatim — sha256(body) reproduces the hash', () => {
    const source = byPath.get(`sources/${SOURCE_HASH}.md`)!
    const body = source.slice(source.indexOf('---\n', 4) + 4)
    expect(sha256Hex(body)).toBe(SOURCE_HASH)
  })

  test('serialization is deterministic (same snapshot → same bytes)', () => {
    expect(markdownBundleFormat.serialize(demoSnapshot())).toEqual(files)
  })
})

describe('markdownBundleFormat round trip', () => {
  test('serialize → parse → serialize is byte-identical', () => {
    const snapshot = demoSnapshot()
    const first = markdownBundleFormat.serialize(snapshot)
    const bundle = markdownBundleFormat.parse(first)
    const second = markdownBundleFormat.serialize(snapshotFromBundle(bundle, snapshot.space))
    expect(second).toEqual(first)
  })

  test('a source whose raw content starts with --- still round-trips', () => {
    const snapshot = demoSnapshot()
    const tricky = '---\nnot: frontmatter of the source\n---\nbody\n'
    snapshot.sources = [{ content_hash: sha256Hex(tricky), kind: 'text', url: null, title: null, content: tricky }]
    snapshot.concepts[0]!.claims = []
    const bundle = markdownBundleFormat.parse(markdownBundleFormat.serialize(snapshot))
    expect(bundle.sources[0]!.content).toBe(tricky)
  })
})

describe('markdownBundleFormat.parse on the fixture tree', () => {
  const bundle = markdownBundleFormat.parse(loadTree(FIXTURE_DIR))

  test('derived files (index.md, log.md) are ignored', () => {
    expect(bundle.concepts.map((concept) => concept.slug)).toEqual(['open-knowledge-format', 'wikikit'])
  })

  test('claims and citations come back structured from frontmatter', () => {
    const okf = bundle.concepts.find((concept) => concept.slug === 'open-knowledge-format')!
    expect(okf.claims).toHaveLength(1)
    expect(okf.claims[0]!.predicate).toBe('has_status')
    expect(okf.claims[0]!.citations[0]!.source).toBe(SOURCE_HASH)
    expect(okf.relations).toEqual([{ to: 'wikikit', kind: 'related' }])
    expect(okf.markdown).toContain('[[wikikit]]')
  })

  test('decisions parse from frontmatter', () => {
    expect(bundle.decisions).toHaveLength(1)
    expect(bundle.decisions[0]!.slug).toBe('no-cli')
    expect(bundle.decisions[0]!.decision).toContain('no CLI commands')
    expect(bundle.decisions[0]!.alternatives).toHaveLength(1)
  })

  test('sources keep their file-stem ref and verbatim body', () => {
    expect(bundle.sources).toHaveLength(1)
    expect(bundle.sources[0]!.ref).toBe(SOURCE_HASH)
    expect(sha256Hex(bundle.sources[0]!.content)).toBe(SOURCE_HASH)
  })

  test('a file outside known directories is treated as a concept (permissive)', () => {
    const extra = markdownBundleFormat.parse([{ path: 'notes/Stray Note.md', content: '# Stray\n\ntext\n' }])
    expect(extra.concepts).toHaveLength(1)
    expect(extra.concepts[0]!.slug).toBe('notes-stray-note')
  })
})

describe('slug helpers', () => {
  test('slugify forces foreign identifiers into the wk_concepts grammar', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
    expect(slugify('__--__')).toBe('untitled')
    expect(slugify('Tables/Users')).toBe('tables-users')
  })

  test('slugFromPath keeps conformant stems and slugifies the rest', () => {
    expect(slugFromPath('concepts/okf.md', 'concepts/')).toBe('okf')
    expect(slugFromPath('concepts/deep/Dir File.md', 'concepts/')).toBe('deep-dir-file')
  })
})

// ---------------------------------------------------------------------------
// loadSpaceSnapshot — reader visibility BY CONSTRUCTION, asserted on the SQL.

interface Route {
  match: RegExp
  rows: Record<string, unknown>[]
}

function fakeDb(routes: Route[]) {
  const calls: { sql: string; values: unknown[] }[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => entry.match.test(sql))
    return { rows: route?.rows ?? [], rowCount: route?.rows.length ?? 0 }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

describe('loadSpaceSnapshot', () => {
  const routes: Route[] = [
    { match: /FROM "public"\."wk_spaces"/, rows: [{ slug: 'demo', name: 'Demo Space' }] },
    {
      match: /FROM wk_concepts c\s+JOIN wk_concept_revisions r ON r\.id = c\.current_revision_id/,
      rows: [{ id: 'c-1', slug: 'okf', title: 'OKF', summary: 'S', markdown: '# OKF\n' }],
    },
    {
      match: /FROM wk_claims cl/,
      rows: [
        {
          id: 'cl-1',
          concept_id: 'c-1',
          subject: 'okf',
          predicate: 'is',
          object: 'draft',
          status: 'verified',
          confidence: 0.8999999761581421, // float4 noise from pg — must round
        },
      ],
    },
    {
      match: /FROM wk_citations ct/,
      rows: [{ claim_id: 'cl-1', content_hash: 'h1', quote: 'q', locator: '' }],
    },
    { match: /FROM wk_relations rel/, rows: [] },
    { match: /FROM "public"\."wk_decisions"/, rows: [] },
    {
      match: /FROM "public"\."wk_sources"/,
      rows: [{ content_hash: 'h1', kind: 'markdown', url: null, title: 'T', raw_content: 'raw' }],
    },
    {
      match: /FROM wk_change_proposals/,
      rows: [
        {
          id: 'p-1',
          status: 'approved',
          title: 'Ingest note',
          reviewer: 'mike',
          review_channel: 'rest',
          reviewed_at: new Date('2026-07-01T10:00:00Z'),
          agent_meta: { model: 'claude-sonnet-5' },
        },
      ],
    },
    { match: /SELECT DISTINCT r\.proposal_id/, rows: [{ proposal_id: 'p-1', slug: 'okf' }] },
  ]

  test('assembles the snapshot with float4 confidence rounded and audit log', async () => {
    const { db } = fakeDb(routes)
    const snapshot = await loadSpaceSnapshot(db, 'space-1')
    expect(snapshot.space).toEqual({ slug: 'demo', name: 'Demo Space' })
    expect(snapshot.concepts[0]!.claims[0]!.confidence).toBe(0.9)
    expect(snapshot.concepts[0]!.claims[0]!.citations[0]!.source).toBe('h1')
    expect(snapshot.log).toEqual([
      {
        date: '2026-07-01',
        action: 'Approved',
        title: 'Ingest note',
        reviewer: 'mike',
        review_channel: 'rest',
        model: 'claude-sonnet-5',
        concepts: ['okf'],
      },
    ])
  })

  test('reader visibility is structural: current-revision join, visible claim statuses, space scoping', async () => {
    const { db, calls } = fakeDb(routes)
    await loadSpaceSnapshot(db, 'space-1')
    const conceptSql = calls.find((call) => /FROM wk_concepts c/.test(call.sql))!.sql
    expect(conceptSql).toContain('r.id = c.current_revision_id') // proposed revisions cannot leak
    const claimSql = calls.find((call) => /FROM wk_claims cl/.test(call.sql))!.sql
    expect(claimSql).toContain("IN ('verified', 'disputed', 'deprecated')")
    for (const call of calls.filter((entry) => entry.values.length)) {
      expect(call.values[0]).toBe('space-1') // every query space-scoped
    }
  })

  test('throws NotFoundError for an unknown space', async () => {
    const { db } = fakeDb([{ match: /FROM "public"\."wk_spaces"/, rows: [] }])
    expect(loadSpaceSnapshot(db, 'nope')).rejects.toThrow('space not found')
  })
})
