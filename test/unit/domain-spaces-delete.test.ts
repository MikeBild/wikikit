import { describe, expect, test } from 'bun:test'
import type { Db, SelectQuery } from '../../src/db/postgres.ts'
import { ConflictError } from '../../src/domain/errors.ts'
import { deleteSpace } from '../../src/domain/spaces.ts'

function fakeDb(options: { exists?: boolean; busy?: boolean } = {}) {
  const removed: { table: string; filters: SelectQuery }[] = []
  const db = {
    async select(table: string) {
      if (table === 'wk_spaces') {
        return options.exists === false
          ? []
          : [
              {
                id: 'a4b0c9d8-0000-4000-8000-000000000001',
                slug: 'alpha',
                name: 'Alpha',
                settings: {},
                epoch: 1,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ]
      }
      if (table === 'wk_ingest_jobs') return options.busy ? [{ id: 'job' }] : []
      return []
    },
    async remove(table: string, filters: SelectQuery) {
      removed.push({ table, filters })
    },
  } as unknown as Db
  return { db, removed }
}

describe('deleteSpace', () => {
  test('removes the exact wiki and lets foreign-key cascades own dependent data', async () => {
    const { db, removed } = fakeDb()
    await deleteSpace(db, 'alpha')
    expect(removed).toEqual([{ table: 'wk_spaces', filters: { id: 'eq.a4b0c9d8-0000-4000-8000-000000000001' } }])
  })

  test('is idempotent when a retry arrives after the wiki is gone', async () => {
    const { db, removed } = fakeDb({ exists: false })
    await deleteSpace(db, 'alpha')
    expect(removed).toEqual([])
  })

  test('refuses while ingest work is queued or running', async () => {
    const { db, removed } = fakeDb({ busy: true })
    await expect(deleteSpace(db, 'alpha')).rejects.toBeInstanceOf(ConflictError)
    expect(removed).toEqual([])
  })
})
