// Deleting a page is a reviewed lifecycle transition, never a database
// shortcut. Exercise the trigger and the existing proposal apply function
// together, because either side alone can look correct in a stub.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { listDeletedConcepts, stageConceptLifecycle } from '../../src/domain/concept-lifecycle.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db

async function seedReadableConcept(spaceId: string, slug: string): Promise<{ conceptId: string; revisionId: string }> {
  const [concept] = await db.insert<{ id: string }>('wk_concepts', { space_id: spaceId, slug, title: `Page ${slug}` })
  const [revision] = await db.insert<{ id: string }>('wk_concept_revisions', {
    space_id: spaceId,
    concept_id: concept!.id,
    rev: 1,
    status: 'current',
    title: `Page ${slug}`,
    summary: 'Reviewed page.',
    markdown: `# ${slug}`,
    agent_meta: { model: 'manual', prompt_version: 'test' },
  })
  await db.update(
    'wk_concepts',
    { id: `eq.${concept!.id}` },
    { current_revision_id: revision!.id },
    { returning: false },
  )
  return { conceptId: concept!.id, revisionId: revision!.id }
}

describe('concept lifecycle (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_concept_lifecycle')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
  })

  afterAll(async () => {
    if (integration) await database.close()
  })

  it('review-gates deletion and restoration, preserves the revision, and leaves removed local relations removed', async () => {
    const [space] = await db.insert<{ id: string }>('wk_spaces', { slug: 'lifecycle', name: 'Lifecycle' })
    const page = await seedReadableConcept(space!.id, 'page')
    const neighbour = await seedReadableConcept(space!.id, 'neighbour')
    await db.insert(
      'wk_relations',
      {
        space_id: space!.id,
        from_concept_id: page.conceptId,
        to_concept_id: neighbour.conceptId,
        kind: 'related',
        status: 'active',
      },
      { returning: false },
    )

    const deletion = await stageConceptLifecycle(db, space!.id, { slug: 'page', action: 'delete', actor: 'test' })
    expect(deletion.status).toBe('pending')
    const [beforeReview] = await db.select<{ current_revision_id: string }>('wk_concepts', {
      id: `eq.${page.conceptId}`,
    })
    expect(beforeReview!.current_revision_id).toBe(page.revisionId)

    await db.call('wk_apply_proposal', [deletion.proposal_id, 'reviewer'])
    const [deleted] = await db.select<{ current_revision_id: string | null; deleted_revision_id: string | null }>(
      'wk_concepts',
      { id: `eq.${page.conceptId}` },
    )
    expect(deleted).toMatchObject({ current_revision_id: null, deleted_revision_id: page.revisionId })
    const [removed] = await db.select<{ status: string }>('wk_relations', { from_concept_id: `eq.${page.conceptId}` })
    expect(removed!.status).toBe('removed')
    expect((await listDeletedConcepts(db, space!.id)).items.map((item) => item.slug)).toEqual(['page'])

    const restoration = await stageConceptLifecycle(db, space!.id, { slug: 'page', action: 'restore', actor: 'test' })
    await db.call('wk_apply_proposal', [restoration.proposal_id, 'reviewer'])
    const [restored] = await db.select<{ current_revision_id: string | null; deleted_at: string | null }>(
      'wk_concepts',
      { id: `eq.${page.conceptId}` },
    )
    expect(restored!.current_revision_id).toBe(page.revisionId)
    expect(restored!.deleted_at).toBeNull()
    const [stillRemoved] = await db.select<{ status: string }>('wk_relations', {
      from_concept_id: `eq.${page.conceptId}`,
    })
    expect(stillRemoved!.status).toBe('removed')
  })
})
