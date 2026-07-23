// MCP mount behavior without a database: transport guards, auth gating,
// initialize handshake, session ownership (foreign credential → 404),
// unknown-session -32001, scope-filtered tools/list, tool-error envelopes.
import { describe, expect, test } from 'bun:test'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { UnauthorizedError } from '../../src/domain/errors.ts'
import type { IngestPipeline } from '../../src/ingest/pipeline.ts'
import { createLogger } from '../../src/logger.ts'
import { createMcpMount, toNodeRawHandler, validateMcpRequest, type McpDeps } from '../../src/mcp/server.ts'
import type { Principal } from '../../src/mcp/tools.ts'
import { readMcpJson } from '../helpers/mcp.ts'

const BASE = 'http://127.0.0.1:4060'
const logger = createLogger({ level: 'error', write: () => {} })

const config = {
  version: '0.0.0-test',
  publicUrl: 'https://wikikit.example.dev',
  mcpSessionTtlMs: 60_000,
  mcpMaxSessions: 10,
  llmConfigured: false,
} as Config

const READ_PRINCIPAL: Principal = { keyId: 'key-read', scopes: ['knowledge:read'], spaceId: null, name: 'reader' }
const PROPOSE_PRINCIPAL: Principal = {
  keyId: 'key-propose',
  scopes: ['knowledge:propose'],
  spaceId: null,
  name: 'proposer',
}

/** Token → principal fake, shaped like src/http/auth.ts authenticate(). */
function fakeAuth(tokens: Record<string, Principal>): McpDeps['auth'] {
  return {
    authenticate: async (headerValue) => {
      const token = headerValue?.replace(/^Bearer\s+/i, '')
      const found = token ? tokens[token] : undefined
      if (!found) throw new UnauthorizedError()
      return found
    },
  }
}

function buildMount(tokens: Record<string, Principal>) {
  return createMcpMount(config, {
    config,
    db: {} as Db,
    ingest: {} as IngestPipeline,
    auth: fakeAuth(tokens),
    logger,
  })
}

function rpc(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
    capabilities: {},
    clientInfo: { name: 'unit-test', version: '0' },
  },
}

async function initialize(mount: ReturnType<typeof buildMount>, token: string): Promise<string> {
  const response = await mount.handler(rpc(INITIALIZE, { authorization: `Bearer ${token}` }))
  expect(response.status).toBe(200)
  const sessionId = response.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()
  return sessionId!
}

describe('validateMcpRequest (guards)', () => {
  test('no Origin header passes (non-browser MCP clients)', () => {
    expect(validateMcpRequest(new Request(`${BASE}/mcp`, { method: 'POST' }), config).ok).toBe(true)
  })

  test('loopback and public-url origins pass; anything else is a 403', async () => {
    const own = new Request(`${BASE}/mcp`, { method: 'POST', headers: { origin: BASE } })
    expect(validateMcpRequest(own, config).ok).toBe(true)
    const localhost = new Request(`${BASE}/mcp`, { method: 'POST', headers: { origin: 'http://localhost:5173' } })
    expect(validateMcpRequest(localhost, config).ok).toBe(true)

    const publicOrigin = new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { origin: 'https://wikikit.example.dev' },
    })
    expect(validateMcpRequest(publicOrigin, config).ok).toBe(true)

    const evil = validateMcpRequest(
      new Request(`${BASE}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example.com' } }),
      config,
    )
    expect(evil.ok).toBe(false)
    if (!evil.ok) {
      expect(evil.reason).toBe('invalid_origin')
      expect(evil.response.status).toBe(403)
    }
  })

  test("DNS rebinding: an Origin matching the request's OWN rebound host is still rejected", () => {
    // In a rebinding attack the browser sends Origin and Host with the same
    // hostname (evil.com → 127.0.0.1), so an allowlist derived from the
    // request URL would always admit it. The allowlist must come from config.
    const rebound = validateMcpRequest(
      new Request('http://evil.example.com/mcp', { method: 'POST', headers: { origin: 'http://evil.example.com' } }),
      config,
    )
    expect(rebound.ok).toBe(false)
  })

  test('every SDK-supported protocol version passes; unknown versions are a 400', async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const request = new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'mcp-protocol-version': version } })
      expect(validateMcpRequest(request, config).ok).toBe(true)
    }
    const bad = validateMcpRequest(
      new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'mcp-protocol-version': '1999-01-01' } }),
      config,
    )
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.reason).toBe('unsupported_protocol_version')
      expect(bad.response.status).toBe(400)
    }
  })
})

describe('createMcpMount', () => {
  test('missing/invalid credentials → 401 error envelope, no transport touched', async () => {
    const mount = buildMount({ good: READ_PRINCIPAL })
    const response = await mount.handler(rpc(INITIALIZE))
    expect(response.status).toBe(401)
    // Exact challenge contract: the full knowledge scope set from
    // scopes_supported (no offline_access — a mechanics scope, not a
    // permission), so MCP clients offer review/approve on consent too.
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://wikikit.example.dev/.well-known/oauth-protected-resource", ' +
        'scope="knowledge:read knowledge:propose knowledge:review knowledge:approve"',
    )
    const envelope = (await response.json()) as Record<string, unknown>
    expect(envelope.code).toBe('unauthorized')
    expect(typeof envelope.request_id).toBe('string')
    expect(mount.sessions.sessions.size).toBe(0)
    mount.stop()
  })

  test('initialize opens a session; tools/list is scope-filtered per key', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL, proposer: PROPOSE_PRINCIPAL })

    const readSession = await initialize(mount, 'reader')
    const readList = await mount.handler(
      rpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { authorization: 'Bearer reader', 'mcp-session-id': readSession },
      ),
    )
    const readTools = (await readMcpJson<{ result: { tools: { name: string }[] } }>(readList)).result.tools
    expect(readTools.map((tool) => tool.name)).toEqual([
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
    ])

    const proposeSession = await initialize(mount, 'proposer')
    const proposeList = await mount.handler(
      rpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { authorization: 'Bearer proposer', 'mcp-session-id': proposeSession },
      ),
    )
    const proposeTools = (await readMcpJson<{ result: { tools: { name: string }[] } }>(proposeList)).result.tools
    expect(proposeTools.map((tool) => tool.name)).toEqual([
      'wikikit_ingest',
      'wikikit_ingest_status',
      'wikikit_propose',
    ])
    expect(mount.sessions.sessions.size).toBe(2)
    mount.stop()
  })

  // A pure-MCP client cannot reach GET /llms.txt, so initialize + resources are
  // the ONLY channel through which it learns how this server works.
  test('initialize advertises resources and returns usage instructions', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL })
    const response = await mount.handler(rpc(INITIALIZE, { authorization: 'Bearer reader' }))
    const result = (
      (await readMcpJson(response)) as {
        result: { capabilities: Record<string, unknown>; instructions?: string }
      }
    ).result

    expect(result.capabilities.resources).toBeDefined()
    // The load-bearing half of the contract: the agent cannot own the review decision.
    expect(result.instructions).toContain('wikikit_search')
    expect(result.instructions).toContain('wikikit_review_proposal')
    expect(result.instructions).toContain('the agent must never supply, infer, or relay the decision')
    expect(result.instructions).toContain('url_review_started')
    expect(result.instructions).toContain('human_review_required')
    expect(result.instructions).toContain('leaves the proposal pending')
    mount.stop()
  })

  test('resources/list and resources/read serve the embedded docs', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL })
    const session = await initialize(mount, 'reader')
    const headers = { authorization: 'Bearer reader', 'mcp-session-id': session }

    const list = await mount.handler(rpc({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, headers))
    const resources = (await readMcpJson<{ result: { resources: { uri: string }[] } }>(list)).result.resources
    expect(resources.map((resource) => resource.uri)).toEqual([
      'wikikit://system/agent-guide',
      'wikikit://docs/llms.txt',
      'wikikit://docs/llms-full.txt',
    ])

    const read = await mount.handler(
      rpc({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'wikikit://docs/llms.txt' } }, headers),
    )
    const contents = (await readMcpJson<{ result: { contents: { text: string }[] } }>(read)).result.contents
    expect(contents[0]!.text).toContain('# WikiKit Documentation')

    const guide = await mount.handler(
      rpc(
        { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'wikikit://system/agent-guide' } },
        headers,
      ),
    )
    const guideContents = (await readMcpJson<{ result: { contents: { text: string }[] } }>(guide)).result.contents
    expect(guideContents[0]!.text).toContain('# WikiKit agent guide')
    mount.stop()
  })

  test('resources/read of an unknown uri errors instead of returning empty content', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL })
    const session = await initialize(mount, 'reader')
    const read = await mount.handler(
      rpc(
        { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'wikikit://docs/nope.txt' } },
        { authorization: 'Bearer reader', 'mcp-session-id': session },
      ),
    )
    const body = await readMcpJson<{ error?: { message: string }; result?: unknown }>(read)
    expect(body.result).toBeUndefined()
    expect(body.error?.message).toContain('unknown resource')
    mount.stop()
  })

  test('unknown session id → 404 with JSON-RPC -32001 (client re-initializes)', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL })
    const response = await mount.handler(
      rpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { authorization: 'Bearer reader', 'mcp-session-id': 'no-such-session' },
      ),
    )
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32001)
    mount.stop()
  })

  test('a DIFFERENT valid key on a known session id gets the SAME 404 (hijack guard)', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL, proposer: PROPOSE_PRINCIPAL })
    const sessionId = await initialize(mount, 'reader')

    const response = await mount.handler(
      rpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { authorization: 'Bearer proposer', 'mcp-session-id': sessionId },
      ),
    )
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32001) // indistinguishable from unknown-session
    // The owner's session is untouched and still usable.
    const owner = await mount.handler(
      rpc(
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        { authorization: 'Bearer reader', 'mcp-session-id': sessionId },
      ),
    )
    expect(owner.status).toBe(200)
    mount.stop()
  })

  test('calling a tool outside the key scope is indistinguishable from a nonexistent tool', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL })
    const sessionId = await initialize(mount, 'reader')

    async function callTool(name: string): Promise<Record<string, unknown>> {
      const response = await mount.handler(
        rpc(
          { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: { space: 'main' } } },
          { authorization: 'Bearer reader', 'mcp-session-id': sessionId },
        ),
      )
      const body = (await readMcpJson(response)) as {
        result: { isError: boolean; content: [{ text: string }] }
      }
      expect(body.result.isError).toBe(true)
      return JSON.parse(body.result.content[0].text) as Record<string, unknown>
    }

    const invisible = await callTool('wikikit_ingest') // exists, but not for this key
    const nonexistent = await callTool('wikikit_frobnicate')
    expect(invisible.code).toBe('not_found')
    expect(nonexistent.code).toBe('not_found')
    // No scope oracle: identical code and identical hint set.
    expect(invisible.next_best_actions).toEqual(nonexistent.next_best_actions)
    mount.stop()
  })

  test('invalid tool input → terminal bad_request envelope with next_best_actions', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL })
    const sessionId = await initialize(mount, 'reader')
    const response = await mount.handler(
      rpc(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'wikikit_search', arguments: { space: 'main' } }, // q missing
        },
        { authorization: 'Bearer reader', 'mcp-session-id': sessionId },
      ),
    )
    const body = await readMcpJson<{ result: { isError: boolean; content: [{ text: string }] } }>(response)
    expect(body.result.isError).toBe(true)
    const envelope = JSON.parse(body.result.content[0].text) as Record<string, unknown>
    expect(envelope.code).toBe('bad_request')
    expect((envelope.next_best_actions as string[]).length).toBeGreaterThan(0)
    expect(typeof envelope.request_id).toBe('string')
    mount.stop()
  })

  test('DELETE closes the session and drops the lease', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL })
    const sessionId = await initialize(mount, 'reader')
    expect(mount.sessions.sessions.size).toBe(1)
    const response = await mount.handler(
      new Request(`${BASE}/mcp`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer reader', 'mcp-session-id': sessionId },
      }),
    )
    expect(response.status).toBe(200)
    expect(mount.sessions.sessions.size).toBe(0)
    mount.stop()
  })

  test('stop() closes every live session (graceful shutdown)', async () => {
    const mount = buildMount({ reader: READ_PRINCIPAL })
    await initialize(mount, 'reader')
    await initialize(mount, 'reader')
    expect(mount.sessions.sessions.size).toBe(2)
    mount.stop()
    expect(mount.sessions.sessions.size).toBe(0)
  })
})

describe('toNodeRawHandler (the app.mountRawHandler bridge)', () => {
  test('drives the full initialize → tools/list loop over a real node:http socket', async () => {
    const { createServer } = await import('node:http')
    const mount = buildMount({ reader: READ_PRINCIPAL })
    const raw = toNodeRawHandler(mount)
    const server = createServer((req, res) => void raw(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}`

    try {
      const init = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer reader',
        },
        body: JSON.stringify(INITIALIZE),
      })
      expect(init.status).toBe(200)
      const sessionId = init.headers.get('mcp-session-id')
      expect(sessionId).toBeTruthy()
      const initBody = await readMcpJson<{ result: { serverInfo: { name: string } } }>(init)
      expect(initBody.result.serverInfo.name).toBe('wikikit')

      const list = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer reader',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
      expect(list.status).toBe(200)
      const tools = (await readMcpJson<{ result: { tools: { name: string }[] } }>(list)).result.tools
      expect(tools).toHaveLength(10) // knowledge:read palette, including built-in system guidance
    } finally {
      mount.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('bodies past the byte cap answer the §8 413 body_too_large envelope before the SDK sees them', async () => {
    const { createServer } = await import('node:http')
    const mount = buildMount({ reader: READ_PRINCIPAL })
    // Tiny cap so the oversized POST is cheap to build; the default mirrors
    // WIKIKIT_MAX_BODY_BYTES.
    const raw = toNodeRawHandler(mount, { maxBodyBytes: 1024 })
    const server = createServer((req, res) => void raw(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }

    try {
      const oversized = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer reader',
        },
        body: JSON.stringify({ ...INITIALIZE, params: { ...INITIALIZE.params, padding: 'x'.repeat(4096) } }),
      })
      expect(oversized.status).toBe(413)
      const envelope = (await oversized.json()) as Record<string, unknown>
      expect(envelope.code).toBe('body_too_large')
      expect(typeof envelope.request_id).toBe('string')
      expect(mount.sessions.sessions.size).toBe(0) // nothing reached the transport

      // A normal-sized request on the same handler still works.
      const ok = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer reader',
        },
        body: JSON.stringify(INITIALIZE),
      })
      expect(ok.status).toBe(200)
    } finally {
      mount.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
