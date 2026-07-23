// Shared harness for the German retrieval-quality evaluation: seeds the
// corpus fixture through the REAL visibility path (staged rows +
// wk_apply_proposal — identical semantics to production approval) and
// computes recall@k / MRR against the golden queries.
//
// Used by test/integration/retrieval-eval.test.ts (CI gate, thresholds live
// in the golden fixture) and scripts/retrieval-eval.ts (verbose tuning table,
// not CI-gating).
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from '../../src/db/postgres.ts'
import { search } from '../../src/query/search.ts'

const fixturesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'fixtures', 'retrieval')

export interface CorpusConcept {
  slug: string
  title: string
  summary: string
  markdown: string
  claims: { subject: string; predicate: string; object: string }[]
}

export interface Corpus {
  space: { slug: string; name: string; settings: Record<string, unknown> }
  concepts: CorpusConcept[]
}

export interface GoldenQuery {
  q: string
  relevant: string[]
  phenomenon: string
}

export interface Golden {
  thresholds: { min_recall_at_5: number; min_recall_at_10: number; min_mrr: number }
  queries: GoldenQuery[]
}

export async function loadCorpus(): Promise<Corpus> {
  return JSON.parse(await readFile(join(fixturesDir, 'corpus.de.json'), 'utf8')) as Corpus
}

export async function loadGolden(): Promise<Golden> {
  return JSON.parse(await readFile(join(fixturesDir, 'golden.de.json'), 'utf8')) as Golden
}

/**
 * Seeds the corpus: one proposal per concept (the ingest pipeline's
 * granularity), staged rows, then wk_apply_proposal — so search sees exactly
 * what an approved knowledge base would expose. Returns the space id.
 */
export async function seedCorpus(db: Db, corpus: Corpus): Promise<string> {
  const [space] = await db.insert<{ id: string }>('wk_spaces', {
    slug: corpus.space.slug,
    name: corpus.space.name,
    settings: JSON.stringify(corpus.space.settings),
  })
  const spaceId = space!.id

  for (const concept of corpus.concepts) {
    const proposalId = await db.tx(async (tx) => {
      const [proposal] = await tx.insert<{ id: string }>('wk_change_proposals', {
        space_id: spaceId,
        title: `Add ${concept.slug}`,
        input_hash: randomUUID(),
      })
      const [conceptRow] = await tx.insert<{ id: string }>('wk_concepts', {
        space_id: spaceId,
        slug: concept.slug,
        title: concept.title,
      })
      await tx.insert(
        'wk_concept_revisions',
        {
          space_id: spaceId,
          concept_id: conceptRow!.id,
          rev: 1,
          status: 'proposed',
          title: concept.title,
          summary: concept.summary,
          markdown: concept.markdown,
          base_revision_id: null,
          proposal_id: proposal!.id,
        },
        { returning: false },
      )
      for (const claim of concept.claims) {
        await tx.insert(
          'wk_claims',
          {
            space_id: spaceId,
            concept_id: conceptRow!.id,
            subject: claim.subject,
            predicate: claim.predicate,
            object: claim.object,
            status: 'proposed',
            proposal_id: proposal!.id,
          },
          { returning: false },
        )
      }
      return proposal!.id
    })
    await db.call('wk_apply_proposal', [proposalId, 'retrieval-eval'])
  }

  return spaceId
}

export interface QueryResult {
  q: string
  phenomenon: string
  relevant: string[]
  /** Unique concept slugs in rank order (claim hits count toward their concept). */
  slugs: string[]
  firstRelevantRank: number | null
  recallAt5: number
  recallAt10: number
}

export interface EvalResult {
  queries: QueryResult[]
  recallAt5: number
  recallAt10: number
  mrr: number
}

function recallAtK(slugs: string[], relevant: string[], k: number): number {
  const top = new Set(slugs.slice(0, k))
  return relevant.filter((slug) => top.has(slug)).length / relevant.length
}

/** Runs every golden query through the production search path and aggregates metrics. */
export async function runEval(db: Db, spaceId: string, golden: Golden): Promise<EvalResult> {
  const queries: QueryResult[] = []
  for (const entry of golden.queries) {
    const hits = await search(db, spaceId, { q: entry.q, limit: 50 })
    const slugs: string[] = []
    for (const hit of hits) {
      if (hit.slug && !slugs.includes(hit.slug)) slugs.push(hit.slug)
    }
    const firstIndex = slugs.findIndex((slug) => entry.relevant.includes(slug))
    queries.push({
      q: entry.q,
      phenomenon: entry.phenomenon,
      relevant: entry.relevant,
      slugs,
      firstRelevantRank: firstIndex === -1 ? null : firstIndex + 1,
      recallAt5: recallAtK(slugs, entry.relevant, 5),
      recallAt10: recallAtK(slugs, entry.relevant, 10),
    })
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1)
  return {
    queries,
    recallAt5: mean(queries.map((query) => query.recallAt5)),
    recallAt10: mean(queries.map((query) => query.recallAt10)),
    mrr: mean(queries.map((query) => (query.firstRelevantRank ? 1 / query.firstRelevantRank : 0))),
  }
}
