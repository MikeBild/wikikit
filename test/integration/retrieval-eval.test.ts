// German retrieval-quality gate against a real Docker Postgres: seeds the
// corpus fixture through staged rows + wk_apply_proposal (the real visibility
// path) and asserts the recall/MRR thresholds pinned in the golden fixture.
// Thresholds are part of the reviewed contract — tightening them is a fixture
// edit, reviewed like code. Gated behind RUN_INTEGRATION=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { loadCorpus, loadGolden, runEval, seedCorpus, type Golden } from '../helpers/retrieval-eval.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db
let spaceId = ''
let golden: Golden

describe('retrieval eval (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_retrieval_eval')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    golden = await loadGolden()
    spaceId = await seedCorpus(db, await loadCorpus())
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('meets the pinned German retrieval thresholds', async () => {
    const result = await runEval(db, spaceId, golden)

    const misses = result.queries.filter((query) => query.firstRelevantRank === null)
    // Failure output names the losing queries — the tuning table lives in
    // scripts/retrieval-eval.ts; this stays terse and actionable.
    const summary = [
      `recall@5=${result.recallAt5.toFixed(3)} (min ${golden.thresholds.min_recall_at_5})`,
      `recall@10=${result.recallAt10.toFixed(3)} (min ${golden.thresholds.min_recall_at_10})`,
      `mrr=${result.mrr.toFixed(3)} (min ${golden.thresholds.min_mrr})`,
      misses.length ? `misses: ${misses.map((query) => JSON.stringify(query.q)).join(', ')}` : 'no total misses',
    ].join(' | ')
    console.log(`retrieval-eval: ${summary}`)

    expect(result.recallAt5).toBeGreaterThanOrEqual(golden.thresholds.min_recall_at_5)
    expect(result.recallAt10).toBeGreaterThanOrEqual(golden.thresholds.min_recall_at_10)
    expect(result.mrr).toBeGreaterThanOrEqual(golden.thresholds.min_mrr)
  })
})
