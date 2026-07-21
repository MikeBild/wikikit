// MCP end-to-end against a real Docker Postgres (plan §14.3): the exact loop
// a federated client runs — initialize → tools/call search over approved
// knowledge → session reuse → foreign-key-on-known-session → 404 → async
// ingest ack + status poll. Gated behind RUN_INTEGRATION=1;
// scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createServer, type Server as NodeServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { UnauthorizedError } from '../../src/domain/errors.ts'
import { approveProposal, computeInputHash, createProposal } from '../../src/domain/proposals.ts'
import { createIngestPipeline, type IngestPipeline } from '../../src/ingest/pipeline.ts'
import { createFakeProvider } from '../../src/llm/fake.ts'
import { createLogger } from '../../src/logger.ts'
import { createMcpMount, toNodeRawHandler, type McpMount } from '../../src/mcp/server.ts'
import type { Principal } from '../../src/mcp/tools.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createUsageTelemetry } from '../../src/usage.ts'
import { getMcpUsageStats, resolveUsageStatsWindow } from '../../src/stats.ts'
import { readMcpJson } from '../helpers/mcp.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BASE = 'http://127.0.0.1:4060'
const logger = createLogger({ level: 'error', write: () => {} })

let database: Database
let db: Db
let ingest: IngestPipeline
let mount: McpMount
let spaceId: string
let nodeServer: NodeServer
let liveMcpUrl: string

// Two VALID credentials with identical scopes — the hijack guard must reject
// key B on key A's session even though B could open its own session freely.
const KEYS: Record<string, Principal> = {
  wk_reader_a: { keyId: 'key-a', scopes: ['knowledge:read', 'knowledge:propose'], spaceId: null, name: 'agent-a' },
  wk_reader_b: { keyId: 'key-b', scopes: ['knowledge:read', 'knowledge:propose'], spaceId: null, name: 'agent-b' },
  wk_reviewer: {
    keyId: 'key-reviewer',
    scopes: ['knowledge:read', 'knowledge:approve'],
    spaceId: null,
    name: 'reviewer',
  },
}

function rpc(body: Record<string, unknown>, token: string, sessionId?: string): Request {
  return new Request(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  })
}

let rpcId = 0
async function callTool(
  token: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
  const response = await mount.handler(
    rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, token, sessionId),
  )
  expect(response.status).toBe(200)
  const body = await readMcpJson<{
    result: { isError?: boolean; content: [{ type: string; text: string }] }
  }>(response)
  return { isError: body.result.isError, payload: JSON.parse(body.result.content[0].text) as Record<string, unknown> }
}

async function initialize(token: string): Promise<string> {
  const response = await mount.handler(
    rpc(
      {
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'initialize',
        params: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '0' },
        },
      },
      token,
    ),
  )
  expect(response.status).toBe(200)
  const result = (await readMcpJson<{ result: { serverInfo: { name: string } } }>(response)).result
  expect(result.serverInfo.name).toBe('wikikit')
  const sessionId = response.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()
  return sessionId!
}

describe('MCP server (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_mcp')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db

    // Seed one APPROVED concept so search has visible knowledge to find.
    const [space] = await db.insert<{ id: string }>('wk_spaces', { slug: 'brain', name: 'Brain' })
    spaceId = space!.id
    const staged = await createProposal(db, spaceId, {
      title: 'Seed OKF concept',
      input_hash: computeInputHash(['seed'], 'manual'),
      agent_meta: { model: 'manual', prompt_version: 'manual' },
      concepts: [
        {
          slug: 'open-knowledge-format',
          title: 'Open Knowledge Format',
          summary: 'A portable knowledge bundle spec.',
          markdown: '# Open Knowledge Format\n\nOKF is a portable knowledge bundle format.',
          claims: [],
          relations: [],
        },
      ],
    })
    await approveProposal(db, { id: staged.proposal_id, reviewer: 'integration-test' })

    const config = {
      version: '0.0.0-integration',
      publicUrl: BASE,
      mcpSessionTtlMs: 60_000,
      mcpMaxSessions: 10,
      llmConfigured: true, // FakeProvider stands in — no network, no real key
      maxBodyBytes: 1024 * 1024,
      maxIngestTokens: 10_000,
      ingestConcurrency: 1,
      usageTelemetryEnabled: true,
      usageHmacSecret: 'itest-mcp-usage-secret',
      usageRetentionDays: 90,
    } as Config
    ingest = createIngestPipeline(config, db, createFakeProvider(), logger)
    const usage = createUsageTelemetry(config, db, logger)
    mount = createMcpMount(config, {
      config,
      db,
      ingest,
      auth: {
        authenticate: async (headerValue) => {
          const token = headerValue?.replace(/^Bearer\s+/i, '')
          const principal = token ? KEYS[token] : undefined
          if (!principal) throw new UnauthorizedError()
          return principal
        },
      },
      logger,
      usage,
    })
    nodeServer = createServer((req, res) => void toNodeRawHandler(mount)(req, res))
    await new Promise<void>((resolve) => nodeServer.listen(0, '127.0.0.1', resolve))
    const address = nodeServer.address() as { port: number }
    liveMcpUrl = `http://127.0.0.1:${address.port}/mcp`
  })

  afterAll(async () => {
    if (!integration) return
    mount.stop()
    await new Promise<void>((resolve) => nodeServer.close(() => resolve()))
    await database.close()
  })

  it('initialize → search finds approved knowledge → session reuse → hijack 404', async () => {
    const sessionId = await initialize('wk_reader_a')

    // notifications/initialized completes the handshake (202, no body).
    const notified = await mount.handler(
      rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'wk_reader_a', sessionId),
    )
    expect(notified.status).toBe(202)

    // Search over the seeded, APPROVED concept.
    const search = await callTool('wk_reader_a', sessionId, 'wikikit_search', { space: 'brain', q: 'portable' })
    expect(search.isError).toBeFalsy()
    const hits = search.payload.hits as { slug: string; kind: string }[]
    expect(hits.some((hit) => hit.slug === 'open-knowledge-format')).toBe(true)

    // Session REUSE: a second call rides the same lease (no re-initialize).
    const sessionsBefore = mount.sessions.sessions.size
    const read = await callTool('wk_reader_a', sessionId, 'wikikit_read', {
      space: 'brain',
      slug: 'open-knowledge-format',
    })
    expect(read.isError).toBeFalsy()
    expect(read.payload.rev).toBe(1)
    expect(mount.sessions.sessions.size).toBe(sessionsBefore)

    // Decision log is reachable as a read tool (empty is a valid answer — no
    // decisions seeded — proving the tool is wired and scope-visible).
    const decisions = await callTool('wk_reader_a', sessionId, 'wikikit_decisions', { space: 'brain' })
    expect(decisions.isError).toBeFalsy()
    expect(Array.isArray(decisions.payload.decisions)).toBe(true)

    // Foreign VALID key on the known session id → the same 404/-32001 an
    // unknown session gets (no confirmation the id exists).
    const hijack = await mount.handler(
      rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }, 'wk_reader_b', sessionId),
    )
    expect(hijack.status).toBe(404)
    expect(((await hijack.json()) as { error: { code: number } }).error.code).toBe(-32001)

    // Unknown session id → identical signal.
    const unknown = await mount.handler(
      rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }, 'wk_reader_a', crypto.randomUUID()),
    )
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32001)

    // The owner's session survived both rejections.
    const stillAlive = await callTool('wk_reader_a', sessionId, 'wikikit_lint', { space: 'brain' })
    expect(stillAlive.isError).toBeFalsy()
  })

  it('wikikit_ingest answers an async ack; status polling reaches the proposal', async () => {
    const sessionId = await initialize('wk_reader_a')

    const ack = await callTool('wk_reader_a', sessionId, 'wikikit_ingest', {
      space: 'brain',
      markdown: '# Meeting notes\n\nWe decided to keep MCP approval on REST.',
      title: 'Meeting notes',
      source_kind: 'meeting',
    })
    expect(ack.isError).toBeFalsy()
    expect(ack.payload.status).toBe('running')
    expect(ack.payload.poll_with).toBe('wikikit_ingest_status')
    const ingestId = ack.payload.ingest_id as string

    const queued = await callTool('wk_reader_a', sessionId, 'wikikit_ingest_status', { ingest_id: ingestId })
    expect(queued.payload.status).toBe('queued')

    // Drive the worker deterministically (no timer loops in tests).
    expect(await ingest.runOnce()).toBe(true)

    const done = await callTool('wk_reader_a', sessionId, 'wikikit_ingest_status', { ingest_id: ingestId })
    expect(done.payload.status).toBe('done')
    expect(done.payload.proposal_id).toBeTruthy()

    // The review-capable MCP surface must expose every staged decision before
    // a human can call wikikit_review_proposal. Its public payload is the same
    // wire projection REST serves and therefore omits the internal space_id.
    const reviewerSession = await initialize('wk_reviewer')
    const review = await callTool('wk_reviewer', reviewerSession, 'wikikit_proposals', {
      space: 'brain',
      proposal_id: done.payload.proposal_id,
    })
    expect(review.isError).toBeFalsy()
    expect(review.payload.space_id).toBeUndefined()
    expect(review.payload.decisions).toEqual([
      {
        slug: 'meeting-notes-decision',
        title: 'Decision on Meeting notes',
        context: '# Meeting notes',
        decision: '# Meeting notes',
        rationale: '',
        alternatives: [],
      },
    ])

    // Idempotency: re-ingesting identical content is a terminal conflict.
    const duplicate = await callTool('wk_reader_a', sessionId, 'wikikit_ingest', {
      space: 'brain',
      markdown: '# Meeting notes\n\nWe decided to keep MCP approval on REST.',
      title: 'Meeting notes',
    })
    expect(duplicate.isError).toBe(true)
    expect(duplicate.payload.code).toBe('already_ingested')
    expect((duplicate.payload.next_best_actions as string[]).length).toBeGreaterThan(0)
  })

  it('native form elicitation owns the decision; missing capability hands off to out-of-band human review', async () => {
    const staged = await createProposal(db, spaceId, {
      title: 'Native MCP review integration',
      input_hash: computeInputHash(['native-mcp-review'], 'manual'),
      agent_meta: { model: 'manual', prompt_version: 'manual' },
      concepts: [
        {
          slug: 'native-mcp-review',
          title: 'Native MCP review',
          summary: 'Integration-only knowledge.',
          markdown: '# Native MCP review\n\nA human supplied the final decision through MCP elicitation.',
          claims: [],
          relations: [],
        },
      ],
    })

    const client = new Client(
      { name: 'wikikit-elicitation-itest', version: '1' },
      { capabilities: { elicitation: { form: {} } } },
    )
    let formRequests = 0
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      formRequests += 1
      expect(request.params.mode).toBe('form')
      if (request.params.mode !== 'form') return { action: 'cancel' }
      expect(request.params.requestedSchema.required).toEqual(['decision'])
      expect(request.params.message).toContain(staged.proposal_id)
      return { action: 'accept', content: { decision: 'approve', note: 'Approved through native MCP.' } }
    })
    const transport = new StreamableHTTPClientTransport(new URL(liveMcpUrl), {
      requestInit: {
        headers: { authorization: 'Bearer wk_reviewer', 'x-wikikit-traffic-class': 'synthetic' },
      },
    })
    await client.connect(transport)
    try {
      await client.callTool({
        name: 'wikikit_proposals',
        arguments: { space: 'brain', proposal_id: staged.proposal_id },
      })
      const result = (await client.callTool({
        name: 'wikikit_review_proposal',
        arguments: { proposal_id: staged.proposal_id },
      })) as { isError?: boolean; content: { type: string; text?: string }[] }
      const content = result.content.find((entry) => entry.type === 'text')
      expect(content?.type).toBe('text')
      const payload = JSON.parse(content?.type === 'text' ? (content.text ?? '{}') : '{}') as Record<string, unknown>
      expect(payload).toMatchObject({
        proposal_id: staged.proposal_id,
        status: 'approved',
        review_channel: 'mcp_elicitation',
      })
      expect(formRequests).toBe(1)
    } finally {
      await client.close()
    }

    const [reviewed] = await db.select<{ status: string; reviewer: string; review_channel: string }>(
      'wk_change_proposals',
      { id: `eq.${staged.proposal_id}`, limit: 1 },
    )
    expect(reviewed).toMatchObject({ status: 'approved', reviewer: 'reviewer', review_channel: 'mcp_elicitation' })
    const event = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM wk_outbox_events
        WHERE event_type = 'wikikit.proposal.approved' AND payload->>'proposal_id' = $1`,
      [staged.proposal_id],
    )
    expect(event.rows[0]!.payload.review_channel).toBe('mcp_elicitation')

    const unsupported = await createProposal(db, spaceId, {
      title: 'Fail-closed integration',
      input_hash: computeInputHash(['native-mcp-unsupported'], 'manual'),
      agent_meta: { model: 'manual', prompt_version: 'manual' },
      decisions: [
        {
          slug: 'native-mcp-unsupported',
          title: 'Fail closed',
          context: 'The client has no elicitation capability.',
          decision: 'Do not mutate.',
        },
      ],
    })
    const legacyClient = new Client({ name: 'wikikit-no-elicitation-itest', version: '1' }, { capabilities: {} })
    const legacyTransport = new StreamableHTTPClientTransport(new URL(liveMcpUrl), {
      requestInit: { headers: { authorization: 'Bearer wk_reviewer' } },
    })
    await legacyClient.connect(legacyTransport)
    try {
      const result = (await legacyClient.callTool({
        name: 'wikikit_review_proposal',
        arguments: { proposal_id: unsupported.proposal_id },
      })) as { isError?: boolean; content: { type: string; text?: string }[] }
      // A success frame, not an error: the proposal stays pending and the
      // agent is told to hand the review to a human and poll wikikit_proposals.
      expect(result.isError).toBeFalsy()
      const content = result.content.find((entry) => entry.type === 'text')
      const payload = JSON.parse(content?.type === 'text' ? (content.text ?? '{}') : '{}') as Record<string, unknown>
      expect(payload).toMatchObject({
        proposal_id: unsupported.proposal_id,
        status: 'pending',
        outcome: 'human_review_required',
        mutation_applied: false,
        poll_with: 'wikikit_proposals',
      })
      expect(String(payload.agent_instructions)).toContain('Do not ask for the decision in chat')
    } finally {
      await legacyClient.close()
    }
    const [stillPending] = await db.select<{ status: string; review_channel: string | null }>('wk_change_proposals', {
      id: `eq.${unsupported.proposal_id}`,
      limit: 1,
    })
    expect(stillPending).toMatchObject({ status: 'pending', review_channel: null })
  })

  it('refuses decision/note as review tool input with approval_requires_human', async () => {
    const staged = await createProposal(db, spaceId, {
      title: 'Agent-supplied decision refusal',
      input_hash: computeInputHash(['agent-decision-refusal'], 'manual'),
      agent_meta: { model: 'manual', prompt_version: 'manual' },
      decisions: [
        {
          slug: 'agent-decision-refusal',
          title: 'Refuse agent decisions',
          context: 'The agent tried to pass the human decision as tool input.',
          decision: 'Refuse without touching the proposal.',
        },
      ],
    })
    const client = new Client(
      { name: 'wikikit-agent-decision-itest', version: '1' },
      { capabilities: { elicitation: { form: {} } } },
    )
    let formRequests = 0
    client.setRequestHandler(ElicitRequestSchema, async () => {
      formRequests += 1
      return { action: 'cancel' }
    })
    const transport = new StreamableHTTPClientTransport(new URL(liveMcpUrl), {
      requestInit: { headers: { authorization: 'Bearer wk_reviewer', 'x-wikikit-traffic-class': 'synthetic' } },
    })
    await client.connect(transport)
    try {
      const result = (await client.callTool({
        name: 'wikikit_review_proposal',
        arguments: { proposal_id: staged.proposal_id, decision: 'approve', note: 'looks good' },
      })) as { isError?: boolean; content: { type: string; text?: string }[] }
      expect(result.isError).toBe(true)
      const content = result.content.find((entry) => entry.type === 'text')
      const payload = JSON.parse(content?.type === 'text' ? (content.text ?? '{}') : '{}') as Record<string, unknown>
      expect(payload.code).toBe('approval_requires_human')
      const actions = (payload.next_best_actions as string[]).join(' ')
      expect(actions).toContain('only { proposal_id }')
      expect(actions).toContain('never collect approve/reject in chat')
      // The refusal happened before any form was sent or any row was touched.
      expect(formRequests).toBe(0)
    } finally {
      await client.close()
    }
    const [untouched] = await db.select<{ status: string; review_channel: string | null }>('wk_change_proposals', {
      id: `eq.${staged.proposal_id}`,
      limit: 1,
    })
    expect(untouched).toMatchObject({ status: 'pending', review_channel: null })
  })

  it('persists content-free MCP telemetry and returns exact aggregate statistics', async () => {
    await Bun.sleep(30)
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT * FROM wk_usage_events WHERE surface = 'mcp' ORDER BY created_at",
    )
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.some((row) => row.operation === 'session_initialized')).toBe(true)
    expect(rows.some((row) => row.tool_name === 'wikikit_search')).toBe(true)
    expect(rows.every((row) => row.actor_hmac == null || /^[0-9a-f]{64}$/.test(String(row.actor_hmac)))).toBe(true)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toMatch(/portable|Meeting notes|raw-mcp-session|wk_reader_a|open-knowledge-format/)

    const now = Date.now()
    const window = resolveUsageStatsWindow(
      {
        from: new Date(now - 60 * 60 * 1000).toISOString(),
        to: new Date(now + 60 * 60 * 1000).toISOString(),
        traffic_class: 'all',
      },
      'mcp',
    )
    const stats = await getMcpUsageStats(db, window, { dropped_events: 0, retention_days: 90 })
    expect(stats.schema_version).toBe('wikikit.usage-stats.v1')
    expect(stats.totals[0]!.metrics.calls.value).toBeGreaterThan(5)
    expect(stats.quality).toMatchObject({ sampled: false, content_captured: false })
  })
})
