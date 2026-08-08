/**
 * A PoolLike that records every statement before passing it through — the
 * instrument behind every "this read costs a constant number of queries" test.
 *
 * `createPostgres` already takes an injected pool for exactly this kind of
 * observation, so nothing in production code has to grow a hook to be
 * measurable. Note it wraps `connect()` too: `db.tx` runs through a checked-out
 * client, and a pool that only counted autocommit statements would report zero
 * for anything transactional.
 *
 * Statements are COUNTED rather than timed, everywhere this is used. A
 * wall-clock bound loose enough not to flake on a loaded CI box is loose enough
 * to let an N+1 through; a count is exact and says what it means.
 *
 * Shared rather than copied per test file: two suites asserting the cost of two
 * reads must be measuring the same thing, and a private copy that forgot to
 * wrap `connect()` would report a comfortable zero for the read that hurts.
 */
import pg from 'pg'
import type { PoolLike } from '../../src/db/postgres.ts'

export function countingPool(url: string): { pool: PoolLike; statements: string[] } {
  const inner = new pg.Pool({ connectionString: url, max: 4 })
  const statements: string[] = []
  return {
    statements,
    pool: {
      async query(sql, values) {
        statements.push(sql)
        const result = await inner.query(sql, values as unknown[])
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount }
      },
      async connect() {
        const client = await inner.connect()
        return {
          async query(sql, values) {
            statements.push(sql)
            const result = await client.query(sql, values as unknown[])
            return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount }
          },
          release: () => client.release(),
        }
      },
      async end() {
        await inner.end()
      },
    },
  }
}
