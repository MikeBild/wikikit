#!/usr/bin/env bun
// Verbose retrieval-eval runner for tuning (NOT a CI gate — the gate lives in
// test/integration/retrieval-eval.test.ts with thresholds pinned in the
// golden fixture). Provisions a throwaway database in the local Docker
// Postgres, migrates, seeds the German corpus through the real approval path
// and prints a per-query table plus aggregates.
//
// Usage: bun scripts/retrieval-eval.ts
import type { Config } from '../src/config.ts'
import { createPostgres } from '../src/db/postgres.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { provisionIntegrationDatabase } from './start-local.ts'
import { loadCorpus, loadGolden, runEval, seedCorpus } from '../test/helpers/retrieval-eval.ts'

const url = await provisionIntegrationDatabase('wikikit_eval_retrieval')
await runMigrations({ databaseUrl: url })
const database = createPostgres({ databaseUrl: url } as Config)

try {
  const spaceId = await seedCorpus(database.db, await loadCorpus())
  const golden = await loadGolden()
  const result = await runEval(database.db, spaceId, golden)

  const width = Math.max(...result.queries.map((query) => query.q.length))
  console.log(`${'query'.padEnd(width)}  rank  r@5   r@10  phenomenon`)
  for (const query of result.queries) {
    const rank = query.firstRelevantRank === null ? 'MISS' : `#${query.firstRelevantRank}`
    console.log(
      `${query.q.padEnd(width)}  ${rank.padEnd(4)}  ${query.recallAt5.toFixed(2)}  ${query.recallAt10.toFixed(2)}  ${query.phenomenon}`,
    )
  }
  console.log('')
  console.log(`recall@5  ${result.recallAt5.toFixed(3)}  (gate ${golden.thresholds.min_recall_at_5})`)
  console.log(`recall@10 ${result.recallAt10.toFixed(3)}  (gate ${golden.thresholds.min_recall_at_10})`)
  console.log(`MRR       ${result.mrr.toFixed(3)}  (gate ${golden.thresholds.min_mrr})`)
} finally {
  await database.close()
}
