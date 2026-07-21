// Tool palette (CONTRACTS §7.1 — binding): names, scope visibility, all four
// annotations, shared zod schemas, and the transport duties of execute
// (space resolution, key/space binding, async-ack, llm gate).
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import {
  ConflictError,
  ForbiddenError,
  HumanDecisionRequiredError,
  LlmNotConfiguredError,
  NotFoundError,
} from '../../src/domain/errors.ts'
import type { IngestPipeline } from '../../src/ingest/pipeline.ts'
import {
  buildToolManifest,
  holdsScope,
  TOOLS,
  visibleTools,
  withManualAgentMeta,
  zIngestToolInput,
  zProposalsToolInput,
  zReviewProposalToolInput,
  zProposeToolInput,
  zSourcesToolInput,
  type Principal,
  type ToolDeps,
} from '../../src/mcp/tools.ts'

const READ_TOOLS = [
  'wikikit_guide',
  'wikikit_spaces',
  'wikikit_briefing',
  'wikikit_context',
  'wikikit_search',
  'wikikit_read',
  'wikikit_sources',
  'wikikit_decisions',
  'wikikit_history',
  'wikikit_lint',
]
const PROPOSE_TOOLS = ['wikikit_ingest', 'wikikit_ingest_status', 'wikikit_propose']
const REVIEW_TOOLS = ['wikikit_proposals', 'wikikit_review_proposal']

function principal(overrides: Partial<Principal> = {}): Principal {
  return { keyId: 'key-1', scopes: ['*'], spaceId: null, name: 'test', ...overrides }
}

/** Minimal Db stub: select() answers from canned tables; everything else throws. */
function stubDb(tables: Record<string, Record<string, unknown>[]>): Db {
  return {
    select: async (table: string, query: Record<string, unknown> = {}) => {
      const rows = tables[table] ?? []
      return rows.filter((row) =>
        Object.entries(query).every(([column, expression]) => {
          if (column === 'limit' || column === 'order') return true
          const value = String(expression)
          return value.startsWith('eq.') ? String(row[column]) === value.slice(3) : true
        }),
      ) as never
    },
    query: async () => ({ rows: [], rowCount: 0 }),
    call: async () => [],
    tx: async () => {
      throw new Error('tx not stubbed')
    },
    insert: async () => [],
    update: async () => [],
    remove: async () => {},
    emitEvent: async () => {},
  } as unknown as Db
}

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    config: { llmConfigured: true } as Config,
    db: stubDb({ wk_spaces: [{ id: 'space-1', slug: 'main' }] }),
    ingest: {
      enqueue: async () => ({ ingest_id: '11111111-1111-4111-8111-111111111111' }),
      start: () => {},
      stop: async () => {},
      runOnce: async () => false,
    } as IngestPipeline,
    ...overrides,
  }
}

describe('tool palette shape (binding contract §7.1)', () => {
  test('exactly the fifteen contracted tools — review is explicitly scoped', () => {
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([...READ_TOOLS, ...PROPOSE_TOOLS, ...REVIEW_TOOLS].sort())
    expect(TOOLS.some((tool) => tool.name === 'wikikit_review_proposal')).toBe(true)
  })

  test('all four annotations are explicit on every tool', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean')
      expect(typeof tool.annotations.destructiveHint).toBe('boolean')
      expect(typeof tool.annotations.idempotentHint).toBe('boolean')
      expect(typeof tool.annotations.openWorldHint).toBe('boolean')
    }
  })

  test('never destructiveHint:false on a real write (hard-won rule)', () => {
    for (const tool of TOOLS) {
      if (!tool.annotations.readOnlyHint && tool.name !== 'wikikit_ingest_status') {
        expect(tool.annotations.destructiveHint).toBe(true)
      }
    }
  })

  test('annotation table matches §7.1 exactly', () => {
    const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.annotations]))
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    for (const name of READ_TOOLS) expect(byName[name]).toEqual(read)
    expect(byName.wikikit_ingest_status).toEqual(read)
    expect(byName.wikikit_ingest).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(byName.wikikit_propose).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(byName.wikikit_proposals).toEqual(read)
    expect(byName.wikikit_review_proposal).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    })
  })
})

describe('scope-gated visibility', () => {
  test('knowledge:read sees only the read tools', () => {
    expect(visibleTools(['knowledge:read']).map((tool) => tool.name)).toEqual(READ_TOOLS)
  })

  test('knowledge:propose sees only the propose tools', () => {
    expect(visibleTools(['knowledge:propose']).map((tool) => tool.name)).toEqual(PROPOSE_TOOLS)
  })

  test('review tools require knowledge:approve; admin and * see the full palette', () => {
    expect(visibleTools(['knowledge:read', 'knowledge:propose'])).toHaveLength(13)
    expect(visibleTools(['knowledge:approve']).map((tool) => tool.name)).toEqual(REVIEW_TOOLS)
    expect(visibleTools(['admin'])).toHaveLength(15) // admin implies knowledge scopes (§5.2)
    expect(visibleTools(['*'])).toHaveLength(15)
    expect(visibleTools([])).toHaveLength(0)
  })

  test('holdsScope semantics', () => {
    expect(holdsScope(['knowledge:read'], 'knowledge:read')).toBe(true)
    expect(holdsScope(['knowledge:read'], 'knowledge:propose')).toBe(false)
    expect(holdsScope(['knowledge:approve'], 'knowledge:approve')).toBe(true)
    expect(holdsScope(['admin'], 'knowledge:propose')).toBe(true)
    expect(holdsScope(['*'], 'knowledge:read')).toBe(true)
  })

  test('review input rejects a decision without a valid proposal id', () => {
    expect(() => zProposalsToolInput.parse({ space: 'main', proposal_id: 'not-a-uuid' })).toThrow()
    expect(() => zReviewProposalToolInput.parse({ proposal_id: 'not-a-uuid' })).toThrow()
    expect(() =>
      zReviewProposalToolInput.parse({
        proposal_id: '11111111-1111-4111-8111-111111111111',
        decision: 'approve',
      }),
    ).toThrow()
  })

  test('manifest entries carry name, description, draft-7 schema and annotations', () => {
    for (const entry of buildToolManifest(['*'])) {
      expect(entry.name.startsWith('wikikit_')).toBe(true)
      expect(entry.description.length).toBeGreaterThan(20)
      expect((entry.inputSchema as { type: string }).type).toBe('object')
      expect(entry.inputSchema.additionalProperties).toBe(false)
      expect(Object.keys(entry.annotations).sort()).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
      ])
    }
  })
})

describe('input schemas (shared zod objects)', () => {
  test('wikikit_ingest keeps the exactly-one-of refinement from zIngestInput', () => {
    expect(zIngestToolInput.safeParse({ space: 'main', markdown: '# x' }).success).toBe(true)
    expect(zIngestToolInput.safeParse({ space: 'main', markdown: '# x', text: 'y' }).success).toBe(false)
    expect(zIngestToolInput.safeParse({ space: 'main' }).success).toBe(false)
    expect(zIngestToolInput.safeParse({ markdown: '# x' }).success).toBe(false) // space required
  })

  test('wikikit_sources requires exactly one of slug|source_id', () => {
    expect(zSourcesToolInput.safeParse({ space: 'main', slug: 'okf' }).success).toBe(true)
    expect(
      zSourcesToolInput.safeParse({ space: 'main', source_id: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true)
    expect(zSourcesToolInput.safeParse({ space: 'main' }).success).toBe(false)
    expect(
      zSourcesToolInput.safeParse({ space: 'main', slug: 'okf', source_id: '11111111-1111-4111-8111-111111111111' })
        .success,
    ).toBe(false)
  })

  test('wikikit_propose keeps the at-least-one-concept-or-decision refinement', () => {
    const valid = {
      space: 'main',
      title: 'Add concept',
      input_hash: 'a'.repeat(64),
      concepts: [{ slug: 'okf', title: 'OKF', markdown: '# OKF' }],
    }
    expect(zProposeToolInput.safeParse(valid).success).toBe(true)
    expect(zProposeToolInput.safeParse({ ...valid, concepts: [] }).success).toBe(false)
  })
})

describe('execute — transport duties', () => {
  const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]))

  test('wikikit_guide returns the embedded, code-versioned system scope without a database lookup', async () => {
    const result = (await byName.wikikit_guide!.execute(
      deps({ config: { root: import.meta.dir, version: '1.2.3-test' } as Config }),
      principal(),
      {},
    )) as { scope: string; resource_uri: string; version: string; markdown: string }
    expect(result.scope).toBe('wikikit://system')
    expect(result.resource_uri).toBe('wikikit://system/agent-guide')
    expect(result.version).toBe('1.2.3-test')
    expect(result.markdown).toContain('# WikiKit agent guide')
  })

  test('unknown space → not_found', async () => {
    expect(byName.wikikit_search!.execute(deps(), principal(), { space: 'nope', q: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('space-scoped key on a foreign space → insufficient_scope, not 404', async () => {
    expect(
      byName.wikikit_search!.execute(deps(), principal({ spaceId: 'space-OTHER' }), { space: 'main', q: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  test('wikikit_search maps db.call hits into the wire shape', async () => {
    const db = stubDb({ wk_spaces: [{ id: 'space-1', slug: 'main' }] })
    db.call = async () =>
      [
        {
          kind: 'concept',
          concept_slug: 'okf',
          claim_id: null,
          title: 'OKF',
          headline: '<mark>OKF</mark>',
          rank: '0.6',
        },
      ] as never
    const result = (await byName.wikikit_search!.execute(deps({ db }), principal(), {
      space: 'main',
      q: 'okf',
    })) as { hits: { slug: string | null; rank: number }[] }
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.slug).toBe('okf')
    expect(result.hits[0]!.rank).toBe(0.6)
  })

  test('wikikit_ingest without ANTHROPIC_API_KEY → llm_not_configured, nothing queued', async () => {
    let enqueued = 0
    const d = deps({ config: { llmConfigured: false } as Config })
    d.ingest.enqueue = async () => {
      enqueued += 1
      return { ingest_id: 'x' }
    }
    expect(byName.wikikit_ingest!.execute(d, principal(), { space: 'main', markdown: '# x' })).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    )
    expect(enqueued).toBe(0)
  })

  test('wikikit_ingest returns the async ack (§7.1: never blocks)', async () => {
    const result = await byName.wikikit_ingest!.execute(deps(), principal(), { space: 'main', markdown: '# note' })
    expect(result).toEqual({
      status: 'running',
      ingest_id: '11111111-1111-4111-8111-111111111111',
      poll_with: 'wikikit_ingest_status',
    })
  })

  test('wikikit_review_proposal takes decision and note only from native elicitation', async () => {
    const proposalId = '11111111-1111-4111-8111-111111111111'
    const db = stubDb({
      wk_spaces: [{ id: 'space-1', slug: 'main' }],
      wk_change_proposals: [
        {
          id: proposalId,
          space_id: 'space-1',
          status: 'pending',
          title: 'Review me',
          summary: 'One bounded change.',
          input_hash: 'a'.repeat(64),
          source_ids: [],
          agent_meta: {},
          reviewer: null,
          review_note: null,
          review_channel: null,
          reviewed_at: null,
          created_at: '2026-07-21T08:00:00.000Z',
        },
      ],
    })
    let callArgs: unknown[] = []
    db.call = async (_fn, args) => {
      callArgs = args
      return [{ proposal_id: proposalId, status: 'rejected', review_channel: 'mcp_elicitation' }] as never
    }
    let spaceSlug = ''
    let outcome = ''
    const result = await byName.wikikit_review_proposal!.execute(
      deps({ db }),
      principal({ name: 'human-reviewer' }),
      { proposal_id: proposalId },
      {
        formElicitationSupported: true,
        elicitForm: async () => ({ action: 'accept', content: { decision: 'reject', note: 'Not ready.' } }),
        setOutcome: (value) => {
          outcome = value
        },
        setSpaceSlug: (value) => {
          spaceSlug = value
        },
      },
    )
    expect(result).toEqual({ proposal_id: proposalId, status: 'rejected', review_channel: 'mcp_elicitation' })
    expect(callArgs).toEqual([proposalId, 'human-reviewer', 'Not ready.', 'mcp_elicitation'])
    expect(spaceSlug).toBe('main')
    expect(outcome).toBe('') // accepted writes use the default success outcome
  })

  test('wikikit_review_proposal refuses decision/note as tool input before touching the database', async () => {
    // A db whose every access throws proves the refusal happens first.
    const throwingDb = new Proxy({} as Db, {
      get() {
        throw new Error('db must not be touched')
      },
    })
    for (const input of [
      { proposal_id: '11111111-1111-4111-8111-111111111111', decision: 'approve' },
      { proposal_id: '11111111-1111-4111-8111-111111111111', decision: 'approve', note: 'x' },
      { proposal_id: '11111111-1111-4111-8111-111111111111', note: 'x' },
    ]) {
      await expect(
        byName.wikikit_review_proposal!.execute(deps({ db: throwingDb }), principal(), input),
      ).rejects.toBeInstanceOf(HumanDecisionRequiredError)
    }
  })

  test('wikikit_review_proposal declines without a write and fails closed without a form bridge', async () => {
    const proposalId = '11111111-1111-4111-8111-111111111111'
    const db = stubDb({
      wk_spaces: [{ id: 'space-1', slug: 'main' }],
      wk_change_proposals: [
        {
          id: proposalId,
          space_id: 'space-1',
          status: 'pending',
          title: 'Review me',
          summary: '',
          input_hash: 'a'.repeat(64),
          source_ids: [],
          agent_meta: {},
          reviewer: null,
          review_note: null,
          review_channel: null,
          reviewed_at: null,
          created_at: '2026-07-21T08:00:00.000Z',
        },
      ],
    })
    let writes = 0
    db.call = async () => {
      writes += 1
      return []
    }
    let outcome = ''
    const noOp = await byName.wikikit_review_proposal!.execute(
      deps({ db }),
      principal(),
      { proposal_id: proposalId },
      {
        formElicitationSupported: true,
        elicitForm: async () => ({ action: 'decline' }),
        setOutcome: (value) => {
          outcome = value
        },
        setSpaceSlug: () => {},
      },
    )
    expect(noOp).toEqual({ proposal_id: proposalId, outcome: 'decline', mutation_applied: false })
    expect(outcome).toBe('rejected')
    expect(writes).toBe(0)
  })

  test('wikikit_review_proposal hands off to out-of-band human review without a form-capable client', async () => {
    const proposalId = '11111111-1111-4111-8111-111111111111'
    const db = stubDb({
      wk_spaces: [{ id: 'space-1', slug: 'main' }],
      wk_change_proposals: [
        {
          id: proposalId,
          space_id: 'space-1',
          status: 'pending',
          title: 'Review me',
          summary: '',
          input_hash: 'a'.repeat(64),
          source_ids: [],
          agent_meta: {},
          reviewer: null,
          review_note: null,
          review_channel: null,
          reviewed_at: null,
          created_at: '2026-07-21T08:00:00.000Z',
        },
      ],
    })
    let writes = 0
    db.call = async () => {
      writes += 1
      return []
    }
    const expectHandoff = (result: unknown) => {
      expect(result).toMatchObject({
        proposal_id: proposalId,
        status: 'pending',
        outcome: 'human_review_required',
        mutation_applied: false,
        poll_with: 'wikikit_proposals',
      })
      const instructions = (result as { agent_instructions: string }).agent_instructions
      expect(instructions).toContain('Do not ask for the decision in chat')
      expect(instructions).toContain('Check wikikit_proposals later')
    }
    // No execution context at all (a future non-MCP caller).
    expectHandoff(await byName.wikikit_review_proposal!.execute(deps({ db }), principal(), { proposal_id: proposalId }))
    // A live context whose client does not advertise elicitation.form: the
    // hand-off must be returned WITHOUT attempting the form bridge.
    let outcome = ''
    let spaceSlug = ''
    expectHandoff(
      await byName.wikikit_review_proposal!.execute(
        deps({ db }),
        principal(),
        { proposal_id: proposalId },
        {
          formElicitationSupported: false,
          elicitForm: async () => {
            throw new Error('elicitForm must not be called')
          },
          setOutcome: (value) => {
            outcome = value
          },
          setSpaceSlug: (value) => {
            spaceSlug = value
          },
        },
      ),
    )
    expect(outcome).toBe('handoff')
    expect(spaceSlug).toBe('main')
    expect(writes).toBe(0)
  })

  test('wikikit_ingest surfaces the dedup conflict from enqueue', async () => {
    const d = deps()
    d.ingest.enqueue = async () => {
      throw new ConflictError('already_ingested', 'already there', { details: { source_id: 's-1' } })
    }
    expect(byName.wikikit_ingest!.execute(d, principal(), { space: 'main', markdown: '# x' })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  test('wikikit_ingest_status enforces the key/space binding on the global id', async () => {
    const db = stubDb({
      wk_spaces: [{ id: 'space-1', slug: 'main' }],
      wk_ingest_jobs: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          space_id: 'space-1',
          status: 'done',
          proposal_id: 'p-1',
          source_id: 's-1',
          error: null,
        },
      ],
    })
    const ok = await byName.wikikit_ingest_status!.execute(deps({ db }), principal(), {
      ingest_id: '22222222-2222-4222-8222-222222222222',
    })
    expect(ok).toEqual({
      ingest_id: '22222222-2222-4222-8222-222222222222',
      status: 'done',
      proposal_id: 'p-1',
      source_id: 's-1',
      error: null,
    })

    expect(
      byName.wikikit_ingest_status!.execute(deps({ db }), principal({ spaceId: 'space-OTHER' }), {
        ingest_id: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    expect(
      byName.wikikit_ingest_status!.execute(deps({ db }), principal(), {
        ingest_id: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('withManualAgentMeta (§1.14)', () => {
  test('fills model/prompt_version for agent-authored proposals', () => {
    expect(withManualAgentMeta({})).toEqual({ model: 'manual', prompt_version: 'manual' })
    expect(withManualAgentMeta({ note: 'x' })).toEqual({ model: 'manual', prompt_version: 'manual', note: 'x' })
  })

  test('never overrides an explicit model', () => {
    expect(withManualAgentMeta({ model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' })).toEqual({
      model: 'claude-sonnet-5',
      prompt_version: 'synthesize.v1',
    })
  })
})
