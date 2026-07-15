// import.ts orchestration — decodeBundle, the import dedup hash, the pure
// bundle → CreateProposalArgs mapping, and the two DB entry points against a
// routing fake pool: exportSpace streams a deterministic zip; importBundle
// upserts sources directly and stages exactly ONE ChangeProposal (the review
// gate) with citations remapped to fresh source ids.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import {
  bundleToProposalArgs,
  computeImportHash,
  decodeBundle,
  exportSpace,
  importBundle,
  IMPORT_MODEL,
  IMPORT_PROMPT_VERSION,
} from '../../src/export/import.ts'
import { type BundleFile, type ImportedBundle } from '../../src/export/markdown.ts'
import { createZip, readZip } from '../../src/export/zip.ts'

const FIXTURE_DIR = join(import.meta.dir, '../fixtures/markdown-tree')
const SOURCE_HASH = 'af7e01419480668317d0742889a2e65157d5df4eadce4f2c6c44a79f37bfc83d'
const SOURCE_UUID = '00000000-0000-4000-8000-000000000001'
const PROPOSAL_UUID = '00000000-0000-4000-8000-00000000000a'
const CLAIM_UUID = '00000000-0000-4000-8000-00000000000c'

const encoder = new TextEncoder()

function loadTree(dir: string, prefix = ''): BundleFile[] {
  const files: BundleFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) files.push(...loadTree(join(dir, entry.name), `${prefix}${entry.name}/`))
    else files.push({ path: `${prefix}${entry.name}`, content: readFileSync(join(dir, entry.name), 'utf8') })
  }
  return files
}

const zipOf = (files: BundleFile[]): Uint8Array =>
  createZip(files.map((file) => ({ path: file.path, data: encoder.encode(file.content) })))

function demoBundle(): ImportedBundle {
  return {
    concepts: [
      {
        slug: 'okf',
        title: 'OKF',
        summary: 'S',
        markdown: '# OKF\n',
        claims: [
          {
            subject: 'okf',
            predicate: 'is',
            object: 'draft',
            status: 'verified',
            confidence: 0.9,
            citations: [
              { source: 'ref-1', quote: 'quoted', locator: '' },
              { source: 'missing-ref', quote: 'dangling', locator: '' },
            ],
          },
        ],
        relations: [{ to: 'wikikit', kind: 'related' }],
      },
    ],
    decisions: [],
    sources: [{ ref: 'ref-1', kind: 'markdown', url: null, title: null, content: 'source body\n' }],
  }
}

describe('decodeBundle', () => {
  test('unzips into UTF-8 bundle files', () => {
    const files = decodeBundle(zipOf([{ path: 'concepts/a.md', content: '# A — ümlaut\n' }]))
    expect(files).toEqual([{ path: 'concepts/a.md', content: '# A — ümlaut\n' }])
  })

  test('rejects entries that are not valid UTF-8', () => {
    const zip = createZip([{ path: 'a.md', data: new Uint8Array([0xff, 0xfe, 0x00, 0xd8]) }])
    expect(() => decodeBundle(zip)).toThrow(/not valid UTF-8/)
  })
})

describe('computeImportHash', () => {
  test('is a sha256 hex digest, stable across file/entry order', () => {
    const a = demoBundle()
    const b = demoBundle()
    b.concepts.unshift({ slug: 'zzz', title: 'Z', summary: '', markdown: 'z', claims: [], relations: [] })
    a.concepts.push({ slug: 'zzz', title: 'Z', summary: '', markdown: 'z', claims: [], relations: [] })
    expect(computeImportHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(computeImportHash(a)).toBe(computeImportHash(b))
  })

  test('changes when knowledge changes', () => {
    const a = demoBundle()
    const b = demoBundle()
    b.concepts[0]!.markdown = '# OKF v2\n'
    expect(computeImportHash(a)).not.toBe(computeImportHash(b))
  })
})

describe('bundleToProposalArgs', () => {
  const opts = { format: 'md' as const, inputHash: 'f'.repeat(64), sourceIds: [SOURCE_UUID] }

  test('maps citations through the ref map and drops unresolvable refs (claim survives)', () => {
    const args = bundleToProposalArgs(demoBundle(), new Map([['ref-1', SOURCE_UUID]]), opts)
    const claim = args.concepts![0]!.claims![0]!
    expect(claim.citations).toEqual([{ source_id: SOURCE_UUID, quote: 'quoted', locator: '' }])
    expect(args.concepts![0]!.relations).toEqual([{ to_slug: 'wikikit', kind: 'related' }])
  })

  test('stamps import provenance into agent_meta (§1.14 shape)', () => {
    const args = bundleToProposalArgs(demoBundle(), new Map(), opts)
    expect(args.agent_meta).toEqual({
      model: IMPORT_MODEL,
      prompt_version: IMPORT_PROMPT_VERSION,
      input_hash: opts.inputHash,
      source_ids: [SOURCE_UUID],
      format: 'md',
    })
    expect(args.input_hash).toBe(opts.inputHash)
  })

  test('dedupes duplicate slugs first-wins (one revision per concept per proposal)', () => {
    const bundle = demoBundle()
    bundle.concepts.push({ slug: 'okf', title: 'Dup', summary: '', markdown: 'dup', claims: [], relations: [] })
    const args = bundleToProposalArgs(bundle, new Map(), opts)
    expect(args.concepts).toHaveLength(1)
    expect(args.concepts![0]!.title).toBe('OKF')
  })

  test('body-less concepts get a title-heading body (revisions are never empty)', () => {
    const bundle = demoBundle()
    bundle.concepts[0]!.markdown = ''
    const args = bundleToProposalArgs(bundle, new Map(), opts)
    expect(args.concepts![0]!.markdown).toBe('# OKF\n')
  })
})

// ---------------------------------------------------------------------------
// Routing fake pool (same convention as the domain tests)

interface Route {
  match: RegExp
  rows?: Record<string, unknown>[] | ((values: unknown[]) => Record<string, unknown>[])
}

function fakeDb(routes: Route[]) {
  const calls: { sql: string; values: unknown[] }[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => entry.match.test(sql))
    const rows = typeof route?.rows === 'function' ? route.rows(values) : (route?.rows ?? [])
    return { rows, rowCount: rows.length }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const exportRoutes: Route[] = [
  { match: /FROM "public"\."wk_spaces"/, rows: [{ slug: 'demo', name: 'Demo Space' }] },
  {
    match: /FROM wk_concepts c\s+JOIN wk_concept_revisions/,
    rows: [{ id: 'c-1', slug: 'okf', title: 'OKF', summary: 'S', markdown: '# OKF\n' }],
  },
  { match: /FROM "public"\."wk_sources"/, rows: [] },
]

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

describe('exportSpace', () => {
  test('streams a zip whose entries follow the bundle layout', async () => {
    const { db } = fakeDb(exportRoutes)
    const bytes = await collect(await exportSpace(db, 'space-1', { format: 'md' }))
    const entries = readZip(bytes)
    expect(entries.map((entry) => entry.path)).toEqual(['index.md', 'log.md', 'concepts/okf.md'])
  })

  test('identical knowledge exports to identical bytes (both formats)', async () => {
    for (const format of ['md', 'okf'] as const) {
      const first = await collect(await exportSpace(fakeDb(exportRoutes).db, 'space-1', { format }))
      const second = await collect(await exportSpace(fakeDb(exportRoutes).db, 'space-1', { format }))
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    }
  })

  test('rejects unknown formats at the boundary', () => {
    const { db } = fakeDb(exportRoutes)
    expect(exportSpace(db, 'space-1', { format: 'tar' as never })).rejects.toThrow()
  })
})

describe('importBundle', () => {
  function importRoutes(): Route[] {
    return [
      // createSource: dedup lookup misses, insert returns a fresh uuid row.
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [] },
      {
        match: /INSERT INTO "public"\."wk_sources"/,
        rows: (values) => [
          {
            id: SOURCE_UUID,
            kind: 'markdown',
            url: null,
            title: null,
            content_hash: values[1],
            raw_content: 'x',
            markdown: 'x',
            metadata: {},
            created_at: new Date('2026-07-01T00:00:00Z'),
          },
        ],
      },
      // createProposal transaction internals.
      { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [{ slug: 'demo' }] },
      { match: /SELECT \* FROM "public"\."wk_change_proposals"/, rows: [] },
      // Source-ownership check resolves every referenced id in-space.
      { match: /id = ANY\(\$2::uuid\[\]\)/, rows: (values) => (values[1] as string[]).map((id) => ({ id })) },
      { match: /INSERT INTO "public"\."wk_change_proposals"/, rows: [{ id: PROPOSAL_UUID }] },
      { match: /SELECT id, current_revision_id FROM wk_concepts/, rows: [] },
      {
        match: /INSERT INTO wk_concepts/,
        rows: (values) => [
          {
            id: `00000000-0000-4000-8000-0000000000${String(values[1]).length.toString(16).padStart(2, '0')}`,
            current_revision_id: null,
          },
        ],
      },
      { match: /COALESCE\(MAX\(rev\)/, rows: [{ next: 1 }] },
      { match: /INSERT INTO "public"\."wk_claims"/, rows: [{ id: CLAIM_UUID }] },
    ]
  }

  test('upserts sources, stages ONE proposal, remaps citations, emits the outbox event', async () => {
    const { db, calls } = fakeDb(importRoutes())
    const result = await importBundle(db, 'space-1', { data: zipOf(loadTree(FIXTURE_DIR)), format: 'md' })

    expect(result).toEqual({ proposal_id: PROPOSAL_UUID, sources_created: 1 })

    // The fixture source was archived with its verbatim body (hash preserved).
    const sourceInsert = calls.find((call) => /INSERT INTO "public"\."wk_sources"/.test(call.sql))!
    expect(sourceInsert.values[1]).toBe(SOURCE_HASH)

    // Exactly one proposal staged — the review gate.
    expect(calls.filter((call) => /INSERT INTO "public"\."wk_change_proposals"/.test(call.sql))).toHaveLength(1)

    // Citation ref (content hash) remapped to the fresh source uuid.
    const citationInsert = calls.find((call) => /INSERT INTO "public"\."wk_citations"/.test(call.sql))!
    expect(citationInsert.values).toContain(SOURCE_UUID)

    // Import provenance stamped on the proposal row.
    const proposalInsert = calls.find((call) => /INSERT INTO "public"\."wk_change_proposals"/.test(call.sql))!
    const meta = JSON.parse(
      String(proposalInsert.values.find((v) => typeof v === 'string' && v.includes('prompt_version'))),
    )
    expect(meta.model).toBe(IMPORT_MODEL)
    expect(meta.prompt_version).toBe(IMPORT_PROMPT_VERSION)

    // proposal.created lands in the outbox inside the same transaction.
    const outbox = calls.find((call) => /wk_outbox_events/.test(call.sql))!
    expect(outbox.values[1]).toBe('wikikit.proposal.created')

    // Everything staged as 'proposed' — nothing bypasses review.
    const revisionInsert = calls.find((call) => /INSERT INTO "public"\."wk_concept_revisions"/.test(call.sql))!
    expect(revisionInsert.values).toContain('proposed')
  })

  test('refuses a bundle without concepts or decisions BEFORE any write', async () => {
    const { db, calls } = fakeDb(importRoutes())
    const sourcesOnly = zipOf([{ path: `sources/${SOURCE_HASH}.md`, content: '---\nkind: markdown\n---\nbody\n' }])
    expect(importBundle(db, 'space-1', { data: sourcesOnly, format: 'md' })).rejects.toThrow(/no concepts or decisions/)
    expect(calls.filter((call) => call.sql.startsWith('INSERT'))).toHaveLength(0)
  })

  test('imports a foreign OKF bundle through the same gate', async () => {
    const { db, calls } = fakeDb(importRoutes())
    const foreign = zipOf(loadTree(join(import.meta.dir, '../fixtures/okf/foreign-bundle')))
    const result = await importBundle(db, 'space-1', { data: foreign, format: 'okf' })
    expect(result.proposal_id).toBe(PROPOSAL_UUID)
    // Three foreign concepts staged as revisions, all proposed.
    expect(calls.filter((call) => /INSERT INTO "public"\."wk_concept_revisions"/.test(call.sql))).toHaveLength(3)
  })
})
